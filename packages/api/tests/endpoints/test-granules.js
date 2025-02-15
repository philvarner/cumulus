'use strict';

const fs = require('fs');
const request = require('supertest');
const path = require('path');
const sinon = require('sinon');
const test = require('ava');
const omit = require('lodash/omit');
const cryptoRandomString = require('crypto-random-string');
const {
  CollectionPgModel,
  ExecutionPgModel,
  FilePgModel,
  GranulePgModel,
  GranulesExecutionsPgModel,
  destroyLocalTestDb,
  generateLocalTestDb,
  localStackConnectionEnv,
  migrationDir,
  translateApiExecutionToPostgresExecution,
  translateApiFiletoPostgresFile,
  translateApiGranuleToPostgresGranule,
} = require('@cumulus/db');

const {
  buildS3Uri,
  createBucket,
  createS3Buckets,
  deleteS3Buckets,
  recursivelyDeleteS3Bucket,
  s3ObjectExists,
  s3PutObject,
} = require('@cumulus/aws-client/S3');

const {
  secretsManager,
  sfn,
  s3,
} = require('@cumulus/aws-client/services');
const { CMR } = require('@cumulus/cmr-client');
const {
  metadataObjectFromCMRFile,
} = require('@cumulus/cmrjs/cmr-utils');
const { bootstrapElasticSearch } = require('@cumulus/es-client/bootstrap');
const indexer = require('@cumulus/es-client/indexer');
const { Search } = require('@cumulus/es-client/search');
const launchpad = require('@cumulus/launchpad-auth');
const { randomString, randomId } = require('@cumulus/common/test-utils');
const { getBucketsConfigKey } = require('@cumulus/common/stack');
const { getDistributionBucketMapKey } = require('@cumulus/distribution-utils');
const { constructCollectionId } = require('@cumulus/message/Collections');

// Postgres mock data factories
const {
  fakeCollectionRecordFactory,
  fakeGranuleRecordFactory,
} = require('@cumulus/db/dist/test-utils');

const assertions = require('../../lib/assertions');
const models = require('../../models');

const { createGranuleAndFiles } = require('../../lib/create-test-data');

// Dynamo mock data factories
const {
  createFakeJwtAuthToken,
  fakeAccessTokenFactory,
  fakeCollectionFactory,
  fakeGranuleFactoryV2,
  setAuthorizedOAuthUsers,
  fakeExecutionFactoryV2,
} = require('../../lib/testUtils');

const {
  createJwtToken,
} = require('../../lib/token');

const {
  generateMoveGranuleTestFilesAndEntries,
  getPostgresFilesInOrder,
} = require('./granules/helpers');

const testDbName = `granules_${cryptoRandomString({ length: 10 })}`;

let accessTokenModel;
let collectionModel;
let esClient;
let esIndex;
let executionModel;
let executionPgModel;
let filePgModel;
let granuleModel;
let granulePgModel;
let granulesExecutionsPgModel;
let jwtAuthToken;

process.env.AccessTokensTable = randomId('token');
process.env.AsyncOperationsTable = randomId('async');
process.env.ExecutionsTable = randomId('executions');
process.env.CollectionsTable = randomId('collection');
process.env.GranulesTable = randomId('granules');
process.env.stackName = randomId('stackname');
process.env.system_bucket = randomId('systembucket');
process.env.TOKEN_SECRET = randomId('secret');
process.env.backgroundQueueUrl = randomId('backgroundQueueUrl');

// import the express app after setting the env variables
const { app } = require('../../app');

async function runTestUsingBuckets(buckets, testFunction) {
  try {
    await createS3Buckets(buckets);
    await testFunction();
  } finally {
    await Promise.all(buckets.map(recursivelyDeleteS3Bucket));
  }
}

/**
 * Helper for creating and uploading bucket configuration for 'move' tests.
 * @returns {Object} with keys of internalBucket, and publicBucket.
 */
async function setupBucketsConfig() {
  const systemBucket = process.env.system_bucket;
  const buckets = {
    protected: {
      name: systemBucket,
      type: 'protected',
    },
    public: {
      name: randomId('public'),
      type: 'public',
    },
  };

  process.env.DISTRIBUTION_ENDPOINT = 'http://example.com/';
  await s3PutObject({
    Bucket: systemBucket,
    Key: getBucketsConfigKey(process.env.stackName),
    Body: JSON.stringify(buckets),
  });
  await createBucket(buckets.public.name);
  // Create the required bucket map configuration file
  await s3PutObject({
    Bucket: systemBucket,
    Key: getDistributionBucketMapKey(process.env.stackName),
    Body: JSON.stringify({
      [systemBucket]: systemBucket,
      [buckets.public.name]: buckets.public.name,
    }),
  });
  return { internalBucket: systemBucket, publicBucket: buckets.public.name };
}

test.before(async (t) => {
  process.env.CMR_ENVIRONMENT = 'SIT';
  process.env = {
    ...process.env,
    ...localStackConnectionEnv,
    PG_DATABASE: testDbName,
  };
  esIndex = randomId('esindex');
  t.context.esAlias = randomId('esAlias');
  process.env.ES_INDEX = t.context.esAlias;

  // create esClient
  esClient = await Search.es('fakehost');

  // add fake elasticsearch index
  await bootstrapElasticSearch('fakehost', esIndex, t.context.esAlias);

  // create a fake bucket
  await createBucket(process.env.system_bucket);

  // create a workflow template file
  const tKey = `${process.env.stackName}/workflow_template.json`;
  await s3PutObject({ Bucket: process.env.system_bucket, Key: tKey, Body: '{}' });

  // create fake Collections table
  collectionModel = new models.Collection();
  await collectionModel.createTable();

  // create fake execution table
  executionModel = new models.Execution();
  await executionModel.createTable();
  executionPgModel = new ExecutionPgModel();

  // create fake Granules table
  granuleModel = new models.Granule();
  await granuleModel.createTable();

  granulePgModel = new GranulePgModel();
  filePgModel = new FilePgModel();
  granulesExecutionsPgModel = new GranulesExecutionsPgModel();

  const username = randomString();
  await setAuthorizedOAuthUsers([username]);

  accessTokenModel = new models.AccessToken();
  await accessTokenModel.createTable();

  jwtAuthToken = await createFakeJwtAuthToken({ accessTokenModel, username });

  // Store the CMR password
  process.env.cmr_password_secret_name = randomString();
  await secretsManager().createSecret({
    Name: process.env.cmr_password_secret_name,
    SecretString: randomString(),
  }).promise();

  // Store the Launchpad passphrase
  process.env.launchpad_passphrase_secret_name = randomString();
  await secretsManager().createSecret({
    Name: process.env.launchpad_passphrase_secret_name,
    SecretString: randomString(),
  }).promise();

  // Generate a local test postGres database

  const { knex, knexAdmin } = await generateLocalTestDb(testDbName, migrationDir);
  t.context.knex = knex;
  t.context.knexAdmin = knexAdmin;

  // Create collections in Dynamo and Postgres
  // we need this because a granule has a foreign key referring to collections
  const collectionName = 'fakeCollection';
  const collectionVersion = 'v1';

  t.context.testCollection = fakeCollectionFactory({
    name: collectionName,
    version: collectionVersion,
    duplicateHandling: 'error',
  });
  const dynamoCollection = await collectionModel.create(t.context.testCollection);
  t.context.collectionId = constructCollectionId(
    dynamoCollection.name,
    dynamoCollection.version
  );

  const testPgCollection = fakeCollectionRecordFactory({
    name: collectionName,
    version: collectionVersion,
  });
  const collectionPgModel = new CollectionPgModel();
  [t.context.collectionCumulusId] = await collectionPgModel.create(
    t.context.knex,
    testPgCollection
  );

  const newExecution = fakeExecutionFactoryV2({
    arn: 'arn3',
    status: 'completed',
    name: 'test_execution',
    parentArn: undefined,
  });

  await executionModel.create(newExecution);
  const executionPgRecord = await translateApiExecutionToPostgresExecution(
    newExecution,
    knex
  );
  await executionPgModel.create(knex, executionPgRecord);
  t.context.executionUrl = executionPgRecord.url;
  t.context.executionArn = executionPgRecord.arn;
});

