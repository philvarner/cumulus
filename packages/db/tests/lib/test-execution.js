const test = require('ava');
const cryptoRandomString = require('crypto-random-string');
const { RecordDoesNotExist } = require('@cumulus/errors');

const testDbName = `execution_${cryptoRandomString({ length: 10 })}`;
const randomArn = () => `arn_${cryptoRandomString({ length: 10 })}`;
const randomGranuleId = () => `granuleId_${cryptoRandomString({ length: 10 })}`;
const randomWorkflow = () => `workflow_${cryptoRandomString({ length: 10 })}`;

const {
  destroyLocalTestDb,
  generateLocalTestDb,
  GranulePgModel,
  GranulesExecutionsPgModel,
  CollectionPgModel,
  fakeCollectionRecordFactory,
  ExecutionPgModel,
  fakeExecutionRecordFactory,
  fakeGranuleRecordFactory,
  executionArnsFromGranuleIdsAndWorkflowNames,
  newestExecutionArnFromGranuleIdWorkflowName,
  getWorkflowNameIntersectFromGranuleIds,
  upsertGranuleWithExecutionJoinRecord,
  getExecutionArnsByGranuleCumulusId,
  migrationDir,
  createRejectableTransaction,
  getApiExecutionCumulusIds,
  getApiGranuleExecutionCumulusIdsByExecution,
} = require('../../dist');

/**
 * Create a new Execution Record, and link it to the input GranuleCumulusId.
 * @param {Object} t - ava context
 * @param {number} granuleCumulusId
 * @param {Object} executionParams - params passed to create fake exectuion.
 * @returns {Promise<number>} - the executionCumulusId created.
 */
const linkNewExecutionToGranule = async (
  t,
  granuleCumulusId,
  executionParams
) => {
  const [executionCumulusId] = await t.context.executionPgModel.create(
    t.context.knex,
    fakeExecutionRecordFactory(executionParams)
  );
  const joinRecord = {
    execution_cumulus_id: executionCumulusId,
    granule_cumulus_id: granuleCumulusId,
  };
  await t.context.granulesExecutionsPgModel.create(t.context.knex, joinRecord);
  return executionCumulusId;
};

/**
 * Creates and inserts into the database a new Granule record and a new Execution record,
 * and a GranuleExecution record to associate the two.
 * @param {Object} t - ava context
 * @param {Object} executionParams - params passed to create a fake execution.
 * @param {Object} granuleParams - params passed to create a fake granule.
 * @returns {Promise<Object>} - object containing the executionCumulusId and granuleCumulusId
 *                              for the new records.
 */
const newGranuleAssociatedWithExecution = async (
  t,
  executionParams,
  granuleParams
) => {
  const [granuleCumulusId] = await t.context.granulePgModel.create(
    t.context.knex,
    fakeGranuleRecordFactory({
      collection_cumulus_id: t.context.collectionCumulusId,
      ...granuleParams,
    })
  );
  const executionCumulusId = await linkNewExecutionToGranule(
    t,
    granuleCumulusId,
    executionParams
  );
  return { executionCumulusId, granuleCumulusId };
};

test.before(async (t) => {
  const { knexAdmin, knex } = await generateLocalTestDb(
    testDbName,
    migrationDir
  );
  t.context.knexAdmin = knexAdmin;
  t.context.knex = knex;

  t.context.granulePgModel = new GranulePgModel();
  t.context.granulesExecutionsPgModel = new GranulesExecutionsPgModel();

  const collectionPgModel = new CollectionPgModel();
  [t.context.collectionCumulusId] = await collectionPgModel.create(
    t.context.knex,
    fakeCollectionRecordFactory()
  );

  t.context.executionPgModel = new ExecutionPgModel();
});

test.after.always(async (t) => {
  await destroyLocalTestDb({
    ...t.context,
    testDbName,
  });
});

