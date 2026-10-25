# Data Analysis Architecture

## Status

**Implemented analysis pipeline.** This document records the zero-weight
assessment architecture and shared analysis boundaries. The metadata task and
queued writer below are complete and independently review-clean with zero new
regressions. The shared post-commit lifecycle, query invalidation and feedback are
independently review-clean (5B/5C), and the consumer wiring passed independent 5D
review. Both averaging surfaces call the shared page hook directly. The narrow standalone
keyboard seam was diagnosed and fixed in the shared E2E helper, and the full
**303**-test browser run passed. The Section 5 regression comparison recorded zero
regressions and zero new failures. Section 6 test-only Node dispatcher and browser
changed-write/failure-feedback coverage is complete and independently review-clean
(`.opencode/scratchpad/review-section6-independent.md`). Its regression comparison
(`.ts-regression-checker/reports/session-frontend-abclass-metadata/runs/2026-10-21T00-43-04.269Z/comparison.txt`)
recorded zero regressions and zero new failures. Section 7 documentation
reconciliation is complete and the final independent review is clean
(`.opencode/scratchpad/review-final-frontend-abclass-metadata.md`). The aggregate
gate is not green: the unchanged baseline blocks on the six backend `max-lines`
lint warnings and backend branch coverage at 84.35% against the 85% gate, both
pre-existing and not new regressions.

## Purpose

The data-analysis domain must preserve two independent facts about an assessed
observation:

1. its **display evidence** (the score a teacher should see); and
2. its **average contribution** (whether and how it changes an aggregate).

A zero effective weight changes the second fact only; it does not turn an
assessed numeric score into `N` or `E`.

This architecture mirrors the agreed behaviour in [`SPEC.md`](../../../docs/plans/issue-305/SPEC.md).
The canonical contract is
[`frontend-data-analysis-response.md`](../data-shapes/frontend-data-analysis-response.md).

## Boundaries and ownership

| Layer                                                                                                                                                                                       | Owned responsibility                                                                                                                                | Must not own                                   |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| Assignment-definition partials                                                                                                                                                              | Authoritative live assignment and task weightings                                                                                                   | Analysis display state                         |
| `resolveAssignmentDefinition.ts`                                                                                                                                                            | Active production resolver for live assignment/task weighting inputs                                                                                | UI metadata or metric-state presentation       |
| `averagingAnalyser.accumulation.ts` (orchestration facade) plus the extracted `accumulatorRegistry`, `criterionAccumulation`, `metricResolution`, `taskProjection`, and `composite` modules | Resolve definitions via `resolveAssignmentDefinitionData`, build each `TaskWeightingIndex`, and accumulate positive-weight contributions separately | React, Ant Design, persistence, or transport   |
| `averagingAnalyser.rows.ts` / `rollupMetric.ts`                                                                                                                                             | Build task, student, and class rows; apply aggregate-state precedence                                                                               | Re-resolving assignment-definition data        |
| `dataAnalysis.zod.ts`                                                                                                                                                                       | Validate public analyser input and output                                                                                                           | Heatmap layout decisions                       |
| `heatmapAdapter*.ts`                                                                                                                                                                        | Project analyser results and live definitions into heatmap view models                                                                              | Duplicate accumulation or weighting resolution |
| `metricDisplay/`                                                                                                                                                                            | Shared metric state labels, tones, filtering, and ordering                                                                                          | Feature-specific table layout                  |
| `features/taskHeatmap/`                                                                                                                                                                     | Render adapter-provided data, including zero-weight explanation and marker                                                                          | Infer contribution from a displayed score      |

## Effective weighting and dual accumulation

For each observation, the analyser resolves:

```text
effectiveWeight = live assignment weighting × live task weighting
includedInAverage = effectiveWeight > 0
```

`resolveAssignmentDefinitionData` in `resolveAssignmentDefinition.ts` is the
active production resolver. It reads the live partial, normalises a `null`
assignment weighting to `1`, and returns the live task list; task weighting is
required by `TaskPartial`, so it never supplies a task-weight default.