test.beforeEach(async (t) => {
  const { esAlias } = t.context;

  const granuleId1 = cryptoRandomString({ length: 6 });
  const granuleId2 = cryptoRandomString({ length: 6 });
  const granuleId3 = cryptoRandomString({ length: 6 });

  // create fake Dynamo granule records
  t.context.fakeGranules = [
    fakeGranuleFactoryV2({ granuleId: granuleId1, status: 'completed', execution: t.context.executionUrl }),
    fakeGranuleFactoryV2({ granuleId: granuleId2, status: 'failed' }),
    fakeGranuleFactoryV2({ granuleId: granuleId3, status: 'running', execution: t.context.executionUrl }),
  ];

  await Promise.all(t.context.fakeGranules.map((granule) =>
    granuleModel.create(granule)
      .then((record) => indexer.indexGranule(esClient, record, esAlias))));

  // create fake Postgres granule records
  t.context.fakePGGranules = [
    fakeGranuleRecordFactory(
      {
        granule_id: granuleId1,
        status: 'completed',
        collection_cumulus_id: t.context.collectionCumulusId,
      }
    ),
    fakeGranuleRecordFactory(
      {
        granule_id: granuleId2,
        status: 'failed',
        collection_cumulus_id: t.context.collectionCumulusId,
      }
    ),
    fakeGranuleRecordFactory(
      {
        granule_id: granuleId3,
        status: 'running',
        collection_cumulus_id: t.context.collectionCumulusId,
      }
    ),
  ];

  await Promise.all(t.context.fakePGGranules.map((granule) =>
    granulePgModel.create(t.context.knex, granule)));
});

test.after.always(async (t) => {
  await collectionModel.deleteTable();
  await granuleModel.deleteTable();
  await executionModel.deleteTable();
  await accessTokenModel.deleteTable();
  await esClient.indices.delete({ index: esIndex });
  await recursivelyDeleteS3Bucket(process.env.system_bucket);
  await secretsManager().deleteSecret({
    SecretId: process.env.cmr_password_secret_name,
    ForceDeleteWithoutRecovery: true,
  }).promise();
  await secretsManager().deleteSecret({
    SecretId: process.env.launchpad_passphrase_secret_name,
    ForceDeleteWithoutRecovery: true,
  }).promise();

  await destroyLocalTestDb({
    knex: t.context.knex,
    knexAdmin: t.context.knexAdmin,
    testDbName,
  });
});

test.serial('default returns list of granules', async (t) => {
  const response = await request(app)
    .get('/granules')
    .set('Accept', 'application/json')
    .set('Authorization', `Bearer ${jwtAuthToken}`)
    .expect(200);

  const { meta, results } = response.body;
  t.is(results.length, 3);
  t.is(meta.stack, process.env.stackName);
  t.is(meta.table, 'granule');
  t.is(meta.count, 3);
  const granuleIds = t.context.fakeGranules.map((i) => i.granuleId);
  results.forEach((r) => {
    t.true(granuleIds.includes(r.granuleId));
  });
});

test.serial('CUMULUS-911 GET without pathParameters and without an Authorization header returns an Authorization Missing response', async (t) => {
  const response = await request(app)
    .get('/granules')
    .set('Accept', 'application/json')
    .expect(401);

  assertions.isAuthorizationMissingResponse(t, response);
});

test.serial('CUMULUS-911 GET with pathParameters.granuleName set and without an Authorization header returns an Authorization Missing response', async (t) => {
  const response = await request(app)
    .get('/granules/asdf')
    .set('Accept', 'application/json')
    .expect(401);

  assertions.isAuthorizationMissingResponse(t, response);
});

test.serial('CUMULUS-911 PUT with pathParameters.granuleName set and without an Authorization header returns an Authorization Missing response', async (t) => {
  const response = await request(app)
    .put('/granules/asdf')
    .set('Accept', 'application/json')
    .expect(401);

  assertions.isAuthorizationMissingResponse(t, response);
});

test.serial('CUMULUS-911 DELETE with pathParameters.granuleName set and without an Authorization header returns an Authorization Missing response', async (t) => {
  const response = await request(app)
    .delete('/granules/asdf')
    .set('Accept', 'application/json')
    .expect(401);

  assertions.isAuthorizationMissingResponse(t, response);
});

test.serial('CUMULUS-912 GET without pathParameters and with an invalid access token returns an unauthorized response', async (t) => {
  const response = await request(app)
    .get('/granules/asdf')
    .set('Accept', 'application/json')
    .set('Authorization', 'Bearer ThisIsAnInvalidAuthorizationToken')
    .expect(401);

  assertions.isInvalidAccessTokenResponse(t, response);
});

test.serial('CUMULUS-912 GET without pathParameters and with an unauthorized user returns an unauthorized response', async (t) => {
  const accessTokenRecord = fakeAccessTokenFactory();
  await accessTokenModel.create(accessTokenRecord);
  const jwtToken = createJwtToken(accessTokenRecord);

  const response = await request(app)
    .get('/granules')
    .set('Accept', 'application/json')
    .set('Authorization', `Bearer ${jwtToken}`)
    .expect(401);

  assertions.isUnauthorizedUserResponse(t, response);
});

test.serial('CUMULUS-912 GET with pathParameters.granuleName set and with an invalid access token returns an unauthorized response', async (t) => {
  const response = await request(app)
    .get('/granules/asdf')
    .set('Accept', 'application/json')
    .set('Authorization', 'Bearer ThisIsAnInvalidAuthorizationToken')
    .expect(401);

  assertions.isInvalidAccessTokenResponse(t, response);
});

test.todo('CUMULUS-912 GET with pathParameters.granuleName set and with an unauthorized user returns an unauthorized response');

test.serial('CUMULUS-912 PUT with pathParameters.granuleName set and with an invalid access token returns an unauthorized response', async (t) => {
  const response = await request(app)
    .put('/granules/asdf')
    .set('Accept', 'application/json')
    .set('Authorization', 'Bearer ThisIsAnInvalidAuthorizationToken')
    .expect(401);

  assertions.isInvalidAccessTokenResponse(t, response);
});

test.todo('CUMULUS-912 PUT with pathParameters.granuleName set and with an unauthorized user returns an unauthorized response');

test.serial('CUMULUS-912 DELETE with pathParameters.granuleName set and with an unauthorized user returns an unauthorized response', async (t) => {
  const accessTokenRecord = fakeAccessTokenFactory();
  await accessTokenModel.create(accessTokenRecord);
  const jwtToken = createJwtToken(accessTokenRecord);

  const response = await request(app)
    .delete('/granules/adsf')
    .set('Accept', 'application/json')
    .set('Authorization', `Bearer ${jwtToken}`)
    .expect(401);

  assertions.isUnauthorizedUserResponse(t, response);
});

test.serial('GET returns an existing granule', async (t) => {
  const response = await request(app)
    .get(`/granules/${t.context.fakeGranules[0].granuleId}`)
    .set('Accept', 'application/json')
    .set('Authorization', `Bearer ${jwtAuthToken}`)
    .expect(200);

  const { granuleId } = response.body;
  t.is(granuleId, t.context.fakeGranules[0].granuleId);
});

test.serial('GET returns a 404 response if the granule is not found', async (t) => {
  const response = await request(app)
    .get('/granules/unknownGranule')
    .set('Accept', 'application/json')
    .set('Authorization', `Bearer ${jwtAuthToken}`)
    .expect(404);

  t.is(response.status, 404);
  const { message } = response.body;
  t.is(message, 'Granule not found');
});

test.serial('PUT fails if action is not supported', async (t) => {
  const response = await request(app)
    .put(`/granules/${t.context.fakeGranules[0].granuleId}`)
    .set('Accept', 'application/json')
    .set('Authorization', `Bearer ${jwtAuthToken}`)
    .send({ action: 'someUnsupportedAction' })
    .expect(400);

  t.is(response.status, 400);
  const { message } = response.body;
  t.true(message.includes('Action is not supported'));
});

test.serial('PUT without a body, fails to update granule.', async (t) => {
  const response = await request(app)
    .put(`/granules/${t.context.fakeGranules[0].granuleId}`)
    .set('Accept', 'application/json')
    .set('Authorization', `Bearer ${jwtAuthToken}`)
    .expect(400);

  t.is(response.status, 400);
  const { message } = response.body;
  t.is(message, `input :granuleName (${t.context.fakeGranules[0].granuleId}) must match body's granuleId (undefined)`);
});

// This needs to be serial because it is stubbing aws.sfn's responses
test.serial('reingest a granule', async (t) => {
  const fakeDescribeExecutionResult = {
    input: JSON.stringify({
      meta: {
        workflow_name: 'IngestGranule',
      },
      payload: {},
    }),
  };

  // fake workflow
  const message = JSON.parse(fakeDescribeExecutionResult.input);
  const wKey = `${process.env.stackName}/workflows/${message.meta.workflow_name}.json`;
  await s3PutObject({ Bucket: process.env.system_bucket, Key: wKey, Body: '{}' });

  const stub = sinon.stub(sfn(), 'describeExecution').returns({
    promise: () => Promise.resolve(fakeDescribeExecutionResult),
  });

  const granuleId = t.context.fakeGranules[0].granuleId;
  const response = await request(app)
    .put(`/granules/${granuleId}`)
    .set('Accept', 'application/json')
    .set('Authorization', `Bearer ${jwtAuthToken}`)
    .send({ action: 'reingest' })
    .expect(200);

  const body = response.body;
  t.is(body.status, 'SUCCESS');
  t.is(body.action, 'reingest');
  t.true(body.warning.includes('overwritten'));

  const updatedGranule = await granuleModel.get({ granuleId });
  const updatedPgGranule = await granulePgModel.get(
    t.context.knex,
    { granule_id: granuleId, collection_cumulus_id: t.context.collectionCumulusId }
  );
  t.is(updatedGranule.status, 'queued');
  t.is(updatedPgGranule.status, 'queued');
  stub.restore();
});