test('getExecutionArnsByGranuleCumulusId() gets all Executions related to a Granule', async (t) => {
  const {
    knex,
    collectionCumulusId,
    executionPgModel,
    granulePgModel,
    granulesExecutionsPgModel,
  } = t.context;

  // Create executions
  const [executionA] = await executionPgModel.create(
    knex,
    fakeExecutionRecordFactory({ timestamp: new Date(Date.now()) })
  );
  const [executionB] = await executionPgModel.create(
    knex,
    fakeExecutionRecordFactory({ timestamp: new Date(Date.now() - 200 * 1000) })
  );

  const executionACumulusId = executionA;
  const executionBCumulusId = executionB;

  // Create Granule
  const [pgGranule] = await granulePgModel.create(
    knex,
    fakeGranuleRecordFactory({
      collection_cumulus_id: collectionCumulusId,
    })
  );
  const granuleCumulusId = pgGranule;
  // Create GranulesExecuions JOIN records
  await granulesExecutionsPgModel.create(
    knex,
    {
      granule_cumulus_id: granuleCumulusId,
      execution_cumulus_id: executionACumulusId,
    }
  );
  await granulesExecutionsPgModel.create(
    knex,
    {
      granule_cumulus_id: granuleCumulusId,
      execution_cumulus_id: executionBCumulusId,
    }
  );

  const exepectedExecutionArn1 = await executionPgModel.get(
    knex,
    { cumulus_id: executionACumulusId }
  );
  const exepectedExecutionArn2 = await executionPgModel.get(
    knex,
    { cumulus_id: executionBCumulusId }
  );

  const result = await getExecutionArnsByGranuleCumulusId(
    knex,
    granuleCumulusId
  );

  t.deepEqual(
    result,
    [{ arn: exepectedExecutionArn1.arn }, { arn: exepectedExecutionArn2.arn }]
  );
});

test('getExecutionArnsByGranuleCumulusId() gets all Executions related to a Granule with limit configuration', async (t) => {
  const {
    knex,
    collectionCumulusId,
    executionPgModel,
    granulePgModel,
    granulesExecutionsPgModel,
  } = t.context;

  // Create executions
  const [executionA] = await executionPgModel.create(
    knex,
    fakeExecutionRecordFactory({ timestamp: new Date(Date.now()) })
  );
  const [executionB] = await executionPgModel.create(
    knex,
    fakeExecutionRecordFactory({ timestamp: new Date(Date.now() - 200 * 1000) })
  );

  const executionACumulusId = executionA;
  const executionBCumulusId = executionB;

  // Create Granule
  const [pgGranule] = await granulePgModel.create(
    knex,
    fakeGranuleRecordFactory({
      collection_cumulus_id: collectionCumulusId,
    })
  );
  const granuleCumulusId = pgGranule;

  // Create GranulesExecuions JOIN records
  await granulesExecutionsPgModel.create(
    knex,
    {
      granule_cumulus_id: granuleCumulusId,
      execution_cumulus_id: executionACumulusId,
    }
  );
  await granulesExecutionsPgModel.create(
    knex,
    {
      granule_cumulus_id: granuleCumulusId,
      execution_cumulus_id: executionBCumulusId,
    }
  );

  const exepectedExecutionArn1 = await executionPgModel.get(
    knex,
    { cumulus_id: executionACumulusId }
  );
  await executionPgModel.get(
    knex,
    { cumulus_id: executionBCumulusId }
  );

  const result = await getExecutionArnsByGranuleCumulusId(
    knex,
    granuleCumulusId,
    1
  );

  t.deepEqual(
    result,
    [{ arn: exepectedExecutionArn1.arn }]
  );
});

test('executionArnsFromGranuleIdsAndWorkflowNames() returns arn by workflow and granuleId for a linked granule execution.', async (t) => {
  const workflowName = randomWorkflow();
  const executionArn = randomArn();
  const granuleId = randomGranuleId();

  await newGranuleAssociatedWithExecution(
    t,
    {
      workflow_name: workflowName,
      arn: executionArn,
    },
    {
      granule_id: granuleId,
    }
  );

  const results = await executionArnsFromGranuleIdsAndWorkflowNames(
    t.context.knex,
    [granuleId],
    [workflowName]
  );

  t.is(results[0].arn, executionArn);
});

