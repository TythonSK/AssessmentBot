import { afterEach, describe, expect, it, vi } from 'vitest';
import { AveragingAnalyser } from './averagingAnalyser';
import {
  buildInput,
  createAssignmentPartial,
  createDefinitionPartial,
  createSubmission,
  createSubmissionItem,
  createTaskPartial,
} from '@/test/dataAnalysis/fixtures';
import { createAccumulator } from './averagingAnalyser.accumulatorRegistry';
import { resolveAggregateMetric } from './averagingAnalyser.metricResolution';
import {
  accumulateCriterion,
  accumulateMetricsToTarget,
} from './averagingAnalyser.criterionAccumulation';
import { expectMetricResultStateAware } from '@/test/dataAnalysis/averagingAnalyserAssertions';

afterEach(() => {
  vi.restoreAllMocks();
});

/**
 * Analyse a minimal single-task fixture with the requested live weights.
 *
 * @param {Object} options - Task-analysis fixture options.
 * @param {number} [options.assignmentWeighting=1] - Live assignment weighting.
 * @param {number} [options.taskWeighting=1] - Live task weighting.
 * @param {Array<number | 'N'>} options.scores - Assessment scores to analyse.
 * @returns {ReturnType<AveragingAnalyser['analyse']>[number]} The analysed class result.
 */
function analyseSingleTask(options: {
  assignmentWeighting?: number;
  taskWeighting?: number;
  scores: Array<number | 'N'>;
}) {
  const { assignmentWeighting = 1, taskWeighting = 1, scores } = options;
  const submissions = scores.map((score, index) => {
    const item = createSubmissionItem('t_001', {
      completeness: { score },
      accuracy: { score },
      spag: { score },
    });
    return createSubmission(`s_${index}`, `Student ${index}`, 'a_001', { t_001: item });
  });
  const analyser = new AveragingAnalyser();
  const input = buildInput(
    [
      {
        classId: 'c_001',
        studentIds: scores.map((_, index) => `s_${index}`),
        assignments: [
          createAssignmentPartial({
            assignmentId: 'a_001',
            definitionKey: 'dk_zero_weight',
            assignmentWeighting,
            tasks: [createTaskPartial('t_001', taskWeighting)],
            submissions,
          }),
        ],
      },
    ],
    {
      assignmentDefinitionPartials: [
        createDefinitionPartial({
          definitionKey: 'dk_zero_weight',
          assignmentWeighting,
          tasks: [createTaskPartial('t_001', taskWeighting)],
        }),
      ],
    }
  );
  return analyser.analyse(input)[0];
}

/**
 * Analyse a submission containing a known task and a task absent from the
 * live assignment-definition partial.
 *
 * @returns {ReturnType<AveragingAnalyser['analyse']>[number]} The analysed class result.
 */
function analyseWithUnknownSubmissionTask() {
  const assignment = createAssignmentPartial({
    assignmentId: 'a_001',
    definitionKey: 'dk_unknown_task',
    submissions: [
      createSubmission('s_001', 'Alice', 'a_001', {
        t_known: createSubmissionItem('t_known', {
          completeness: { score: 2 },
          accuracy: { score: 2 },
          spag: { score: 2 },
        }),
        t_unknown: createSubmissionItem('t_unknown', {
          completeness: { score: 10 },
          accuracy: { score: 10 },
          spag: { score: 10 },
        }),
      }),
    ],
  });
  const input = buildInput(
    [
      {
        classId: 'c_001',
        studentIds: ['s_001'],
        assignments: [assignment],
      },
    ],
    {
      assignmentDefinitionPartials: [
        createDefinitionPartial({
          definitionKey: 'dk_unknown_task',
          tasks: [createTaskPartial('t_known')],
        }),
      ],
    }
  );

  return new AveragingAnalyser().analyse(input)[0];
}