test.serial('put request with reingest action calls the granuleModel.reingest function with expected parameters', async (t) => {
  const granuleReingestStub = sinon.stub(models.Granule.prototype, 'reingest').returns(
    new Promise((resolve) => resolve({ response: 'fakeResponse' }))
  );

  await request(app)
    .put(`/granules/${t.context.fakeGranules[0].granuleId}`)
    .set('Accept', 'application/json')
    .set('Authorization', `Bearer ${jwtAuthToken}`)
    .send({ action: 'reingest' })
    .expect(200);

  t.is(granuleReingestStub.calledOnce, true);

  const reingestArgs = granuleReingestStub.args[0];
  const { queueUrl } = reingestArgs[0];
  t.is(queueUrl, process.env.backgroundQueueUrl);

  granuleReingestStub.restore();
});

// This needs to be serial because it is stubbing aws.sfn's responses
test.serial('apply an in-place workflow to an existing granule', async (t) => {
  const fakeSFResponse = {
    execution: {
      input: JSON.stringify({
        meta: {
          workflow_name: 'inPlaceWorkflow',
        },
        payload: {},
      }),
    },
  };

  //fake in-place workflow
  const message = JSON.parse(fakeSFResponse.execution.input);
  const wKey = `${process.env.stackName}/workflows/${message.meta.workflow_name}.json`;
  await s3PutObject({ Bucket: process.env.system_bucket, Key: wKey, Body: '{}' });

  const fakeDescribeExecutionResult = {
    output: JSON.stringify({
      meta: {
        workflow_name: 'IngestGranule',
      },
      payload: {},
    }),
  };

  const stub = sinon.stub(sfn(), 'describeExecution').returns({
    promise: () => Promise.resolve(fakeDescribeExecutionResult),
  });

  const granuleId = t.context.fakeGranules[0].granuleId;
  const response = await request(app)
    .put(`/granules/${granuleId}`)
    .set('Accept', 'application/json')
    .set('Authorization', `Bearer ${jwtAuthToken}`)
    .send({
      action: 'applyWorkflow',
      workflow: 'inPlaceWorkflow',
      messageSource: 'output',
    })
    .expect(200);

  const body = response.body;
  t.is(body.status, 'SUCCESS');
  t.is(body.action, 'applyWorkflow inPlaceWorkflow');

  const updatedGranule = await granuleModel.get({ granuleId });
  const updatedPgGranule = await granulePgModel.get(
    t.context.knex,
    { granule_id: granuleId, collection_cumulus_id: t.context.collectionCumulusId }
  );
  t.is(updatedGranule.status, 'queued');
  t.is(updatedPgGranule.status, 'queued');
  stub.restore();
});

test.serial('remove a granule from CMR', async (t) => {
  const {
    s3Buckets,
    newDynamoGranule,
    newPgGranule: { collection_cumulus_id: collectionCumulusId },
  } = await createGranuleAndFiles({
    dbClient: t.context.knex,
    published: true,
  });

  const granuleId = newDynamoGranule.granuleId;

  sinon.stub(
    CMR.prototype,
    'deleteGranule'
  ).callsFake(() => Promise.resolve());

  sinon.stub(
    CMR.prototype,
    'getGranuleMetadata'
  ).callsFake(() => Promise.resolve({ title: granuleId }));

  try {
    const response = await request(app)
      .put(`/granules/${granuleId}`)
      .set('Accept', 'application/json')
      .set('Authorization', `Bearer ${jwtAuthToken}`)
      .send({ action: 'removeFromCmr' })
      .expect(200);

    const body = response.body;
    t.is(body.status, 'SUCCESS');
    t.is(body.action, 'removeFromCmr');

    // Should have updated the Dynamo granule
    const updatedDynamoGranule = await granuleModel.get({ granuleId });
    t.is(updatedDynamoGranule.published, false);
    t.is(updatedDynamoGranule.cmrLink, undefined);

    // Should have updated the Postgres granule
    const updatedPgGranule = await granulePgModel.get(
      t.context.knex,
      { granule_id: granuleId, collection_cumulus_id: collectionCumulusId }
    );
    t.is(updatedPgGranule.published, false);
    t.is(updatedPgGranule.cmrLink, undefined);
  } finally {
    CMR.prototype.deleteGranule.restore();
    CMR.prototype.getGranuleMetadata.restore();
  }

  t.teardown(() => deleteS3Buckets([
    s3Buckets.protected.name,
    s3Buckets.public.name,
  ]));
});

test.serial('remove a granule from CMR with launchpad authentication', async (t) => {
  process.env.cmr_oauth_provider = 'launchpad';
  const launchpadStub = sinon.stub(launchpad, 'getLaunchpadToken').callsFake(() => randomString());

  sinon.stub(
    CMR.prototype,
    'deleteGranule'
  ).callsFake(() => Promise.resolve());

  sinon.stub(
    CMR.prototype,
    'getGranuleMetadata'
  ).callsFake(() => Promise.resolve({ title: t.context.fakeGranules[0].granuleId }));

  try {
    const response = await request(app)
      .put(`/granules/${t.context.fakeGranules[0].granuleId}`)
      .set('Accept', 'application/json')
      .set('Authorization', `Bearer ${jwtAuthToken}`)
      .send({ action: 'removeFromCmr' })
      .expect(200);

    const body = response.body;
    t.is(body.status, 'SUCCESS');
    t.is(body.action, 'removeFromCmr');

    const updatedGranule = await granuleModel.get({
      granuleId: t.context.fakeGranules[0].granuleId,
    });
    t.is(updatedGranule.published, false);
    t.is(updatedGranule.cmrLink, undefined);

    t.is(launchpadStub.calledOnce, true);
  } finally {
    process.env.cmr_oauth_provider = 'earthdata';
    launchpadStub.restore();
    CMR.prototype.deleteGranule.restore();
    CMR.prototype.getGranuleMetadata.restore();
  }
});

test.serial('DELETE returns 404 if granule does not exist', async (t) => {
  const granuleId = randomString();
  const response = await request(app)
    .delete(`/granules/${granuleId}`)
    .set('Accept', 'application/json')
    .set('Authorization', `Bearer ${jwtAuthToken}`)
    .expect(404);
  t.true(response.body.message.includes('No record found'));
});

test.serial('DELETE deleting an existing granule that is published will fail and not delete records', async (t) => {
  const {
    s3Buckets,
    newDynamoGranule,
    newPgGranule: { collection_cumulus_id: collectionCumulusId },
  } = await createGranuleAndFiles({
    dbClient: t.context.knex,
    published: true,
  });

  const granuleId = newDynamoGranule.granuleId;

  const response = await request(app)
    .delete(`/granules/${granuleId}`)
    .set('Accept', 'application/json')
    .set('Authorization', `Bearer ${jwtAuthToken}`)
    .expect(400);

  t.is(response.status, 400);
  const { message } = response.body;
  t.is(
    message,
    'You cannot delete a granule that is published to CMR. Remove it from CMR first'
  );

  // granule should still exist in Dynamo and Postgres
  t.true(await granulePgModel.exists(
    t.context.knex,
    { granule_id: granuleId, collection_cumulus_id: collectionCumulusId }
  ));
  t.true(await granuleModel.exists({ granuleId }));

  // Verify files still exist in S3 and Postgres
  await Promise.all(
    newDynamoGranule.files.map(async (file) => {
      t.true(await s3ObjectExists({ Bucket: file.bucket, Key: file.key }));
      t.true(await filePgModel.exists(t.context.knex, { bucket: file.bucket, key: file.key }));
    })
  );

  t.teardown(() => deleteS3Buckets([
    s3Buckets.protected.name,
    s3Buckets.public.name,
  ]));
});