test('executionArnsFromGranuleIdsAndWorkflowNames() returns correct arn when a granule has multiple executions with different workflow names associated with it.', async (t) => {
  const granuleId = randomGranuleId();
  const firstExecutionParams = {
    workflow_name: randomWorkflow(),
    arn: randomArn(),
  };
  const secondExecutionParams = {
    workflow_name: randomWorkflow(),
    arn: randomArn(),
  };
  const granuleExecution = await newGranuleAssociatedWithExecution(
    t,
    firstExecutionParams,
    {
      granule_id: granuleId,
    }
  );
  await linkNewExecutionToGranule(
    t,
    granuleExecution.granuleCumulusId,
    secondExecutionParams
  );

  const results = await executionArnsFromGranuleIdsAndWorkflowNames(
    t.context.knex,
    [granuleId],
    [firstExecutionParams.workflow_name]
  );

  t.is(results.length, 1);
  t.is(results[0].arn, firstExecutionParams.arn);

  const secondResults = await executionArnsFromGranuleIdsAndWorkflowNames(
    t.context.knex,
    [granuleId],
    [secondExecutionParams.workflow_name]
  );

  t.is(secondResults.length, 1);
  t.is(secondResults[0].arn, secondExecutionParams.arn);
});

test('executionArnsFromGranuleIdsAndWorkflowNames() returns all arns for a granule that has had the same workflow applied multiple times, with the most recent timestamp first.', async (t) => {
  const granuleId = randomGranuleId();
  const theWorkflowName = randomWorkflow();
  const oldestExecution = {
    workflow_name: theWorkflowName,
    arn: randomArn(),
    timestamp: new Date('1999-01-26T08:42:00.000Z'),
  };
  const mostRecentExecution = {
    workflow_name: theWorkflowName,
    arn: randomArn(),
    timestamp: new Date('2021-07-26T18:00:00.000Z'),
  };
  const granuleExecution = await newGranuleAssociatedWithExecution(
    t,
    oldestExecution,
    {
      granule_id: granuleId,
    }
  );
  await linkNewExecutionToGranule(
    t,
    granuleExecution.granuleCumulusId,
    mostRecentExecution
  );

  const results = await executionArnsFromGranuleIdsAndWorkflowNames(
    t.context.knex,
    [granuleId],
    [theWorkflowName]
  );

  t.is(results.length, 2);
  t.is(results[0].arn, mostRecentExecution.arn);
  t.is(results[1].arn, oldestExecution.arn);
});

test('executionArnsFromGranuleIdsAndWorkflowNames() returns all arns for an array of workflow names, sorted by timestamp.', async (t) => {
  const granuleId = randomGranuleId();
  const aWorkflowName = randomWorkflow();
  const anotherWorkflowName = randomWorkflow();

  const oldestExecution = {
    workflow_name: aWorkflowName,
    arn: randomArn(),
    timestamp: new Date('1999-01-26T08:42:00.000Z'),
  };
  const oldExecution = {
    workflow_name: aWorkflowName,
    arn: randomArn(),
    timestamp: new Date('2000-11-22T01:00:00.000Z'),
  };
  const mostRecentExecution = {
    workflow_name: anotherWorkflowName,
    arn: randomArn(),
    timestamp: new Date('2021-07-26T18:00:00.000Z'),
  };
  const recentExecutionButExcludedFromResults = {
    workflow_name: randomWorkflow(),
    arn: randomArn(),
    timestamp: new Date(),
  };

  const granuleExecution = await newGranuleAssociatedWithExecution(
    t,
    oldestExecution,
    {
      granule_id: granuleId,
    }
  );
  await linkNewExecutionToGranule(
    t,
    granuleExecution.granuleCumulusId,
    mostRecentExecution
  );
  await linkNewExecutionToGranule(
    t,
    granuleExecution.granuleCumulusId,
    oldExecution
  );
  await linkNewExecutionToGranule(
    t,
    granuleExecution.granuleCumulusId,
    recentExecutionButExcludedFromResults
  );

  const results = await executionArnsFromGranuleIdsAndWorkflowNames(
    t.context.knex,
    [granuleId],
    [aWorkflowName, anotherWorkflowName]
  );

  t.is(results.length, 3);
  t.is(results[0].arn, mostRecentExecution.arn);
  t.is(results[1].arn, oldExecution.arn);
  t.is(results[2].arn, oldestExecution.arn);
});