describe('resolveAggregateMetric', () => {
  it('returns computed for an applicable numeric accumulation', () => {
    const accumulator = createAccumulator();
    accumulator.weightedSum = 5;
    accumulator.totalWeight = 1;
    accumulator.applicableDataPoints = 1;
    accumulator.totalDataPoints = 1;

    expectMetricResultStateAware(resolveAggregateMetric(accumulator), {
      state: 'computed',
      value: 5,
      totalWeight: 1,
      applicableDataPoints: 1,
      totalDataPoints: 1,
    });
  });

  it('returns notAttempted when nCount is positive without numeric data', () => {
    const accumulator = createAccumulator();
    accumulator.nCount = 1;
    accumulator.totalWeight = 1;
    accumulator.totalDataPoints = 1;

    expectMetricResultStateAware(resolveAggregateMetric(accumulator), {
      state: 'notAttempted',
      totalWeight: 1,
      totalDataPoints: 1,
    });
  });

  it('retains zero-weight numeric observations in a computed aggregate total', () => {
    const accumulator = createAccumulator();
    accumulateCriterion(accumulator, 4, 1);
    accumulateCriterion(accumulator, 10, 0);

    expectMetricResultStateAware(resolveAggregateMetric(accumulator), {
      state: 'computed',
      value: 4,
      totalWeight: 1,
      applicableDataPoints: 1,
      totalDataPoints: 2,
    });
  });

  it('retains zero-weight raw N observations in a notAttempted aggregate total', () => {
    const accumulator = createAccumulator();
    accumulateCriterion(accumulator, 'N', 1);
    accumulateCriterion(accumulator, 'N', 0);

    expectMetricResultStateAware(resolveAggregateMetric(accumulator), {
      state: 'notAttempted',
      totalWeight: 1,
      totalDataPoints: 2,
    });
  });

  it('returns error when there is no numeric or not-attempted evidence', () => {
    expectMetricResultStateAware(resolveAggregateMetric(createAccumulator()), {
      state: 'error',
      totalWeight: 0,
      totalDataPoints: 0,
    });
  });

  it('prefers computed when numeric and not-attempted evidence are mixed', () => {
    const accumulator = createAccumulator();
    accumulator.weightedSum = 3;
    accumulator.totalWeight = 1;
    accumulator.applicableDataPoints = 1;
    accumulator.totalDataPoints = 2;
    accumulator.nCount = 1;

    expectMetricResultStateAware(resolveAggregateMetric(accumulator), {
      state: 'computed',
      value: 3,
      totalWeight: 1,
      applicableDataPoints: 1,
      totalDataPoints: 2,
    });
  });
});

describe('accumulateMetricsToTarget nCount tracking', () => {
  it('tracks nCount for a raw N in each criterion and overall metric', () => {
    const target = {
      completeness: createAccumulator(),
      accuracy: createAccumulator(),
      spag: createAccumulator(),
      overall: createAccumulator(),
    };
    accumulateMetricsToTarget(target, 'N', 'N', 'N', null, 1);

    expectMetricResultStateAware(resolveAggregateMetric(target.completeness), {
      state: 'notAttempted',
      totalWeight: 1,
      totalDataPoints: 1,
    });
    expectMetricResultStateAware(resolveAggregateMetric(target.accuracy), {
      state: 'notAttempted',
      totalWeight: 1,
      totalDataPoints: 1,
    });
    expectMetricResultStateAware(resolveAggregateMetric(target.spag), {
      state: 'notAttempted',
      totalWeight: 1,
      totalDataPoints: 1,
    });
    expectMetricResultStateAware(resolveAggregateMetric(target.overall), {
      state: 'notAttempted',
      totalWeight: 0,
      totalDataPoints: 1,
    });
  });

  it('retains numeric evidence while tracking N in the other criteria', () => {
    const target = {
      completeness: createAccumulator(),
      accuracy: createAccumulator(),
      spag: createAccumulator(),
      overall: createAccumulator(),
    };
    accumulateMetricsToTarget(target, 4, 'N', 'N', null, 1);

    expectMetricResultStateAware(resolveAggregateMetric(target.completeness), {
      state: 'computed',
      value: 4,
      totalWeight: 1,
      applicableDataPoints: 1,
      totalDataPoints: 1,
    });
    expectMetricResultStateAware(resolveAggregateMetric(target.accuracy), {
      state: 'notAttempted',
      totalWeight: 1,
      totalDataPoints: 1,
    });
    expectMetricResultStateAware(resolveAggregateMetric(target.overall), {
      state: 'notAttempted',
      totalWeight: 0,
      totalDataPoints: 1,
    });
  });
});