test.serial('DELETE deleting an existing unpublished granule', async (t) => {
  const {
    s3Buckets,
    newDynamoGranule,
    newPgGranule: { collection_cumulus_id: collectionCumulusId },
  } = await createGranuleAndFiles({
    dbClient: t.context.knex,
    published: false,
  });

  const response = await request(app)
    .delete(`/granules/${newDynamoGranule.granuleId}`)
    .set('Accept', 'application/json')
    .set('Authorization', `Bearer ${jwtAuthToken}`)
    .expect(200);

  t.is(response.status, 200);
  const { detail } = response.body;
  t.is(detail, 'Record deleted');

  const granuleId = newDynamoGranule.granuleId;

  // granule have been deleted from Postgres and Dynamo
  t.false(await granulePgModel.exists(
    t.context.knex,
    { granule_id: granuleId, collection_cumulus_id: collectionCumulusId }
  ));
  t.false(await granuleModel.exists({ granuleId }));

  // verify the files are deleted from S3 and Postgres
  await Promise.all(
    newDynamoGranule.files.map(async (file) => {
      t.false(await s3ObjectExists({ Bucket: file.bucket, Key: file.key }));
      t.false(await filePgModel.exists(t.context.knex, { bucket: file.bucket, key: file.key }));
    })
  );

  t.teardown(() => deleteS3Buckets([
    s3Buckets.protected.name,
    s3Buckets.public.name,
  ]));
});

test.serial('DELETE deleting a granule that exists in Dynamo but not Postgres', async (t) => {
  // Create a granule in Dynamo only
  const s3Buckets = {
    protected: {
      name: randomId('protected'),
      type: 'protected',
    },
    public: {
      name: randomId('public'),
      type: 'public',
    },
  };
  const granuleId = randomId('granule');
  const files = [
    {
      bucket: s3Buckets.protected.name,
      fileName: `${granuleId}.hdf`,
      key: `${randomString(5)}/${granuleId}.hdf`,
    },
    {
      bucket: s3Buckets.protected.name,
      fileName: `${granuleId}.cmr.xml`,
      key: `${randomString(5)}/${granuleId}.cmr.xml`,
    },
    {
      bucket: s3Buckets.public.name,
      fileName: `${granuleId}.jpg`,
      key: `${randomString(5)}/${granuleId}.jpg`,
    },
  ];

  const newGranule = fakeGranuleFactoryV2(
    {
      granuleId: granuleId,
      status: 'failed',
      published: false,
      files: files,
    }
  );

  await createS3Buckets([
    s3Buckets.protected.name,
    s3Buckets.public.name,
  ]);

  // Add files to S3
  await Promise.all(newGranule.files.map((file) => s3PutObject({
    Bucket: file.bucket,
    Key: file.key,
    Body: `test data ${randomString()}`,
  })));

  // create a new Dynamo granule
  await granuleModel.create(newGranule);

  const response = await request(app)
    .delete(`/granules/${newGranule.granuleId}`)
    .set('Accept', 'application/json')
    .set('Authorization', `Bearer ${jwtAuthToken}`)
    .expect(200);

  t.is(response.status, 200);
  const { detail } = response.body;
  t.is(detail, 'Record deleted');

  // granule have been deleted from Dynamo
  t.false(await granuleModel.exists({ granuleId }));

  // Verify files were removed from S3
  await Promise.all(
    newGranule.files.map(async (file) => {
      t.false(await s3ObjectExists({ Bucket: file.bucket, Key: file.key }));
    })
  );

  t.teardown(() => deleteS3Buckets([
    s3Buckets.protected.name,
    s3Buckets.public.name,
  ]));
});

test.serial('DELETE throws an error if the Postgres get query fails', async (t) => {
  const {
    s3Buckets,
    newDynamoGranule,
    newPgGranule: { collection_cumulus_id: collectionCumulusId },
  } = await createGranuleAndFiles({
    dbClient: t.context.knex,
    published: false,
  });

  sinon
    .stub(GranulePgModel.prototype, 'get')
    .throws(new Error('Error message'));

  try {
    const response = await request(app)
      .delete(`/granules/${newDynamoGranule.granuleId}`)
      .set('Accept', 'application/json')
      .set('Authorization', `Bearer ${jwtAuthToken}`);
    t.is(response.status, 400);
  } finally {
    GranulePgModel.prototype.get.restore();
  }

  const granuleId = newDynamoGranule.granuleId;

  // granule not have been deleted from Postgres or Dynamo
  t.true(await granulePgModel.exists(
    t.context.knex,
    { granule_id: granuleId, collection_cumulus_id: collectionCumulusId }
  ));
  t.true(await granuleModel.exists({ granuleId }));

  // verify the files still exist in S3 and Postgres
  await Promise.all(
    newDynamoGranule.files.map(async (file) => {
      t.true(await s3ObjectExists({ Bucket: file.bucket, Key: file.key }));
      t.true(await filePgModel.exists(t.context.knex, { bucket: file.bucket, key: file.key }));
    })
  );

  t.teardown(() => deleteS3Buckets([
    s3Buckets.protected.name,
    s3Buckets.public.name,
  ]));
});

test.serial('move a granule with no .cmr.xml file', async (t) => {
  const bucket = process.env.system_bucket;
  const secondBucket = randomId('second');
  const thirdBucket = randomId('third');

  await runTestUsingBuckets(
    [secondBucket, thirdBucket],
    async () => {
      // Generate Granule/Files, S3 objects and database entries
      const granuleFileName = randomId('granuleFileName');
      const {
        newGranule,
        postgresGranuleCumulusId,
      } = await generateMoveGranuleTestFilesAndEntries({
        t,
        bucket,
        secondBucket,
        granulePgModel,
        filePgModel,
        granuleModel,
        granuleFileName,
      });

      const destinationFilepath = `${process.env.stackName}/granules_moved`;
      const destinations = [
        {
          regex: '.*.txt$',
          bucket,
          filepath: destinationFilepath,
        },
        {
          regex: '.*.md$',
          bucket: thirdBucket,
          filepath: destinationFilepath,
        },
        {
          regex: '.*.jpg$',
          bucket,
          filepath: destinationFilepath,
        },
      ];

      const response = await request(app)
        .put(`/granules/${newGranule.granuleId}`)
        .set('Accept', 'application/json')
        .set('Authorization', `Bearer ${jwtAuthToken}`)
        .send({
          action: 'move',
          destinations,
        })
        .expect(200);

      const body = response.body;
      t.is(body.status, 'SUCCESS');
      t.is(body.action, 'move');

      // Validate S3 Objects are where they should be
      const bucketObjects = await s3().listObjects({
        Bucket: bucket,
        Prefix: destinationFilepath,
      }).promise();

      t.is(bucketObjects.Contents.length, 2);
      bucketObjects.Contents.forEach((item) => {
        t.is(item.Key.indexOf(`${destinationFilepath}/${granuleFileName}`), 0);
      });

      const thirdBucketObjects = await s3().listObjects({
        Bucket: thirdBucket,
        Prefix: destinationFilepath,
      }).promise();

      t.is(thirdBucketObjects.Contents.length, 1);
      t.is(thirdBucketObjects.Contents[0].Key, `${destinationFilepath}/${granuleFileName}.md`);

      // check the granule in dynamoDb is updated and files are replaced
      const updatedGranule = await granuleModel.get({ granuleId: newGranule.granuleId });

      updatedGranule.files.forEach((file) => {
        t.true(file.key.startsWith(`${destinationFilepath}/${granuleFileName}`));
        const destination = destinations.find((dest) => file.fileName.match(dest.regex));
        t.is(destination.bucket, file.bucket);
      });

      // check the granule in postgres is updated
      const pgFiles = await getPostgresFilesInOrder(
        t.context.knex,
        newGranule,
        filePgModel,
        postgresGranuleCumulusId
      );

      t.is(pgFiles.length, 3);

      for (let i = 0; i < pgFiles.length; i += 1) {
        const destination = destinations.find((dest) => pgFiles[i].file_name.match(dest.regex));
        t.is(destination.bucket, pgFiles[i].bucket);
        t.like(pgFiles[i], {
          ...omit(newGranule.files[i], ['fileName', 'size']),
          key: `${destinationFilepath}/${newGranule.files[i].fileName}`,
          bucket: destination.bucket,
          file_name: newGranule.files[i].fileName,
        });
      }
    }
  );
});