`createTaskWeightingIndex` pre-indexes that resolved definition into a
`TaskWeightingIndex`. Both analyser accumulation and heatmap column projection
(`buildTaskColumns`, shared by the embedded and merged adapters) then call the
shared `computeEffectiveWeight(weightingIndex, taskId)` in
`services/assignmentDefinition/assignmentDefinitionUtilities.ts`, which returns
the effective-weight product or `undefined` when the task is absent. The
analyser warns and drops a submission `taskId` that is absent from the live
partial rather than granting it a task-weight default.

Each criterion's `MetricAccumulator` (defined in `averagingAnalyser.types.ts`,
created by `averagingAnalyser.accumulatorRegistry.ts`) retains two accumulators:

- **display accumulator** (`displaySum`, `displayCount`, `displayNCount`,
  `displayTotalDataPoints`): consumes every assessed numeric score regardless of
  effective weighting. For multiple zero-weight numeric observations resolving
  to one task result, it returns their unweighted arithmetic mean.
- **contribution accumulator** (`weightedSum`, `totalWeight`,
  `applicableDataPoints`, `totalDataPoints`, `nCount`): consumes only
  observations with a positive effective weight. It supplies aggregate
  numerator, denominator, and genuine positive-weight `N` handling.

`averagingAnalyser.criterionAccumulation.ts` updates both accumulators.
`averagingAnalyser.accumulation.ts` is the thin assignment-processing facade; it
resolves each live partial through `resolveAssignmentDefinitionData`, builds its
`TaskWeightingIndex` once per definition, calls the shared
`computeEffectiveWeight` helper, and records the definition-scoped
`averageContribution` metadata via `ensureAverageContribution`.

Within each `processAssignment` call, a lazy local cache resolves the effective
weight, task key and task accumulator once per encountered known task, then
reuses them across student submissions. The cache is recreated for each call,
so it does not retain weighting data between assignments or analysis runs.
Unknown submission task IDs are not cached; each occurrence is still warned
and dropped before contribution processing.

Raw `N` remains a property of the source assessment. It retains its existing
positive-weight aggregation semantics and is never manufactured because a
weight is zero. A numeric zero-weight observation contributes neither a
numerator nor denominator and cannot create a not-attempted penalty.

## Public result rules

`MetricResult` has four states: `computed`, `notAttempted`, `excluded`, and
`error`. The shared four-state union is `MetricResultSchema`; task-level shapes
use the narrower, exported `TaskDisplayMetricSchema` and its inferred
`TaskDisplayMetric` type (computed, notAttempted, error), both in
`dataAnalysis.zod.ts`.

- Task-level displays use their display evidence and therefore keep numeric
  zero-weight scores and genuine raw `N` values visible.
- Aggregate rows use contribution evidence only.
- An aggregate with observations but no positive-weight contribution resolves
  to `excluded` unless all observations are errors.
- Aggregate precedence is: all errors → `error`; any computed contribution →
  `computed`; any positive-weight raw `N` → `notAttempted`; otherwise →
  `excluded`.

`resolveAggregateMetric` (`averagingAnalyser.metricResolution.ts`) applies this
precedence to accumulator state. `resolveDisplayMetric` in the same module
returns the schema-derived `TaskDisplayMetric`, so task projection and heatmap
cells cannot carry aggregate-only `excluded`. Task-preview data carries that same
`TaskDisplayMetric` on its single `metric` field and so cannot carry
aggregate-only `excluded` either.

Task-level shapes (`PerStudentTaskMetric` and `PerTaskRow`) and heatmap task
column descriptors expose:

```ts
averageContribution: {
  effectiveWeight: number;
  includedInAverage: boolean;
}
```

The field is derived from live definition data. It is never inferred from a
metric value. `includedInAverage` is true exactly when `effectiveWeight > 0`.

## Presentation flow

### Single-assignment summaries (#277)

`DataAnalysisService.analyseAssignmentSummary` validates the existing source
input and the separate `AssignmentSummarySchema` output. Its pure
`AssignmentSummaryAnalyser` scopes the source class to the requested assignment
before reusing `AveragingAnalyser` display results. This matters because the
existing definition-scoped task keys intentionally omit assignment instances.
The global averaging and heatmap projections are unchanged.