test('executionArnsFromGranuleIdsAndWorkflowNames() returns all arns for an array of granuleIds, sorted by timestamp.', async (t) => {
  const granuleId = randomGranuleId();
  const anotherGranuleId = randomGranuleId();

  const aWorkflowName = randomWorkflow();

  const oldestExecution = {
    workflow_name: aWorkflowName,
    arn: randomArn(),
    timestamp: new Date('1999-01-26T08:42:00.000Z'),
  };
  const oldExecution = {
    workflow_name: aWorkflowName,
    arn: randomArn(),
    timestamp: new Date('2000-11-22T01:00:00.000Z'),
  };
  const mostRecentExecution = {
    workflow_name: aWorkflowName,
    arn: randomArn(),
    timestamp: new Date('2021-07-26T18:00:00.000Z'),
  };
  const recentExecutionButExcludedFromResults = {
    workflow_name: randomWorkflow(),
    arn: randomArn(),
    timestamp: new Date(),
  };

  const granuleExecution = await newGranuleAssociatedWithExecution(
    t,
    oldestExecution,
    { granule_id: granuleId }
  );
  await linkNewExecutionToGranule(
    t,
    granuleExecution.granuleCumulusId,
    recentExecutionButExcludedFromResults
  );

  const secondGranuleExecution = await newGranuleAssociatedWithExecution(
    t,
    oldExecution,
    { granule_id: anotherGranuleId }
  );
  await linkNewExecutionToGranule(
    t,
    secondGranuleExecution.granuleCumulusId,
    mostRecentExecution
  );

  const results = await executionArnsFromGranuleIdsAndWorkflowNames(
    t.context.knex,
    [granuleId, anotherGranuleId],
    [aWorkflowName]
  );

  t.is(results.length, 3);
  t.is(results[0].arn, mostRecentExecution.arn);
  t.is(results[1].arn, oldExecution.arn);
  t.is(results[2].arn, oldestExecution.arn);
});

test('executionArnsFromGranuleIdsAndWorkflowNames() returns empty array if no records are found.', async (t) => {
  const results = await executionArnsFromGranuleIdsAndWorkflowNames(
    t.context.knex,
    [randomGranuleId()],
    [randomWorkflow()]
  );
  t.is(results.length, 0);
});

test('newGranuleAssociatedWithExecution() returns the most recent arn.', async (t) => {
  const granuleId = randomGranuleId();
  const theWorkflowName = randomWorkflow();
  const oldestExecution = {
    workflow_name: theWorkflowName,
    arn: randomArn(),
    timestamp: new Date('1999-01-26T08:42:00.000Z'),
  };
  const mostRecentExecution = {
    workflow_name: theWorkflowName,
    arn: randomArn(),
    timestamp: new Date('2021-07-26T18:00:00.000Z'),
  };
  const granuleExecution = await newGranuleAssociatedWithExecution(
    t,
    oldestExecution,
    {
      granule_id: granuleId,
    }
  );
  await linkNewExecutionToGranule(
    t,
    granuleExecution.granuleCumulusId,
    mostRecentExecution
  );

  const actual = await newestExecutionArnFromGranuleIdWorkflowName(
    [granuleId],
    [theWorkflowName],
    t.context.knex
  );

  t.is(actual, mostRecentExecution.arn);
});

test('newGranuleAssociatedWithExecution() throws RecordDoesNotExist if no associated executionArn is found in the database.', async (t) => {
  const granuleId = randomGranuleId();
  const workflowName = randomGranuleId();

  await t.throwsAsync(
    newestExecutionArnFromGranuleIdWorkflowName(
      [granuleId],
      [workflowName],
      t.context.knex
    ),
    {
      instanceOf: RecordDoesNotExist,
      message: `No executionArns found for granuleId:${granuleId} running workflow:${workflowName}`,
    }
  );
});