test.serial('When a move granule request fails to move a file correctly, it records the expected granule files in postgres and dynamo', async (t) => {
  const bucket = process.env.system_bucket;
  const secondBucket = randomId('second');
  const thirdBucket = randomId('third');
  const fakeBucket = 'TotallyNotARealBucket';

  await runTestUsingBuckets(
    [secondBucket, thirdBucket],
    async () => {
      // Generate Granule/Files, S3 objects and database entries
      const granuleFileName = randomId('granuleFileName');
      const {
        newGranule,
        postgresGranuleCumulusId,
      } = await generateMoveGranuleTestFilesAndEntries({
        t,
        bucket,
        secondBucket,
        granulePgModel,
        filePgModel,
        granuleModel,
        granuleFileName,
      });

      // Create 'destination' objects
      const destinationFilepath = `${process.env.stackName}/granules_fail_1`;
      const destinations = [
        {
          regex: '.*.txt$',
          bucket,
          filepath: destinationFilepath,
        },
        {
          regex: '.*.md$',
          bucket: thirdBucket,
          filepath: destinationFilepath,
        },
        {
          regex: '.*.jpg$',
          bucket: fakeBucket,
          filepath: destinationFilepath,
        },
      ];

      const response = await request(app)
        .put(`/granules/${newGranule.granuleId}`)
        .set('Accept', 'application/json')
        .set('Authorization', `Bearer ${jwtAuthToken}`)
        .send({
          action: 'move',
          destinations,
        })
        .expect(400);

      const message = JSON.parse(response.body.message);

      t.is(message.reason, 'Failed to move granule');
      t.deepEqual(message.granule, newGranule);
      t.is(message.errors.length, 1);
      t.is(message.errors[0].code, 'NoSuchBucket');

      const actualGranuleFileRecord = message.granuleFilesRecords.sort(
        (a, b) => (a.key < b.key ? -1 : 1)
      );
      const expectedGranuleFileRecord = [
        {
          bucket: thirdBucket,
          key: `${destinationFilepath}/${granuleFileName}.md`,
          fileName: `${granuleFileName}.md`,
        },
        {
          bucket,
          key: `${destinationFilepath}/${granuleFileName}.txt`,
          fileName: `${granuleFileName}.txt`,
        },
        newGranule.files[2],
      ];
      t.deepEqual(expectedGranuleFileRecord, actualGranuleFileRecord);

      // Validate S3 Objects are where they should be
      const bucketObjects = await s3().listObjects({
        Bucket: bucket,
        Prefix: destinationFilepath,
      }).promise();
      t.is(bucketObjects.Contents.length, 1);
      t.is(bucketObjects.Contents[0].Key, `${destinationFilepath}/${granuleFileName}.txt`);

      const failedBucketObjects = await s3().listObjects({
        Bucket: secondBucket,
        Prefix: `${process.env.stackName}/original_filepath`,
      }).promise();
      t.is(failedBucketObjects.Contents.length, 1);
      t.is(failedBucketObjects.Contents[0].Key,
        (`${process.env.stackName}/original_filepath/${granuleFileName}.jpg`));

      const thirdBucketObjects = await s3().listObjects({
        Bucket: thirdBucket,
        Prefix: destinationFilepath,
      }).promise();
      t.is(thirdBucketObjects.Contents.length, 1);
      t.is(thirdBucketObjects.Contents[0].Key, `${destinationFilepath}/${granuleFileName}.md`);

      // check the granule in dynamoDb is updated and files are replaced
      const updatedGranule = await granuleModel.get({ granuleId: newGranule.granuleId });
      const updatedFiles = updatedGranule.files;

      t.true(updatedFiles[0].key.startsWith(`${destinationFilepath}/${granuleFileName}`));
      t.like(newGranule.files[0], omit(updatedFiles[0], ['fileName', 'key', 'bucket']));
      t.is(updatedFiles[0].bucket, destinations.find(
        (dest) => updatedFiles[0].fileName.match(dest.regex)
      ).bucket);

      t.true(
        updatedFiles[1].key.startsWith(`${destinationFilepath}/${granuleFileName}`),
        `updatedFile[1] ${updatedFiles[1].key}, did not start with ${destinationFilepath}/${granuleFileName}`
      );
      t.like(newGranule.files[1], omit(updatedFiles[1], ['fileName', 'key', 'bucket']));
      t.is(updatedFiles[1].bucket, destinations.find(
        (dest) => updatedFiles[1].fileName.match(dest.regex)
      ).bucket);

      t.deepEqual(newGranule.files[2], updatedFiles[2]);

      // Check that the postgres granules are in the correct state
      const pgFiles = await getPostgresFilesInOrder(
        t.context.knex,
        newGranule,
        filePgModel,
        postgresGranuleCumulusId
      );

      // The .jpg at index 2 should fail and have the original object values as
      // it's assigned `fakeBucket`
      for (let i = 0; i < 2; i += 1) {
        const destination = destinations.find((dest) => pgFiles[i].file_name.match(dest.regex));
        t.is(destination.bucket, pgFiles[i].bucket);
        t.like(pgFiles[i], {
          ...omit(newGranule.files[i], ['fileName', 'size']),
          key: `${destinationFilepath}/${newGranule.files[i].fileName}`,
          bucket: destination.bucket,
          file_name: newGranule.files[i].fileName,
        });
      }
      t.like(pgFiles[2], {
        ...omit(newGranule.files[2], ['fileName', 'size']),
        file_name: newGranule.files[2].fileName,
      });
    }
  );
});

test('When a move granules request attempts to move a granule that is not migrated to postgres, it correctly updates only dynamoDb', async (t) => {
  const bucket = process.env.system_bucket;
  const secondBucket = randomId('second');
  const thirdBucket = randomId('third');
  await runTestUsingBuckets(
    [secondBucket, thirdBucket],
    async () => {
      const granuleFileName = randomId('granuleFileName');
      const {
        newGranule,
      } = await generateMoveGranuleTestFilesAndEntries({
        t,
        bucket,
        secondBucket,
        granulePgModel,
        filePgModel,
        granuleModel,
        granuleFileName,
        createPostgresEntries: false,
      });

      const destinationFilepath = `${process.env.stackName}/unmigrated_granules_moved`;
      const destinations = [
        {
          regex: '.*.txt$',
          bucket,
          filepath: destinationFilepath,
        },
        {
          regex: '.*.md$',
          bucket: thirdBucket,
          filepath: destinationFilepath,
        },
        {
          regex: '.*.jpg$',
          bucket,
          filepath: destinationFilepath,
        },
      ];

      const response = await request(app)
        .put(`/granules/${newGranule.granuleId}`)
        .set('Accept', 'application/json')
        .set('Authorization', `Bearer ${jwtAuthToken}`)
        .send({
          action: 'move',
          destinations,
        })
        .expect(200);

      const body = response.body;
      t.is(body.status, 'SUCCESS');
      t.is(body.action, 'move');

      const bucketObjects = await s3().listObjects({
        Bucket: bucket,
        Prefix: destinationFilepath,
      }).promise();

      t.is(bucketObjects.Contents.length, 2);
      bucketObjects.Contents.forEach((item) => {
        t.is(item.Key.indexOf(destinationFilepath), 0);
      });

      const thirdBucketObjects = await s3().listObjects({
        Bucket: thirdBucket,
        Prefix: destinationFilepath,
      }).promise();

      t.is(thirdBucketObjects.Contents.length, 1);
      thirdBucketObjects.Contents.forEach((item) => {
        t.is(item.Key.indexOf(destinationFilepath), 0);
      });

      // check the granule in dynamoDb is updated
      const updatedGranule = await granuleModel.get({ granuleId: newGranule.granuleId });
      updatedGranule.files.forEach((file) => {
        t.true(file.key.startsWith(destinationFilepath));
        const destination = destinations.find((dest) => file.fileName.match(dest.regex));
        t.is(destination.bucket, file.bucket);
      });

      // check there is no granule in postgresGranuleCumulusId
      await t.throwsAsync(granulePgModel.getRecordCumulusId(t.context.knex, {
        granule_id: updatedGranule.granuleId,
      }), { name: 'RecordDoesNotExist' });
    }
  );
});