The analyser counts roster students by completeness state, computes numeric-only
per-task accuracy means, classifies thresholds, and returns all ranking ties.
These descriptive summaries retain zero-weight display evidence, and expose
sample counts and errors rather than silently treating missing grades as zero.

`assignmentSummaryAdapter.ts` resolves task labels from heatmap columns and
formats display text. `TaskHeatmapSummaryCards` renders two Ant Design cards
above the table in `TaskHeatmapPage`. Neither layer calculates counts,
averages or rankings. Summaries use loaded class data and do not depend on the
assignment-preview query or local table filters.

Each card initially shows up to three tasks, prioritising those requiring
attention while preserving task order within each group. Show all / Show less
controls expose the remaining tasks independently for each card. Information
buttons explain the thresholds and summary groups; N values remain distinct
from assessment errors. Error counts appear in red only when non-zero.

The standalone Heatmaps builder also renders these cards above the table.
`useHeatmapSelectionSummary` connects the selected assignment to the analysis
service and presentation adaptor. A single selected assignment displays its
summaries; multiple selected assignments display a notice in each card asking
the user to select one assignment. This also applies to assignments sharing a
definition. The existing merged heatmap remains unchanged. SPaG summaries are
outside this first-version scope.

Summary analysis or adaptor failures preserve the valid heatmap and replace only
the summary cards with a local `Alert` titled 'The summary could not be built'.
Diagnostics use the existing `logPipelineError` helper with contexts
`TaskHeatmapPage.summary` and `useHeatmapSelectionSummary`, keyed by context,
normalised message and `classId`/`assignmentId` metadata.
Its bounded 256-key cache deduplicates identical errors across recomputations and
remounts while logging distinct errors.

### Existing heatmap projection

1. `heatmapAdapter.ts` and `heatmapAdapter.merged.ts` attach the authoritative
   `averageContribution` metadata to each task-column descriptor.
2. `TaskHeatmapTable` consumes this metadata without resolving definition data
   itself.
3. `features/taskHeatmap/taskHeatmapZeroWeightHeader.tsx` selects the
   zero-effective-weight header presentation: a non-actionable, focusable
   Tooltip on the task title plus the group-edge classes
   (`.task-heatmap-zero-weight-group`, `-first`, `-last`), defined as
   theme-aware inset 2px box-shadows in `src/frontend/src/index.css` and applied
   by `taskHeatmapTableColumns.tsx`. Score-band backgrounds are unchanged.
4. Shared metric-display modules give aggregate `excluded` a distinct label,
   accessible name, neutral tone, filter option, and state sort rank.
5. Class page aggregate consumers pass `excluded` through their adapter and
   render it through the shared metric-display vocabulary; the Student Averages
   table and Recent Assignment cards are the visible aggregate surfaces. The
   card adapter's per-assignment roll-up is contribution-aware and must resolve
   an all-zero-weight assignment to `excluded`, rather than throw.
6. The Class-page adapter's existing synthesised no-data `N` is a local
   presentation placeholder, not a data-analysis metric. Its narrow adapter
   validation union permits only that zero-data shape without weakening the
   shared raw-`N` contract or reclassifying it as `excluded`.

The complete user-interface contract is in
[`TASK_HEATMAP_ZERO_WEIGHT_LAYOUT.md`](../../../TASK_HEATMAP_ZERO_WEIGHT_LAYOUT.md).

## Delivered modular boundaries

Dual accumulation was added after extracting coherent, analyser-local
responsibilities out of the former 509-line `averagingAnalyser.accumulation.ts`.
The delivered analyser package is:

| Module                                       | Responsibility                                                                                                                                                                                                                          |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `averagingAnalyser.accumulation.ts`          | Assignment-processing orchestration facade; resolves definitions via `resolveAssignmentDefinitionData`, builds each `TaskWeightingIndex`, consumes shared effective weights, warns on unknown tasks, and records contribution metadata. |
| `averagingAnalyser.filters.ts`               | Assignment selection by date range, topic keys, and definition keys, including the missing-definition-partial warning.                                                                                                                  |
| `averagingAnalyser.accumulatorRegistry.ts`   | Accumulator factories and registry accessors, including the conflicting-weight invariant in `ensureAverageContribution`.                                                                                                                |
| `averagingAnalyser.criterionAccumulation.ts` | Criterion-level display/contribution accumulation and per-item overall computation.                                                                                                                                                     |
| `averagingAnalyser.metricResolution.ts`      | `resolveAggregateMetric` (contribution precedence) and `resolveDisplayMetric` (display evidence).                                                                                                                                       |
| `averagingAnalyser.taskProjection.ts`        | `buildPerStudentTaskMetrics`, using the narrow schema-derived task-display metric type.                                                                                                                                                 |
| `averagingAnalyser.composite.ts`             | `computeOverallComposite` (40/40/20 weighting with SPaG renormalisation and overall aggregate precedence).                                                                                                                              |
| `rollupMetric.ts`                            | Single shared roll-up precedence for task-display `MetricResult` values.                                                                                                                                                                |
| `averagingAnalyser.rows.ts`                  | Per-student and per-task row builders; a per-task composite that would resolve to `excluded` falls back to the task's display overall.                                                                                                  |
| `averagingAnalyser.types.ts`                 | Shared accumulator and assessment-score types.                                                                                                                                                                                          |
| `averagingAnalyser.ts`                       | Public analyser entry point.                                                                                                                                                                                                            |
| `resolveAssignmentDefinition.ts`             | Active production resolver for live assignment/task weighting inputs; supplies the resolved definition consumed by createTaskWeightingIndex.                                                                                            |

Definition-scoped task identities are built only by
`services/dataAnalysis/taskKey.ts`; analyser registries, heatmap projection,
and cell-preview lookup all consume `buildTaskKey(definitionKey, taskId)`.

The task-heatmap presentation was kept feature-local. Zero-weight header
rendering and group-edge class construction live in
`features/taskHeatmap/taskHeatmapZeroWeightHeader.tsx`
(`buildTaskHeaderPresentation`, `getZeroWeightMetricEdgeClass`), consumed by
`taskHeatmapTableColumns.tsx`, which remains the column-construction
composition facade. The edge classes are defined in `src/frontend/src/index.css`.

## Metadata refresh task and persistence

The synchronous `DataAnalysisService` and pure analysers remain free of I/O.
`postAnalysis/refreshABClassMetadata.ts` accepts the shared `PostAnalysisContext`
from `postAnalysis.zod.ts` — successful averaging context plus unsliced class data —
and never persists display results or display weightings. It declares no narrowed
task-local context type, so task input and lifecycle validation share one contract.
It is the only descriptor built by `createPostAnalysisTaskDescriptors` in
`postAnalysis/postAnalysisTasks.ts`. The generic context/outcome schemas, ordered runner and shared
`hooks/usePostAnalysisTasks.ts` passed independent 5B and 5C reviews.
Both averaging surfaces call the shared page hook `hooks/usePagePostAnalysisTasks.ts`. It passes the complete
unsliced class, live definition partials and the successful averaging result, or
`null` when the surface is not ready, and always forwards the committed class ID. On the standalone Heatmaps surface the
selected assignments drive display only; metadata calculation always uses every
class assignment. The task never writes descriptive summary results. The narrow
standalone keyboard seam was diagnosed and fixed in the E2E helper, and the full
**303**-test browser run passed. Independent 5D review and the Section 5 regression
comparison are complete, with zero regressions and zero new failures. Section 6
adds test-only Node dispatcher and browser changed-write/failure-feedback coverage;
it is complete and independently review-clean, with zero new regressions.

`postAnalysis/metadataProjection.ts` owns pure freshness, score projection and
rolling merge. Every candidate source timestamp must be canonical UTC; newest
selection breaks equal-time ties by assignment ID ascending. Empty classes,
equal stored target ID/time and sources older than stored recent history skip;
skip reasons are compile-time pinned to `MetadataRefreshSkipped`, so the outcome
schema cannot silently omit a reason. This is an **assignment-version cache**, not
an assessment-completion signal:
scores, live weighting, definitions or roster changes alone do not refresh an
unchanged timestamp. No polling or backfill exists.

