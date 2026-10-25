import { logFrontendEvent } from '@/logging/frontendLogger';
import type { AveragingAnalyserInput, AverageContribution } from '../dataAnalysis.zod';
import type { CriterionWeightings } from './averagingAnalyser';
import type { DataPointAccumulator } from './averagingAnalyser.types';
import { processItemAssessments } from './averagingAnalyser.criterionAccumulation';
import type { AssignmentDefinitionPartial } from '@/services/assignmentDefinition/assignmentDefinitionPartials.zod';
import {
  computeEffectiveWeight,
  createTaskWeightingIndex,
  type TaskWeightingIndex,
} from '@/services/assignmentDefinition/assignmentDefinitionUtilities';
import { buildTaskKey } from '../taskKey';
import {
  resolveAssignmentDefinitionData,
  type ResolvedAssignmentDefinition,
} from './resolveAssignmentDefinition';
import {
  ensureAverageContribution,
  getOrCreatePerStudentTaskAccum,
  getOrCreateStudentAccum,
  getOrCreateTaskAccum,
  preRegisterTasks,
} from './averagingAnalyser.accumulatorRegistry';

/**
 * Process a single assignment, accumulating its submission data.
 *
 * @param {AveragingAnalyserInput['classes'][number]['assignments'][number]}
 *   assignment - The assignment to process.
 * @param {TaskWeightingIndex} weightingIndex - Pre-indexed live weighting data.
 * @param {string} definitionKey - The assignment definition key.
 * @param {Map<string, { studentName: string | null } & DataPointAccumulator>}
 *   studentAccums - Per-student accumulators (mutated).
 * @param {Map<string, { definitionKey: string; taskId: string } & DataPointAccumulator>}
 *   taskAccums - Per-task accumulators (mutated).
 * @param {CriterionWeightings} criterionWeightings - The criterion weightings.
 * @param {Map<string, Map<string, DataPointAccumulator>>}
 *   perStudentTaskAccums - Per-(student, task) accumulators (mutated).
 * @param {Map<string, AverageContribution>} averageContributionByTaskKey -
 *   Contribution metadata keyed by `definitionKey::taskId` (mutated).
 */
export function processAssignment(
  assignment: AveragingAnalyserInput['classes'][number]['assignments'][number],
  weightingIndex: TaskWeightingIndex,
  definitionKey: string,
  studentAccums: Map<string, { studentName: string | null } & DataPointAccumulator>,
  taskAccums: Map<string, { definitionKey: string; taskId: string } & DataPointAccumulator>,
  criterionWeightings: CriterionWeightings,
  perStudentTaskAccums: Map<string, Map<string, DataPointAccumulator>>,
  averageContributionByTaskKey: Map<string, AverageContribution>
): void {
  const resolvedTasks = new Map<
    string,
    { effectiveWeight: number; taskKey: string; taskAccum: DataPointAccumulator }
  >();

  for (const submission of assignment.submissions) {
    const { studentId, studentName, items } = submission;
    const studentAccum = getOrCreateStudentAccum(studentAccums, studentId, studentName);

    for (const [taskId, item] of Object.entries(items)) {
      let resolvedTask = resolvedTasks.get(taskId);
      if (!resolvedTask) {
        const effectiveWeight = computeEffectiveWeight(weightingIndex, taskId);
        if (effectiveWeight === undefined) {
          logFrontendEvent('warn', {
            context: 'processAssignment',
            errorMessage: `Submission task '${taskId}' is absent from the live assignment definition; dropping the item`,
            metadata: { definitionKey, taskId },
          });
          continue;
        }

        ensureAverageContribution(
          averageContributionByTaskKey,
          definitionKey,
          taskId,
          effectiveWeight
        );

        resolvedTask = {
          effectiveWeight,
          taskKey: buildTaskKey(definitionKey, taskId),
          taskAccum: getOrCreateTaskAccum(taskAccums, definitionKey, taskId),
        };
        resolvedTasks.set(taskId, resolvedTask);
      }

      const { effectiveWeight, taskKey, taskAccum } = resolvedTask;
      const perStudentTaskAccum = getOrCreatePerStudentTaskAccum(
        perStudentTaskAccums,
        studentId,
        taskKey
      );

      processItemAssessments(
        item,
        effectiveWeight,
        studentAccum,
        taskAccum,
        criterionWeightings,
        perStudentTaskAccum
      );
    }
  }
}