describe('AveragingAnalyser effective-weight rejection', () => {
  it.each([
    {
      caseName: 'a negative assignment weighting',
      assignmentWeighting: -1,
    },
    {
      caseName: 'a negative task weighting',
      taskWeighting: -1,
    },
  ])(
    'rejects $caseName before emitting analysis results',
    ({ assignmentWeighting, taskWeighting }) => {
      expect(() =>
        analyseSingleTask({ assignmentWeighting, taskWeighting, scores: [5] })
      ).toThrow();
    }
  );
});

describe('AveragingAnalyser zero-weight display and contribution boundaries', () => {
  it('retains numeric task display while excluding a zero-weight assignment from aggregates', () => {
    const result = analyseSingleTask({ assignmentWeighting: 0, scores: [5] });

    expect(result.perStudentTaskMetrics![0].completeness).toMatchObject({
      state: 'computed',
      value: 5,
      totalWeight: 0,
    });
    expect(result.perStudentTaskMetrics![0].averageContribution).toEqual({
      effectiveWeight: 0,
      includedInAverage: false,
    });
    expect(result.perClass.completeness).toMatchObject({
      state: 'excluded',
      value: null,
      totalWeight: 0,
      totalDataPoints: 1,
    });
  });

  it('retains numeric task display while excluding a zero-weight task from aggregates', () => {
    const result = analyseSingleTask({ taskWeighting: 0, scores: [4] });

    expect(result.perTask[0].accuracy).toMatchObject({ state: 'computed', value: 4 });
    expect(result.perClass.accuracy).toMatchObject({ state: 'excluded', value: null });
  });

  it('keeps a raw N as notAttempted at zero weight without creating an aggregate penalty', () => {
    const result = analyseSingleTask({ taskWeighting: 0, scores: ['N'] });

    expect(result.perStudentTaskMetrics![0].completeness).toMatchObject({
      state: 'notAttempted',
      value: 'N',
      totalWeight: 0,
    });
    expect(result.perClass.completeness).toMatchObject({ state: 'excluded', value: null });
  });

  it('preserves the positive-weight raw N control case', () => {
    const result = analyseSingleTask({ scores: ['N'] });

    expect(result.perStudentTaskMetrics![0].completeness).toMatchObject({
      state: 'notAttempted',
      value: 'N',
      totalWeight: 1,
    });
    expect(result.perClass.completeness).toMatchObject({ state: 'notAttempted', value: 'N' });
  });

  it('excludes zero-weight numeric observations from the mixed numerator and denominator', () => {
    const assignment = createAssignmentPartial({
      assignmentId: 'a_001',
      definitionKey: 'dk_mixed',
      tasks: [createTaskPartial('positive'), createTaskPartial('zero', 0)],
      submissions: [
        createSubmission('s_001', 'Alice', 'a_001', {
          positive: createSubmissionItem('positive', { completeness: { score: 2 } }),
          zero: createSubmissionItem('zero', { completeness: { score: 10 } }),
        }),
      ],
    });
    const input = buildInput(
      [
        {
          classId: 'c_001',
          studentIds: ['s_001'],
          assignments: [assignment],
        },
      ],
      {
        assignmentDefinitionPartials: [
          createDefinitionPartial({
            definitionKey: 'dk_mixed',
            tasks: [createTaskPartial('positive'), createTaskPartial('zero', 0)],
          }),
        ],
      }
    );
    const result = new AveragingAnalyser().analyse(input)[0];

    expect(result.perClass.completeness).toMatchObject({
      state: 'computed',
      value: 2,
      totalWeight: 1,
      totalDataPoints: 2,
    });
    // The zero-weight score must remain visible at display scope.
    expect(result.perTask.find((task) => task.taskId === 'zero')?.completeness).toMatchObject({
      state: 'computed',
      value: 10,
    });
  });

  it('uses an unweighted mean for multiple zero-weight numeric display observations', () => {
    const result = analyseSingleTask({ taskWeighting: 0, scores: [2, 8] });

    expect(result.perStudentTaskMetrics).toHaveLength(2);
    expect(result.perTask[0].completeness).toMatchObject({ state: 'computed', value: 5 });
    expect(result.perClass.completeness).toMatchObject({ state: 'excluded', totalDataPoints: 2 });
  });
});