For changed candidates, `services/abClass/abClassMetadataService.ts` reserves the
existing `classesBulkMutation` lane (`CLASSES_BULK_MUTATION_JOB_NAME`, exported by
`abClassMutationService.ts`) before a fresh validated `getABClass` read.
It bypasses query cache, reselects the target and repeats the gate. Missing
classes fail rather than being recreated. All fresh assignments must resolve
against the supplied live definition partials before calculation.

The writer recalculates the complete fresh class with standard 40/40/20 weights
and no display filters, then analyses exactly one target assignment in isolation.
Instance isolation prevents shared definition keys from merging target evidence.
It projects weighted overall directly without rounding, preserving numbers,
`N`, `E` and `excluded`. Initial null metadata gets complete class averages and
one recent entry; subsequent writes replace the same instance or append one,
stably sort newest first and keep three. Equal-time entries retain their positions.
The merged replacement validates through `NonNullableABClassMetadataSchema`, so the
write path has no nullable-union branch. Source time is copied exactly; the supplied
summary clock is read only after successful calculations when preparing a changed write.

The update contains only `classId` and complete metadata, reuses the mutation
schema and parses the actual class-partial response. In-slot network execution
uses `callApi`, never a nested queued wrapper. The reservation covers the whole
read/recheck/calculate/merge/write: concurrent owners in this session see prior
writes on their next fresh read, preserving rolling history and skipping duplicate
versions. It is **not a cross-session lock**. Failures propagate and release the
lane; no task retry, rollback or production data repair is added.