test.serial('move a file and update ECHO10 xml metadata', async (t) => {
  const { internalBucket, publicBucket } = await setupBucketsConfig();
  const newGranule = fakeGranuleFactoryV2({ collectionId: t.context.collectionId });

  newGranule.files = [
    {
      bucket: internalBucket,
      fileName: `${newGranule.granuleId}.txt`,
      key: `${process.env.stackName}/original_filepath/${newGranule.granuleId}.txt`,
    },
    {
      bucket: publicBucket,
      fileName: `${newGranule.granuleId}.cmr.xml`,
      key: `${process.env.stackName}/original_filepath/${newGranule.granuleId}.cmr.xml`,
    },
  ];

  await granuleModel.create(newGranule);

  const postgresNewGranule = await translateApiGranuleToPostgresGranule(
    newGranule,
    t.context.knex
  );
  postgresNewGranule.collection_cumulus_id = t.context.collectionCumulusId;

  const [postgresGranuleCumulusId] = await granulePgModel.create(
    t.context.knex, postgresNewGranule
  );
  const postgresNewGranuleFiles = newGranule.files.map((file) => {
    const translatedFile = translateApiFiletoPostgresFile(file);
    translatedFile.granule_cumulus_id = postgresGranuleCumulusId;
    return translatedFile;
  });
  await Promise.all(
    postgresNewGranuleFiles.map((file) =>
      filePgModel.create(t.context.knex, file))
  );
  await granuleModel.create(newGranule, t.context.knex);

  await s3PutObject({
    Bucket: newGranule.files[0].bucket,
    Key: newGranule.files[0].key,
    Body: 'test data',
  });

  await s3PutObject({
    Bucket: newGranule.files[1].bucket,
    Key: newGranule.files[1].key,
    Body: fs.createReadStream(path.resolve(__dirname, '../data/meta.xml')),
  });

  const originalXML = await metadataObjectFromCMRFile(
    buildS3Uri(newGranule.files[1].bucket, newGranule.files[1].key)
  );

  const destinationFilepath = `${process.env.stackName}/moved_granules`;
  const destinations = [
    {
      regex: '.*.txt$',
      bucket: internalBucket,
      filepath: destinationFilepath,
    },
  ];

  sinon.stub(
    CMR.prototype,
    'ingestGranule'
  ).returns({ result: { 'concept-id': 'id204842' } });

  const response = await request(app)
    .put(`/granules/${newGranule.granuleId}`)
    .set('Accept', 'application/json')
    .set('Authorization', `Bearer ${jwtAuthToken}`)
    .send({
      action: 'move',
      destinations,
    })
    .expect(200);

  const body = response.body;

  t.is(body.status, 'SUCCESS');
  t.is(body.action, 'move');

  const list = await s3().listObjects({
    Bucket: internalBucket,
    Prefix: destinationFilepath,
  }).promise();
  t.is(list.Contents.length, 1);
  t.is(list.Contents[0].Key.indexOf(destinationFilepath), 0);

  const list2 = await s3().listObjects({
    Bucket: publicBucket,
    Prefix: `${process.env.stackName}/original_filepath`,
  }).promise();
  t.is(list2.Contents.length, 1);
  t.is(newGranule.files[1].key, list2.Contents[0].Key);

  const xmlObject = await metadataObjectFromCMRFile(
    buildS3Uri(newGranule.files[1].bucket, newGranule.files[1].key)
  );

  const newUrls = xmlObject.Granule.OnlineAccessURLs.OnlineAccessURL.map((obj) => obj.URL);
  const newDestination = `${process.env.DISTRIBUTION_ENDPOINT}${destinations[0].bucket}/${destinations[0].filepath}/${newGranule.files[0].fileName}`;
  t.true(newUrls.includes(newDestination));

  // All original URLs are unchanged (because they weren't involved in the granule move)
  const originalURLObjects = originalXML.Granule.OnlineAccessURLs.OnlineAccessURL;
  const originalURLs = originalURLObjects.map((urlObj) => urlObj.URL);
  originalURLs.forEach((originalURL) => {
    t.true(newUrls.includes(originalURL));
  });

  CMR.prototype.ingestGranule.restore();
  await recursivelyDeleteS3Bucket(publicBucket);
});

test.serial('move a file and update its UMM-G JSON metadata', async (t) => {
  const { internalBucket, publicBucket } = await setupBucketsConfig();

  const newGranule = fakeGranuleFactoryV2({ collectionId: t.context.collectionId });
  const ummgMetadataString = fs.readFileSync(path.resolve(__dirname, '../data/ummg-meta.json'));
  const originalUMMG = JSON.parse(ummgMetadataString);

  newGranule.files = [
    {
      bucket: internalBucket,
      fileName: `${newGranule.granuleId}.txt`,
      key: `${process.env.stackName}/original_filepath/${newGranule.granuleId}.txt`,
    },
    {
      bucket: publicBucket,
      fileName: `${newGranule.granuleId}.cmr.json`,
      key: `${process.env.stackName}/original_filepath/${newGranule.granuleId}.cmr.json`,
    },
  ];

  const postgresNewGranule = await translateApiGranuleToPostgresGranule(
    newGranule,
    t.context.knex
  );
  postgresNewGranule.collection_cumulus_id = t.context.collectionCumulusId;

  const [postgresGranuleCumulusId] = await granulePgModel.create(
    t.context.knex, postgresNewGranule
  );
  const postgresNewGranuleFiles = newGranule.files.map((file) => {
    const translatedFile = translateApiFiletoPostgresFile(file);
    translatedFile.granule_cumulus_id = postgresGranuleCumulusId;
    return translatedFile;
  });
  await Promise.all(
    postgresNewGranuleFiles.map((file) =>
      filePgModel.create(t.context.knex, file))
  );
  await granuleModel.create(newGranule);

  await Promise.all(newGranule.files.map((file) => {
    if (file.name === `${newGranule.granuleId}.txt`) {
      return s3PutObject({ Bucket: file.bucket, Key: file.key, Body: 'test data' });
    }
    return s3PutObject({ Bucket: file.bucket, Key: file.key, Body: ummgMetadataString });
  }));

  const destinationFilepath = `${process.env.stackName}/moved_granules/${randomString()}`;
  const destinations = [
    {
      regex: '.*.txt$',
      bucket: internalBucket,
      filepath: destinationFilepath,
    },
  ];

  sinon.stub(
    CMR.prototype,
    'ingestUMMGranule'
  ).returns({ result: { 'concept-id': 'id204842' } });

  const response = await request(app)
    .put(`/granules/${newGranule.granuleId}`)
    .set('Accept', 'application/json')
    .set('Authorization', `Bearer ${jwtAuthToken}`)
    .send({
      action: 'move',
      destinations,
    })
    .expect(200);

  const body = response.body;

  t.is(body.status, 'SUCCESS');
  t.is(body.action, 'move');

  // text file has moved to correct location
  const list = await s3().listObjects({
    Bucket: internalBucket,
    Prefix: destinationFilepath,
  }).promise();
  t.is(list.Contents.length, 1);
  t.is(list.Contents[0].Key.indexOf(destinationFilepath), 0);

  // CMR JSON  is in same location.
  const list2 = await s3().listObjects({
    Bucket: publicBucket,
    Prefix: `${process.env.stackName}/original_filepath`,
  }).promise();
  t.is(list2.Contents.length, 1);
  t.is(newGranule.files[1].key, list2.Contents[0].Key);

  // CMR UMMG JSON has been updated with the location of the moved file.
  const ummgObject = await metadataObjectFromCMRFile(
    buildS3Uri(newGranule.files[1].bucket, newGranule.files[1].key)
  );
  const updatedURLs = ummgObject.RelatedUrls.map((urlObj) => urlObj.URL);
  const newDestination = `${process.env.DISTRIBUTION_ENDPOINT}${destinations[0].bucket}/${destinations[0].filepath}/${newGranule.files[0].fileName}`;
  t.true(updatedURLs.includes(newDestination));

  // Original metadata is also unchanged.
  const origURLs = originalUMMG.RelatedUrls.map((urlObj) => urlObj.URL);
  origURLs.forEach((origURL) => {
    t.true(updatedURLs.includes(origURL));
  });

  CMR.prototype.ingestUMMGranule.restore();
  await recursivelyDeleteS3Bucket(publicBucket);
});

test.serial('PUT with action move returns failure if one granule file exists', async (t) => {
  const filesExistingStub = sinon.stub(models.Granule.prototype, 'getFilesExistingAtLocation').returns([{ fileName: 'file1' }]);

  const granule = t.context.fakeGranules[0];

  await granuleModel.create(granule);

  const body = {
    action: 'move',
    destinations: [{
      regex: '.*.hdf$',
      bucket: 'fake-bucket',
      filepath: 'fake-destination',
    }],
  };

  const response = await request(app)
    .put(`/granules/${granule.granuleId}`)
    .set('Accept', 'application/json')
    .set('Authorization', `Bearer ${jwtAuthToken}`)
    .send(body)
    .expect(409);

  const responseBody = response.body;
  t.is(response.status, 409);
  t.is(responseBody.message,
    'Cannot move granule because the following files would be overwritten at the destination location: file1. Delete the existing files or reingest the source files.');

  filesExistingStub.restore();
});

test.serial('PUT with action move returns failure if more than one granule file exists', async (t) => {
  const filesExistingStub = sinon.stub(models.Granule.prototype, 'getFilesExistingAtLocation').returns([
    { fileName: 'file1' },
    { fileName: 'file2' },
    { fileName: 'file3' },
  ]);
  const granule = t.context.fakeGranules[0];

  await granuleModel.create(granule);

  const body = {
    action: 'move',
    destinations: [{
      regex: '.*.hdf$',
      bucket: 'fake-bucket',
      filepath: 'fake-destination',
    }],
  };

  const response = await request(app)
    .put(`/granules/${granule.granuleId}`)
    .set('Accept', 'application/json')
    .set('Authorization', `Bearer ${jwtAuthToken}`)
    .send(body)
    .expect(409);

  const responseBody = response.body;
  t.is(response.statusCode, 409);
  t.is(responseBody.message,
    'Cannot move granule because the following files would be overwritten at the destination location: file1, file2, file3. Delete the existing files or reingest the source files.');

  filesExistingStub.restore();
});