test('getWorkflowNameIntersectFromGranuleIds() returns correct values', async (t) => {
  const {
    knex,
    collectionCumulusId,
    executionPgModel,
    granulesExecutionsPgModel,
  } = t.context;
  const granuleRecords = [
    fakeGranuleRecordFactory({
      granule_id: randomGranuleId(),
      collection_cumulus_id: collectionCumulusId,
    }),
    fakeGranuleRecordFactory({
      granule_id: randomGranuleId(),
      collection_cumulus_id: collectionCumulusId,
    }),
    fakeGranuleRecordFactory({
      granule_id: randomGranuleId(),
      collection_cumulus_id: collectionCumulusId,
    }),
  ];
  const executionRecords = [
    fakeExecutionRecordFactory({ workflow_name: 'fakeWorkflow' }),
    fakeExecutionRecordFactory({ workflow_name: 'fakeWorkflow' }),
    fakeExecutionRecordFactory({ workflow_name: 'fakeWorkflow2' }),
  ];
  let executionCumulusId1;
  let executionCumulusId2;
  let executionCumulusId3;
  await createRejectableTransaction(knex, async (trx) => {
    [executionCumulusId1] = await executionPgModel.create(trx, executionRecords[0]);
    [executionCumulusId2] = await executionPgModel.create(trx, executionRecords[1]);
    [executionCumulusId3] = await executionPgModel.create(trx, executionRecords[2]);
  });

  // granule 1 is associated with execution 1 + 3
  const [granuleCumulusId1] = await upsertGranuleWithExecutionJoinRecord(knex,
    granuleRecords[0],
    executionCumulusId1);

  await granulesExecutionsPgModel.create(knex, {
    granule_cumulus_id: granuleCumulusId1,
    execution_cumulus_id: executionCumulusId3,
  });

  // granule 2 is associated with execution 2
  const [granuleCumulusId2] = await upsertGranuleWithExecutionJoinRecord(knex,
    granuleRecords[1],
    executionCumulusId2);

  // granule 3 is associated with executions 2 + 3
  const [granuleCumulusId3] = await upsertGranuleWithExecutionJoinRecord(knex,
    granuleRecords[2],
    executionCumulusId1);

  await granulesExecutionsPgModel.create(knex, {
    granule_cumulus_id: granuleCumulusId3,
    execution_cumulus_id: executionCumulusId3,
  });

  const results = await getWorkflowNameIntersectFromGranuleIds(knex,
    [granuleCumulusId1, granuleCumulusId2, granuleCumulusId3]);

  t.deepEqual(results, ['fakeWorkflow']);
});

test('getWorkflowNameIntersectFromGranuleIds() returns empty array if there is no intersect', async (t) => {
  const {
    knex,
    collectionCumulusId,
    executionPgModel,
    granulesExecutionsPgModel,
  } = t.context;
  const granuleRecords = [
    fakeGranuleRecordFactory({
      granule_id: randomGranuleId(),
      collection_cumulus_id: collectionCumulusId,
    }),
    fakeGranuleRecordFactory({
      granule_id: randomGranuleId(),
      collection_cumulus_id: collectionCumulusId,
    }),
    fakeGranuleRecordFactory({
      granule_id: randomGranuleId(),
      collection_cumulus_id: collectionCumulusId,
    }),
  ];
  const executionRecords = [
    fakeExecutionRecordFactory({ workflow_name: 'fakeWorkflow' }),
    fakeExecutionRecordFactory({ workflow_name: 'fakeWorkflow2' }),
    fakeExecutionRecordFactory({ workflow_name: 'fakeWorkflow3' }),
  ];
  let executionCumulusId1;
  let executionCumulusId2;
  let executionCumulusId3;
  await createRejectableTransaction(knex, async (trx) => {
    [executionCumulusId1] = await executionPgModel.create(trx, executionRecords[0]);
    [executionCumulusId2] = await executionPgModel.create(trx, executionRecords[1]);
    [executionCumulusId3] = await executionPgModel.create(trx, executionRecords[2]);
  });

  // granule 1 is associated with execution 1 + 3
  const [granuleCumulusId1] = await upsertGranuleWithExecutionJoinRecord(knex,
    granuleRecords[0],
    executionCumulusId1);

  await granulesExecutionsPgModel.create(knex, {
    granule_cumulus_id: granuleCumulusId1,
    execution_cumulus_id: executionCumulusId3,
  });

  // granule 2 is associated with execution 2
  const [granuleCumulusId2] = await upsertGranuleWithExecutionJoinRecord(knex,
    granuleRecords[1],
    executionCumulusId2);

  // granule 3 is associated with executions 2 + 3
  const [granuleCumulusId3] = await upsertGranuleWithExecutionJoinRecord(knex,
    granuleRecords[2],
    executionCumulusId1);

  await granulesExecutionsPgModel.create(knex, {
    granule_cumulus_id: granuleCumulusId3,
    execution_cumulus_id: executionCumulusId3,
  });

  const results = await getWorkflowNameIntersectFromGranuleIds(knex,
    [granuleCumulusId1, granuleCumulusId2, granuleCumulusId3]);

  t.deepEqual(results, []);
});