type DefinitionLookup = {
  readonly tasks: ResolvedAssignmentDefinition['tasks'];
  readonly taskWeightingIndex: TaskWeightingIndex;
};

/**
 * Accumulate data points across all filtered assignments.
 *
 * @param {AveragingAnalyserInput['classes'][number]['assignments']}
 *   filteredAssignments - The in-scope assignments after filtering.
 * @param {AveragingAnalyserInput} input - Full analyser input.
 * @param {CriterionWeightings} criterionWeightings - The criterion weightings.
 * @returns {{
 *   studentAccums: Map<string, { studentName: string | null } & DataPointAccumulator>,
 *   taskAccums: Map<string, { definitionKey: string; taskId: string } & DataPointAccumulator>,
 *   perStudentTaskAccums: Map<string, Map<string, DataPointAccumulator>>,
 *   averageContributionByTaskKey: Map<string, AverageContribution>
 * }} The accumulator containers plus definition-scoped contribution metadata.
 *   `perStudentTaskAccums` feeds `rollupMetric` in the row builders;
 *   `averageContributionByTaskKey` supplies the required task-level
 *   `averageContribution` field for `PerTaskRow` and `PerStudentTaskMetric`.
 * @remarks Live partial lookup and nullable assignment-weight normalisation are
 *   delegated to `resolveAssignmentDefinitionData`. The resulting
 *   definition-scoped index feeds `computeEffectiveWeight`, shared with heatmap
 *   projection.
 */
export function accumulateDataPoints(
  filteredAssignments: AveragingAnalyserInput['classes'][number]['assignments'],
  input: AveragingAnalyserInput,
  criterionWeightings: CriterionWeightings
): {
  studentAccums: Map<string, { studentName: string | null } & DataPointAccumulator>;
  taskAccums: Map<string, { definitionKey: string; taskId: string } & DataPointAccumulator>;
  perStudentTaskAccums: Map<string, Map<string, DataPointAccumulator>>;
  averageContributionByTaskKey: Map<string, AverageContribution>;
} {
  const studentAccums = new Map<string, { studentName: string | null } & DataPointAccumulator>();

  const taskAccums = new Map<
    string,
    { definitionKey: string; taskId: string } & DataPointAccumulator
  >();

  const perStudentTaskAccums = new Map<string, Map<string, DataPointAccumulator>>();

  const averageContributionByTaskKey = new Map<string, AverageContribution>();

  const partialsByDefinitionKey = new Map<string, AssignmentDefinitionPartial>();
  for (const partial of input.assignmentDefinitionPartials) {
    partialsByDefinitionKey.set(partial.definitionKey, partial);
  }
  const definitionLookups = new Map<string, DefinitionLookup>();

  for (const assignment of filteredAssignments) {
    const definitionKey = assignment.assignmentDefinitionKey;
    let definitionLookup = definitionLookups.get(definitionKey);

    if (!definitionLookup) {
      const resolvedDefinition = resolveAssignmentDefinitionData(
        definitionKey,
        partialsByDefinitionKey
      );

      if (!resolvedDefinition) {
        logFrontendEvent('warn', {
          context: 'accumulateDataPoints',
          errorMessage: `No assignment definition partial found for definitionKey '${definitionKey}'`,
          metadata: { definitionKey },
        });
        continue;
      }

      definitionLookup = {
        tasks: resolvedDefinition.tasks,
        taskWeightingIndex: createTaskWeightingIndex(resolvedDefinition),
      };
      definitionLookups.set(definitionKey, definitionLookup);
    }

    const { tasks, taskWeightingIndex } = definitionLookup;
    preRegisterTasks(tasks, definitionKey, taskAccums);
    for (const task of tasks) {
      const effectiveWeight = computeEffectiveWeight(taskWeightingIndex, task.taskId);
      if (effectiveWeight === undefined) {
        throw new Error(
          `accumulateDataPoints: pre-registered task '${task.taskId}' is missing from definition '${definitionKey}'`
        );
      }
      ensureAverageContribution(
        averageContributionByTaskKey,
        definitionKey,
        task.taskId,
        effectiveWeight
      );
    }

    processAssignment(
      assignment,
      taskWeightingIndex,
      definitionKey,
      studentAccums,
      taskAccums,
      criterionWeightings,
      perStudentTaskAccums,
      averageContributionByTaskKey
    );
  }

  return {
    studentAccums,
    taskAccums,
    perStudentTaskAccums,
    averageContributionByTaskKey,
  };
}