test.serial('create (POST) creates new granule without an execution in dynamoDB and postgres', async (t) => {
  const newGranule = fakeGranuleFactoryV2({
    collectionId: t.context.collectionId,
    execution: undefined,
  });

  const response = await request(app)
    .post('/granules')
    .set('Authorization', `Bearer ${jwtAuthToken}`)
    .set('Accept', 'application/json')
    .send(newGranule)
    .expect(200);

  const fetchedDynamoRecord = await granuleModel.get({
    granuleId: newGranule.granuleId,
  });

  const fetchedPostgresRecord = await granulePgModel.get(
    t.context.knex,
    {
      granule_id: newGranule.granuleId,
      collection_cumulus_id: t.context.collectionCumulusId,
    }
  );

  t.deepEqual(
    JSON.parse(response.text),
    { message: `Successfully wrote granule with Granule Id: ${newGranule.granuleId}` }
  );
  t.is(fetchedDynamoRecord.granuleId, newGranule.granuleId);
  t.is(fetchedPostgresRecord.granule_id, newGranule.granuleId);
});

test.serial('create (POST) creates new granule with associated execution in dynamoDB and postgres', async (t) => {
  const newGranule = fakeGranuleFactoryV2({
    collectionId: t.context.collectionId,
    execution: t.context.executionUrl,
  });

  const response = await request(app)
    .post('/granules')
    .set('Authorization', `Bearer ${jwtAuthToken}`)
    .set('Accept', 'application/json')
    .send(newGranule)
    .expect(200);

  const fetchedDynamoRecord = await granuleModel.get({
    granuleId: newGranule.granuleId,
  });

  const fetchedPostgresRecord = await granulePgModel.get(
    t.context.knex,
    {
      granule_id: newGranule.granuleId,
      collection_cumulus_id: t.context.collectionCumulusId,
    }
  );

  t.deepEqual(
    JSON.parse(response.text),
    { message: `Successfully wrote granule with Granule Id: ${newGranule.granuleId}` }
  );
  t.is(fetchedDynamoRecord.granuleId, newGranule.granuleId);
  t.is(fetchedPostgresRecord.granule_id, newGranule.granuleId);
});

test.serial('create (POST) rejects if a granule already exists in postgres', async (t) => {
  const newGranule = fakeGranuleFactoryV2({
    collectionId: t.context.collectionId,
    execution: undefined,
  });

  await request(app)
    .post('/granules')
    .set('Authorization', `Bearer ${jwtAuthToken}`)
    .set('Accept', 'application/json')
    .send(newGranule)
    .expect(200);

  const response = await request(app)
    .post('/granules')
    .set('Authorization', `Bearer ${jwtAuthToken}`)
    .set('Accept', 'application/json')
    .send(newGranule)
    .expect(409);

  const errorText = JSON.parse(response.error.text);
  t.is(errorText.statusCode, 409);
  t.is(errorText.error, 'Conflict');
  t.is(errorText.message, `A granule already exists for granule_id: ${newGranule.granuleId}`);
});

test.serial('create (POST) return bad request if a granule is submitted with a bad collectionId', async (t) => {
  const newGranule = fakeGranuleFactoryV2({
    collectionId: randomId('collectionId'),
  });

  const response = await request(app)
    .post('/granules')
    .set('Authorization', `Bearer ${jwtAuthToken}`)
    .set('Accept', 'application/json')
    .send(newGranule)
    .expect(400);

  t.is(response.statusCode, 400);
  t.is(response.error.status, 400);
  t.is(response.error.message, 'cannot POST /granules (400)');
});

test.serial('PUT adds granule if it does not exist', async (t) => {
  const newGranule = fakeGranuleFactoryV2({
    collectionId: t.context.collectionId,
    execution: undefined,
  });

  const response = await request(app)
    .put(`/granules/${newGranule.granuleId}`)
    .set('Authorization', `Bearer ${jwtAuthToken}`)
    .set('Accept', 'application/json')
    .send(newGranule)
    .expect(201);

  t.deepEqual(JSON.parse(response.text), {
    message: `Successfully wrote granule with Granule Id: ${newGranule.granuleId}`,
  });
});

test.serial('PUT returns an updated granule with an undefined execution', async (t) => {
  const now = Date.now();
  const newGranule = fakeGranuleFactoryV2({
    collectionId: t.context.collectionId,
    createdAt: now,
    timestamp: now,
    execution: undefined,
  });

  const response = await request(app)
    .post('/granules')
    .set('Authorization', `Bearer ${jwtAuthToken}`)
    .set('Accept', 'application/json')
    .send(newGranule)
    .expect(200);

  t.is(response.statusCode, 200);

  const modifiedGranule = {
    ...newGranule,
    status: 'failed',
    error: { some: 'error' },
  };

  const modifiedResponse = await request(app)
    .put(`/granules/${newGranule.granuleId}`)
    .set('Authorization', `Bearer ${jwtAuthToken}`)
    .set('Accept', 'application/json')
    .send(modifiedGranule)
    .expect(200);

  t.is(modifiedResponse.statusCode, 200);

  const fetchedDynamoRecord = await granuleModel.get({
    granuleId: newGranule.granuleId,
  });

  const fetchedPostgresRecord = await granulePgModel.get(
    t.context.knex,
    {
      granule_id: newGranule.granuleId,
      collection_cumulus_id: t.context.collectionCumulusId,
    }
  );

  t.deepEqual(JSON.parse(modifiedResponse.text), {
    message: `Successfully updated granule with Granule Id: ${newGranule.granuleId}`,
  });

  t.is(fetchedDynamoRecord.status, 'failed');
  t.deepEqual(fetchedDynamoRecord.error, { some: 'error' });
  t.is(fetchedDynamoRecord.timestamp, now);
  t.is(fetchedDynamoRecord.createdAt, now);
  t.is(fetchedPostgresRecord.status, 'failed');
  t.deepEqual(fetchedPostgresRecord.error, { some: 'error' });
  t.is(new Date(fetchedPostgresRecord.timestamp).valueOf(), now);
  t.is(new Date(fetchedPostgresRecord.created_at).valueOf(), now);
});

test.serial('PUT returns an updated granule with associated execution', async (t) => {
  const timestamp = Date.now();
  const createdAt = timestamp - 1000000;
  const newGranule = fakeGranuleFactoryV2({
    collectionId: t.context.collectionId,
    createdAt,
    timestamp,
    execution: undefined,
  });

  const response = await request(app)
    .post('/granules')
    .set('Authorization', `Bearer ${jwtAuthToken}`)
    .set('Accept', 'application/json')
    .send(newGranule)
    .expect(200);

  t.is(response.statusCode, 200);

  const modifiedGranule = {
    ...newGranule,
    execution: t.context.executionUrl,
    status: 'failed',
    error: { some: 'error' },
  };

  const modifiedResponse = await request(app)
    .put(`/granules/${newGranule.granuleId}`)
    .set('Authorization', `Bearer ${jwtAuthToken}`)
    .set('Accept', 'application/json')
    .send(modifiedGranule)
    .expect(200);

  t.is(modifiedResponse.statusCode, 200);

  const fetchedDynamoRecord = await granuleModel.get({
    granuleId: newGranule.granuleId,
  });

  const fetchedPostgresRecord = await granulePgModel.get(
    t.context.knex,
    {
      granule_id: newGranule.granuleId,
      collection_cumulus_id: t.context.collectionCumulusId,
    }
  );

  // get execution for this record.
  const granuleCumulusId = await granulePgModel.getRecordCumulusId(
    t.context.knex,
    {
      granule_id: newGranule.granuleId,
      collection_cumulus_id: t.context.collectionCumulusId,
    }
  );

  const granulesExecutionsPgRecord = await granulesExecutionsPgModel.search(
    t.context.knex,
    {
      granule_cumulus_id: granuleCumulusId,
    }
  );

  const executionPgRecord = await executionPgModel.searchByCumulusIds(
    t.context.knex,
    granulesExecutionsPgRecord[0].execution_cumulus_id
  );

  t.deepEqual(JSON.parse(modifiedResponse.text), {
    message: `Successfully updated granule with Granule Id: ${newGranule.granuleId}`,
  });

  t.is(fetchedDynamoRecord.status, 'failed');
  t.deepEqual(fetchedDynamoRecord.error, { some: 'error' });
  t.is(fetchedDynamoRecord.timestamp, timestamp);
  t.is(fetchedDynamoRecord.createdAt, createdAt);
  t.is(fetchedDynamoRecord.execution, modifiedGranule.execution);

  t.is(fetchedPostgresRecord.status, 'failed');
  t.deepEqual(fetchedPostgresRecord.error, { some: 'error' });
  t.is(new Date(fetchedPostgresRecord.timestamp).valueOf(), timestamp);
  t.is(new Date(fetchedPostgresRecord.created_at).valueOf(), createdAt);
  t.is(executionPgRecord[0].url, modifiedGranule.execution);
});