test('getWorkflowNameIntersectFromGranuleIds() returns correct values for single granule', async (t) => {
  const {
    knex,
    collectionCumulusId,
    executionPgModel,
    granulesExecutionsPgModel,
  } = t.context;
  const granuleRecord = fakeGranuleRecordFactory({
    granule_id: randomGranuleId(),
    collection_cumulus_id: collectionCumulusId,
  });
  const executionRecords = [
    fakeExecutionRecordFactory({ workflow_name: 'fakeWorkflow' }),
    fakeExecutionRecordFactory({ workflow_name: 'fakeWorkflow' }),
    fakeExecutionRecordFactory({ workflow_name: 'fakeWorkflow2' }),
  ];

  let executionCumulusId1;
  let executionCumulusId2;
  let executionCumulusId3;
  await createRejectableTransaction(knex, async (trx) => {
    [executionCumulusId1] = await executionPgModel.create(trx, executionRecords[0]);
    [executionCumulusId2] = await executionPgModel.create(trx, executionRecords[1]);
    [executionCumulusId3] = await executionPgModel.create(trx, executionRecords[2]);
  });

  const [granuleCumulusId] = await upsertGranuleWithExecutionJoinRecord(knex,
    granuleRecord,
    executionCumulusId1);

  await granulesExecutionsPgModel.create(knex, {
    granule_cumulus_id: granuleCumulusId,
    execution_cumulus_id: executionCumulusId2,
  });

  await granulesExecutionsPgModel.create(knex, {
    granule_cumulus_id: granuleCumulusId,
    execution_cumulus_id: executionCumulusId3,
  });

  const results = await getWorkflowNameIntersectFromGranuleIds(knex, [granuleCumulusId]);

  t.deepEqual(results.sort(), ['fakeWorkflow', 'fakeWorkflow2']);
});

test('getWorkflowNameIntersectFromGranuleIds() returns sorts by timestamp for single granule', async (t) => {
  const {
    knex,
    collectionCumulusId,
    executionPgModel,
    granulesExecutionsPgModel,
  } = t.context;
  const granuleRecord = fakeGranuleRecordFactory({
    granule_id: randomGranuleId(),
    collection_cumulus_id: collectionCumulusId,
  });
  const executionRecords = [
    fakeExecutionRecordFactory({ workflow_name: 'fakeWorkflow1', timestamp: new Date('1234') }),
    fakeExecutionRecordFactory({ workflow_name: 'fakeWorkflow2', timestamp: new Date('32567') }),
    fakeExecutionRecordFactory({ workflow_name: 'fakeWorkflow3', timestamp: new Date('456') }),
  ];

  let executionCumulusId1;
  let executionCumulusId2;
  let executionCumulusId3;
  await createRejectableTransaction(knex, async (trx) => {
    [executionCumulusId1] = await executionPgModel.create(trx, executionRecords[0]);
    [executionCumulusId2] = await executionPgModel.create(trx, executionRecords[1]);
    [executionCumulusId3] = await executionPgModel.create(trx, executionRecords[2]);
  });

  const [granuleCumulusId] = await upsertGranuleWithExecutionJoinRecord(knex,
    granuleRecord,
    executionCumulusId1);

  await granulesExecutionsPgModel.create(knex, {
    granule_cumulus_id: granuleCumulusId,
    execution_cumulus_id: executionCumulusId2,
  });

  await granulesExecutionsPgModel.create(knex, {
    granule_cumulus_id: granuleCumulusId,
    execution_cumulus_id: executionCumulusId3,
  });

  const results = await getWorkflowNameIntersectFromGranuleIds(knex, [granuleCumulusId]);

  t.deepEqual(results, ['fakeWorkflow2', 'fakeWorkflow1', 'fakeWorkflow3']);
});