describe('unknown submission task IDs', () => {
  it('drops a task absent from the live partial without inflating the class average', () => {
    const result = analyseWithUnknownSubmissionTask();

    expect(result.perClass.completeness).toMatchObject({
      state: 'computed',
      value: 2,
      totalWeight: 1,
      totalDataPoints: 1,
    });
    expect(result.perTask.map((task) => task.taskId)).toEqual(['t_known']);
    expect(result.perStudentTaskMetrics?.map((metric) => metric.taskKey)).toEqual([
      'dk_unknown_task::t_known',
    ]);
  });

  it('logs a warn with the unknown task identity before dropping the item', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    analyseWithUnknownSubmissionTask();

    expect(warnSpy).toHaveBeenCalledWith(
      'processAssignment',
      expect.objectContaining({
        level: 'warn',
        context: 'processAssignment',
        errorMessage: expect.stringContaining('t_unknown'),
        metadata: expect.objectContaining({
          definitionKey: 'dk_unknown_task',
          taskId: 't_unknown',
        }),
      })
    );
  });
});

describe('repeated submission task accumulation', () => {
  it('retains every student observation and re-resolves live weights on the next analysis', () => {
    const definition = createDefinitionPartial({
      definitionKey: 'dk_repeated_task',
      tasks: [createTaskPartial('t_001')],
    });
    // A focused weight-change boundary with the same task repeated across students.
    const input = buildInput(
      [
        {
          classId: 'c_001',
          studentIds: ['s_001', 's_002'],
          assignments: [
            createAssignmentPartial({
              assignmentId: 'a_001',
              definitionKey: definition.definitionKey,
              submissions: [2, 8].map((score, index) => {
                return createSubmission(`s_00${index + 1}`, `Student ${index}`, 'a_001', {
                  t_001: createSubmissionItem('t_001', { completeness: { score } }),
                });
              }
              ),
            }),
          ],
        },
      ],
      { assignmentDefinitionPartials: [definition] }
    );
    const analyser = new AveragingAnalyser();
    const positive = analyser.analyse(input)[0];

    expect(positive.perClass.completeness).toMatchObject({
      state: 'computed',
      value: 5,
      totalWeight: 2,
      totalDataPoints: 2,
    });
    expect(positive.perStudentTaskMetrics).toHaveLength(2);
    for (const metric of positive.perStudentTaskMetrics!) {
      expect(metric.averageContribution).toEqual({
        effectiveWeight: 1,
        includedInAverage: true,
      });
    }

    input.assignmentDefinitionPartials[0].tasks[0].taskWeighting = 0;
    const zero = analyser.analyse(input)[0];

    expect(zero.perClass.completeness).toMatchObject({
      state: 'excluded',
      totalWeight: 0,
      totalDataPoints: 2,
    });
    expect(zero.perTask[0].completeness).toMatchObject({ state: 'computed', value: 5 });
    expect(zero.perStudentTaskMetrics).toHaveLength(2);
    for (const metric of zero.perStudentTaskMetrics!) {
      expect(metric.averageContribution).toEqual({
        effectiveWeight: 0,
        includedInAverage: false,
      });
    }
  });

  it('warns for every unknown task item even when students repeat the same task ID', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const input = buildInput(
      [
        {
          classId: 'c_001',
          studentIds: ['s_001', 's_002'],
          assignments: [
            createAssignmentPartial({
              assignmentId: 'a_001',
              definitionKey: 'dk_unknown_task',
              submissions: ['s_001', 's_002'].map((studentId) => {
                return createSubmission(studentId, studentId, 'a_001', {
                  t_unknown: createSubmissionItem('t_unknown', { completeness: { score: 10 } }),
                });
              }
              ),
            }),
          ],
        },
      ],
      {
        assignmentDefinitionPartials: [
          createDefinitionPartial({
            definitionKey: 'dk_unknown_task',
            tasks: [createTaskPartial('t_known')],
          }),
        ],
      }
    );

    const result = new AveragingAnalyser().analyse(input)[0];

    expect(warnSpy).toHaveBeenCalledTimes(2);
    expect(warnSpy).toHaveBeenNthCalledWith(
      2,
      'processAssignment',
      expect.objectContaining({
        metadata: { definitionKey: 'dk_unknown_task', taskId: 't_unknown' },
      })
    );
    expect(result.perStudentTaskMetrics).toEqual([]);
    expect(result.perTask.map((task) => task.taskId)).toEqual(['t_known']);
  });
});