test.serial('PUT returns bad request when the path param granuleName does not match the json granuleId', async (t) => {
  const newGranule = fakeGranuleFactoryV2({});
  const granuleName = `granuleName_${cryptoRandomString({ length: 10 })}`;

  const { body } = await request(app)
    .put(`/granules/${granuleName}`)
    .set('Authorization', `Bearer ${jwtAuthToken}`)
    .set('Accept', 'application/json')
    .send(newGranule)
    .expect(400);

  t.is(body.statusCode, 400);
  t.is(body.error, 'Bad Request');
  t.is(body.message, `input :granuleName (${granuleName}) must match body's granuleId (${newGranule.granuleId})`);
});

test.serial('PUT can set granule status to queued', async (t) => {
  const granuleId = t.context.fakeGranules[2].granuleId;
  const response = await request(app)
    .put(`/granules/${granuleId}`)
    .set('Accept', 'application/json')
    .set('Authorization', `Bearer ${jwtAuthToken}`)
    .send({
      granuleId: granuleId,
      status: 'queued',
      collectionId: t.context.collectionId,
    });

  t.is(response.status, 200);
  t.deepEqual(JSON.parse(response.text), {
    message: `Successfully updated granule with Granule Id: ${granuleId}`,
  });
});

test.serial('PUT will not set completed status to queued', async (t) => {
  const granuleId = t.context.fakeGranules[0].granuleId;
  const response = await request(app)
    .put(`/granules/${granuleId}`)
    .set('Accept', 'application/json')
    .set('Authorization', `Bearer ${jwtAuthToken}`)
    .send({
      granuleId: granuleId,
      status: 'queued',
      collectionId: t.context.collectionId,
      execution: t.context.executionUrl,
    });

  t.is(response.status, 200);
  t.deepEqual(JSON.parse(response.text), {
    message: `Successfully updated granule with Granule Id: ${granuleId}`,
  });
  const fetchedDynamoRecord = await granuleModel.get({
    granuleId,
  });

  t.is(fetchedDynamoRecord.status, 'completed');
});

test.serial('PUT can create a new granule with status queued', async (t) => {
  const granuleId = randomId('new-granule');
  const response = await request(app)
    .put(`/granules/${granuleId}`)
    .set('Accept', 'application/json')
    .set('Authorization', `Bearer ${jwtAuthToken}`)
    .send({
      granuleId: granuleId,
      status: 'queued',
      collectionId: t.context.collectionId,
    });

  t.is(response.status, 201);
  t.deepEqual(JSON.parse(response.text), {
    message: `Successfully wrote granule with Granule Id: ${granuleId}`,
  });
});

test.serial('associateExecution (POST) returns bad request if fields are missing in payload', async (t) => {
  const response = await request(app)
    .post(`/granules/${randomId('granuleId')}/executions`)
    .set('Authorization', `Bearer ${jwtAuthToken}`)
    .set('Accept', 'application/json')
    .expect(400);

  t.is(response.body.error, 'Bad Request');
  t.is(response.body.message, 'Field granuleId, collectionId or executionArn is missing from request body');
});

test.serial('associateExecution (POST) returns bad request when the path param granuleName does not match the granuleId in payload', async (t) => {
  const granuleIdInPath = randomId('granuleIdInPath');
  const granuleIdInRquest = randomId('granuleIdInRquest');

  const requestPayload = {
    collectionId: t.context.collectionId,
    executionArn: t.context.executionArn,
    granuleId: granuleIdInRquest,
  };
  const response = await request(app)
    .post(`/granules/${granuleIdInPath}/executions`)
    .set('Authorization', `Bearer ${jwtAuthToken}`)
    .set('Accept', 'application/json')
    .send(requestPayload)
    .expect(400);

  t.is(response.body.error, 'Bad Request');
  t.is(response.body.message, `Expected granuleId to be ${granuleIdInPath} but found ${granuleIdInRquest} in payload`);
});

test.serial('associateExecution (POST) returns Not Found if granule does not exist', async (t) => {
  const granuleId = randomId('granuleId');
  const requestPayload = {
    collectionId: t.context.collectionId,
    executionArn: t.context.executionArn,
    granuleId,
  };

  const response = await request(app)
    .post(`/granules/${granuleId}/executions`)
    .set('Authorization', `Bearer ${jwtAuthToken}`)
    .set('Accept', 'application/json')
    .send(requestPayload)
    .expect(404);

  t.is(response.body.error, 'Not Found');
  t.is(response.body.message, `No granule found to associate execution with for granuleId ${granuleId}`);
});

test.serial('associateExecution (POST) associates an execution with a granule', async (t) => {
  const timestamp = Date.now();
  const createdAt = timestamp - 1000000;
  const newGranule = fakeGranuleFactoryV2({
    collectionId: t.context.collectionId,
    createdAt,
    timestamp,
    execution: undefined,
  });

  await request(app)
    .post('/granules')
    .set('Authorization', `Bearer ${jwtAuthToken}`)
    .set('Accept', 'application/json')
    .send(newGranule)
    .expect(200);

  const requestPayload = {
    collectionId: t.context.collectionId,
    executionArn: t.context.executionArn,
    granuleId: newGranule.granuleId,
  };

  const response = await request(app)
    .post(`/granules/${newGranule.granuleId}/executions`)
    .set('Authorization', `Bearer ${jwtAuthToken}`)
    .set('Accept', 'application/json')
    .send(requestPayload)
    .expect(200);

  const fetchedDynamoRecord = await granuleModel.get({
    granuleId: newGranule.granuleId,
  });

  const fetchedPostgresRecord = await granulePgModel.get(
    t.context.knex,
    {
      granule_id: newGranule.granuleId,
      collection_cumulus_id: t.context.collectionCumulusId,
    }
  );

  // get execution for this record.
  const granuleCumulusId = await granulePgModel.getRecordCumulusId(
    t.context.knex,
    {
      granule_id: newGranule.granuleId,
      collection_cumulus_id: t.context.collectionCumulusId,
    }
  );

  const granulesExecutionsPgRecord = await granulesExecutionsPgModel.search(
    t.context.knex,
    {
      granule_cumulus_id: granuleCumulusId,
    }
  );

  const executionPgRecord = await executionPgModel.searchByCumulusIds(
    t.context.knex,
    granulesExecutionsPgRecord[0].execution_cumulus_id
  );

  t.deepEqual(JSON.parse(response.text), {
    message: `Successfully associated execution ${requestPayload.executionArn} with granule granuleId ${requestPayload.granuleId} collectionId ${requestPayload.collectionId}`,
  });

  t.is(fetchedDynamoRecord.timestamp, timestamp);
  t.is(fetchedDynamoRecord.createdAt, createdAt);
  t.is(fetchedDynamoRecord.execution, t.context.executionUrl);

  t.is(new Date(fetchedPostgresRecord.timestamp).valueOf(), timestamp);
  t.is(new Date(fetchedPostgresRecord.created_at).valueOf(), createdAt);
  t.is(executionPgRecord[0].arn, requestPayload.executionArn);
});

test.serial('associateExecution (POST) returns Not Found if execution does not exist', async (t) => {
  const newGranule = fakeGranuleFactoryV2({
    collectionId: t.context.collectionId,
    execution: undefined,
  });

  await request(app)
    .post('/granules')
    .set('Authorization', `Bearer ${jwtAuthToken}`)
    .set('Accept', 'application/json')
    .send(newGranule)
    .expect(200);

  const executionArn = randomId('executionArn');
  const requestPayload = {
    collectionId: t.context.collectionId,
    executionArn,
    granuleId: newGranule.granuleId,
  };

  const response = await request(app)
    .post(`/granules/${newGranule.granuleId}/executions`)
    .set('Authorization', `Bearer ${jwtAuthToken}`)
    .set('Accept', 'application/json')
    .send(requestPayload)
    .expect(404);

  t.is(response.body.error, 'Not Found');
  t.is(response.body.message, `Execution ${executionArn} not found`);
});

test.serial('associateExecution (POST) returns Not Found if collectionId in payload does not match the granule record', async (t) => {
  const newGranule = fakeGranuleFactoryV2({
    collectionId: t.context.collectionId,
    execution: undefined,
  });

  await request(app)
    .post('/granules')
    .set('Authorization', `Bearer ${jwtAuthToken}`)
    .set('Accept', 'application/json')
    .send(newGranule)
    .expect(200);

  const collectionId = randomId('collectionId');
  const requestPayload = {
    collectionId,
    executionArn: t.context.executionArn,
    granuleId: newGranule.granuleId,
  };

  const response = await request(app)
    .post(`/granules/${newGranule.granuleId}/executions`)
    .set('Authorization', `Bearer ${jwtAuthToken}`)
    .set('Accept', 'application/json')
    .send(requestPayload)
    .expect(404);

  t.is(response.body.error, 'Not Found');
  t.true(response.body.message.includes(`No granule found to associate execution with for granuleId ${newGranule.granuleId} collectionId ${collectionId}`));
});