test('getApiExecutionCumulusIds() returns list of cumulus ids given a list of API executions', async (t) => {
  const {
    knex,
    executionPgModel,
  } = t.context;

  const executionRecords = [
    fakeExecutionRecordFactory({ workflow_name: 'fakeWorkflow1', timestamp: new Date('1234') }),
    fakeExecutionRecordFactory({ workflow_name: 'fakeWorkflow2', timestamp: new Date('32567') }),
    fakeExecutionRecordFactory({ workflow_name: 'fakeWorkflow3', timestamp: new Date('456') }),
  ];

  let executionCumulusId1;
  let executionCumulusId2;
  let executionCumulusId3;
  await createRejectableTransaction(knex, async (trx) => {
    [executionCumulusId1] = await executionPgModel.create(trx, executionRecords[0]);
    [executionCumulusId2] = await executionPgModel.create(trx, executionRecords[1]);
    [executionCumulusId3] = await executionPgModel.create(trx, executionRecords[2]);
  });

  const executionCumulusIds = await getApiExecutionCumulusIds(knex, executionRecords);

  t.deepEqual(executionCumulusIds, [executionCumulusId1, executionCumulusId2, executionCumulusId3]);
});

test('getApiGranuleExecutionCumulusIdsByExecution() returns granule cumulus ids associated with a given execution', async (t) => {
  const {
    knex,
    collectionCumulusId,
    executionPgModel,
  } = t.context;

  const granuleRecord1 = fakeGranuleRecordFactory({
    granule_id: randomGranuleId(),
    collection_cumulus_id: collectionCumulusId,
  });
  const granuleRecord2 = fakeGranuleRecordFactory({
    granule_id: randomGranuleId(),
    collection_cumulus_id: collectionCumulusId,
  });
  const granuleRecord3 = fakeGranuleRecordFactory({
    granule_id: randomGranuleId(),
    collection_cumulus_id: collectionCumulusId,
  });

  const executionRecords = [
    fakeExecutionRecordFactory({ workflow_name: 'fakeWorkflow1', timestamp: new Date('1234') }),
  ];

  let executionCumulusId1;
  await createRejectableTransaction(knex, async (trx) => {
    [executionCumulusId1] = await executionPgModel.create(trx, executionRecords[0]);
  });

  const [granuleCumulusId1] = await upsertGranuleWithExecutionJoinRecord(knex,
    granuleRecord1,
    executionCumulusId1);

  const [granuleCumulusId2] = await upsertGranuleWithExecutionJoinRecord(knex,
    granuleRecord2,
    executionCumulusId1);

  const [granuleCumulusId3] = await upsertGranuleWithExecutionJoinRecord(knex,
    granuleRecord3,
    executionCumulusId1);

  const expectedGranuleCumulusIds = [
    Number(granuleCumulusId1),
    Number(granuleCumulusId2),
    Number(granuleCumulusId3),
  ];

  const actualGranuleCumulusIds = await getApiGranuleExecutionCumulusIdsByExecution(knex,
    executionRecords);

  t.deepEqual(actualGranuleCumulusIds, expectedGranuleCumulusIds);
});