Successful writer tests currently use explicit historical-source boundary clones;
untouched newest canonical instances expose an existing analyser null-name
rejection. See [Synthetic Test Data](../testing/synthetic-test-data.md#metadata-refresh-analysis-boundaries)
for the exact limitation and evidence scope, not a claim of newest-corpus success.

## Shared post-analysis lifecycle and extension

`hooks/usePostAnalysisTasks.ts` is the canonical shared extension point for both
averaging surfaces, not a metadata-specific effect. Import actual owners directly;
do not introduce a frontend facade or barrel. The hook validates the successful
context after commit: complete unsliced class, live definition partials and a
matching-class averaging result. Pass null when there is no successful context;
descriptive summaries remain read-only. The required third argument is the committed
selected class ID, which owns feedback lifetime independently of that readiness.

`hooks/usePagePostAnalysisTasks.ts` owns the page-level eligibility gate shared by
both surfaces. It forms and memoises the context only when the surface is `ready` and
the complete class, live definitions and successful averaging result are all non-null;
otherwise it passes `null`. It creates the descriptor list once per mount with a
mount-scoped clock and forwards the committed selected class ID unchanged. Feature
hooks call it directly and do not build their own context, descriptor list or status
alias.

Both feature hooks call `usePagePostAnalysisTasks` directly:
`features/classPage/useClassPageData.ts` and
`features/taskHeatmap/useHeatmapsPageData.ts` pass their surface status, complete
unsliced class, live definition partials, successful averaging result and committed
class ID. The page hook owns the context memo and the once-per-mount descriptor list,
so ordinary rerenders keep the same context and task-list references. Never rebuild
the context object per render: an unstable object re-attaches the effect each render
and was observed in a browser run to produce an attach/publish loop once cache
updates landed. The memo is the loop guard; metadata freshness is not a global
eligibility gate for other tasks.

`runPostAnalysisTasks.ts` accepts a readonly ordered descriptor list, rejects empty
or duplicate IDs before execution (an empty list is valid), and awaits each task
in order. Each task owns eligibility. A thrown/rejected task or invalid outcome
becomes an individually failed outcome; later independent tasks still run. Errors
are normalised/logged through existing helpers, with transport correlation when
available. Serialisable outcome data stays separate from local `Error` and
callback handles; none of these execution handles is sent to GAS.

The hook remembers attempt promises by task ID and optional `getAttemptKey(context)`
for the entire mount, including class navigation and failures. Without that key,
the original successful context object's identity is the attempt key. StrictMode
replay reattaches to pending promises rather than dropping completion or starting
duplicate work. Cleanup suppresses stale state publication; it does not abort
active work, cancel queued writes or prevent later descriptors in that work from
finishing.

Metadata source identity is shared rather than reimplemented per consumer.
`compareAssignmentNewestFirst` in `metadataProjection.ts` orders canonical
assignments newest first with ascending assignment ID as the equal-time
tie-break; canonical target selection and metadata diagnostics use it.
`sourceVersionSignature` in `postAnalysisTasks.ts` performs no sorting. It
serialises the supplied assignment ID/time pairs, retaining raw values and input
order, and `REFRESH_AB_CLASS_METADATA_TASK_ID` is the single task-ID constant used by
the descriptor, feedback, invalidation and diagnostics. The metadata descriptor keys
class plus the newest canonical assignment's source signature. When source timestamps
are not canonical, the task-owned signature keeps the raw assignment ID/time identity
so validation fails inside that task without blocking independent work. Diagnostics
reuse the comparator only for canonical candidates after their own non-throwing
validity filter. The same version is attempted once per mount even
after failure; a new source key or remount permits another attempt. This is not a
global freshness gate for future tasks. The descriptor factory receives the clock
and builds descriptors without reading it; only preparing a changed metadata write
reads that clock. Confirmed saves become
`succeeded` with `confirmedPersistence: true` before the hook completes required
invalidation. The cached attempt includes both refresh settlements, so replay and
metadata-only cache changes repeat neither the write nor invalidation.

`hooks/postAnalysisInvalidation.ts` invalidates detail and list after confirmed
metadata persistence only. A refresh failure becomes a failed outcome retaining
`confirmedPersistence: true` and a separate local Error; later independent tasks
still run. See the [query contract](frontend-react-query-and-prefetch.md#post-analysis-metadata-invalidation).

`hooks/postAnalysisFeedback.ts` owns metadata warnings independently of effect
reattachment and analysis readiness. Notification keys include mounted owner, class,
task and source. Dismissal memory lasts the mount; a new source can notify again.
Same-class reattachment neither destroys an undismissed notice nor reopens a dismissed
one. Ownership follows the committed selected class: a readiness-driven `null` context
for that class neither destroys notices nor suppresses a pending attempt, so a
confirmed-save warning appears once both required refreshes settle even if the surface
went blocking meanwhile. A class change or unmount destroys only owned notices and
suppresses feedback from previous visits; unmount disposal tolerates synchronous
StrictMode replay. Effect cleanup suppresses stale state publication only, and detached
work can still finish and invalidate queries. See the
[warning and diagnostic contract](frontend-logging-and-error-handling.md#post-analysis-metadata-failures).

### Register another task

Add a descriptor to `createPostAnalysisTaskDescriptors` in its intended order. For
example, after implementing a real task owner, registration has this shape
(illustrative only; no second production task is shipped):

```typescript
const descriptor: PostAnalysisTaskDescriptor = {
  id: 'newIndependentTask',
  run: runNewIndependentTask,
  getAttemptKey: getNewIndependentTaskSourceKey,
};
```

- Give the task a stable unique non-empty ID and a typed `run(context)` owner.
  Return a supported success/skip result or throw; do not swallow failures.
- Keep eligibility and source-key semantics in that task. Omit `getAttemptKey`
  only when each new successful context object should permit work. Do not reuse
  metadata freshness as another task's eligibility rule.
- Keep the descriptor list and context stable across ordinary rerenders. Add the
  descriptor to the shared factory, not separate feature effects or per-consumer lists.
- Register only independent work: ordering is not a dependency graph or retry
  policy. Reuse existing transport/queue and schema owners for persistence.
- Add runner and hook tests for ordering, failure isolation and the new task's
  key/eligibility contract. See [Frontend Testing](frontend-testing.md#shared-post-analysis-lifecycle-tests).

## Non-goals

- Changing stored weight values or their validation.
- Changing criterion weighting or SPaG renormalisation.
- Re-keying `perStudentTaskMetrics` by assignment instance.
- Adding a weight-editing workflow, a new route, endpoint, or persistence
  model.
