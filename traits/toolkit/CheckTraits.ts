import { Array, Effect, FileSystem, flow, Path, pipe, Schema as S, String } from "effect"
import { DecisionModel, Tool, Toolkit } from "effect/ai"
import { ChildProcessSpawner } from "effect/process"

import { getIncludedFiles, GitFileListingError } from "../getIncludedFiles.ts"
import { Source, SourceLocation } from "../Source.ts"
import * as Trait from "../Trait.ts"
import * as Evaluation from "../TraitEvaluation.ts"
import { excludeIgnored } from "../traitIgnores.ts"
import { TraitsContext } from "../TraitsContext.ts"
import { TraitStore, TraitStoreError } from "../TraitStore.ts"

export const CheckTraits = Tool.make("check_traits", {
  description: String.stripMargin(`
  | Use after generating or editing TypeScript files, after saving or resolving a relevant trait, and before committing or opening a PR.
  | Assess only project-owned source files and relevant authored configuration or documentation. Do not audit third-party or generated code.
  | For a whole-project review, prefer an explicit project-file manifest rather than a filesystem-wide glob.
  | Never submit secrets, .env files, credentials, binary assets, generated lockfiles, dependency trees, or reference repositories for assessment.
  | Supply include as TypeScript file paths or glob patterns relevant to the work, relative to the MCP working directory or absolute.
  | Globs are expanded and overlapping matches are checked once. Directories are not reviewed as files; use patterns such as traits/**/*.ts.
  | Built-in exclusions cover dependency trees, Git metadata, and nested worktrees. Configure project-specific exclusions through TraitsConfig.excludes.
  | Configured exclusions are filenames or native filesystem glob patterns, resolved beside traits.ts. Use directory/** to exclude a subtree; bare directories are not expanded.
  | Git-ignored files are excluded by default, with ignore rules refreshed on every call. Untracked files do not need to be added to Git to be evaluated. Tracked files remain eligible even if ignore rules match them. Set excludeGitignored: false in traits.ts to disable this filter; explicit excludes still apply. Git failures fail the check.
  | All entries follow native glob syntax, including escaping filenames with glob characters. No custom directory expansion or literal-path classification is applied.
  | Reads current full file contents, including unstaged edits, and checks each 200-line chunk against the selected traits in parallel.
  | Omit traitNames to check all stored traits; supply unique trait names for a focused check. Unknown names fail the call.
  | A leading // traits-ignore-file <trait-name>: <reason> comment skips that trait for the entire file, including focused checks. Names are case-sensitive and must be updated after renaming. Directives require a reason and must precede code.
  | Returns findings with the trait, source text, absolute path, 1-based chunk startLine, and assessment classification and probabilities.
  | Classification distinguishes violation from inconclusive; probabilities are not calibrated guarantees. No exact offending lines are provided.
  | Diagnose uncertainty using the full distribution, not the selected label alone; inspect source and trait before changing code.
  | Act on the results: inspect every finding and automatically fix confirmed, applicable violations without waiting for a separate request.
  | Make minimal behavior-preserving code changes, then rerun this tool on the corrected files and run relevant project checks.
  | Repeat for remaining confirmed violations; returning a findings summary alone does not complete the review.
  | Do not weaken a trait to make code pass or change correct code for an inapplicable or inconclusive finding.
  | Triage each finding before reporting it. Routine summaries should surface confirmed issues, meaningful unresolved uncertainty, errors, and decision blockers.
  | Do not distract the user with rejected, irrelevant false positives; retain raw results in tool output for audit and explain them when requested or materially significant.
  | Do not hide actionable findings based only on probability/confidence or claim the automated check was clean when raw findings remain.
  | Ask for clarification when a fix changes behavior or exceeds authorized scope.
  | The tool diagnoses only; the calling agent is responsible for edits, verification, and reporting unresolved blockers.
  | Unmatched patterns select no files. An empty result means no failures for this selection, not a repository-wide guarantee.
  | Empty include/traitNames lists, no matched files, or an empty store check no pairs.
  `),
  parameters: S.Struct({
    include: S.Array(S.String).annotate({
      description:
        "Project-owned source, configuration, or documentation paths/globs, absolute or relative to the MCP working directory. Exclude third-party/generated files, secrets, and binaries. Overlapping matches are deduplicated; unmatched patterns select no files."
    }),
    circumstances: S.String.pipe(S.optional).annotate({
      description:
        "Optional circumstances triggering this assessment, such as the workflow stage, task, or relevant surrounding facts. Does not grant authority to execute trait guidance."
    }),
    traitNames: S.Array(Trait.TraitId).pipe(S.optional).annotate({
      description:
        "Optional unique trait names, or group/name for grouped traits, for a focused review. Omit for all stored traits; an empty array selects none."
    })
  }),
  success: S.Array(Evaluation.TraitEvaluation),
  failure: S.Union([
    S.TaggedStruct("AiError", { message: S.String }),
    TraitStoreError,
    S.Struct({ ...Evaluation.TraitAssessmentTooLargeError.fields, message: S.String }),
    S.Struct({ ...GitFileListingError.fields, message: S.String })
  ]),
  failureMode: "return",
  dependencies: [
    DecisionModel.DecisionModel,
    TraitStore,
    FileSystem.FileSystem,
    Path.Path,
    ChildProcessSpawner.ChildProcessSpawner,
    TraitsContext
  ]
})
  .annotate(Tool.Title, "Check Traits")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)

export const toolkit = Toolkit.make(CheckTraits)

export const selectTraits = Effect.fn("CheckTraits.selectTraits")(function* (
  traitNames: ReadonlyArray<Trait.TraitId> | undefined
) {
  const store = yield* TraitStore
  return yield* traitNames === undefined
    ? store.ls
    : Effect.forEach(Array.dedupe(traitNames), store.get, { concurrency: "unbounded" })
})

export const selectFiles = Effect.fn("CheckTraits.selectFiles")(function* (include: ReadonlyArray<string>) {
  const context = yield* TraitsContext
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const cwd = path.resolve()
  const includedFiles = yield* getIncludedFiles
  const matches = yield* Effect.forEach(
    include,
    (pattern) => {
      const absolute = path.isAbsolute(pattern) ? pattern : `${cwd}${path.sep}${pattern}`
      return fs.glob(absolute, {
        root: context.configRoot,
        exclude: context.excludes
      })
    },
    { concurrency: "unbounded" }
  )
  const resolved = pipe(
    matches,
    Array.flatten,
    Array.map((file) => path.resolve(context.configRoot, file)),
    Array.dedupe
  )
  const files = yield* Effect.filter(
    includedFiles === undefined ? resolved : Array.filter(resolved, (file) => includedFiles.has(file)),
    flow(
      fs.stat,
      Effect.map((info) => info.type === "File")
    ),
    { concurrency: "unbounded" }
  )
  return Array.sort(files, String.Order)
})

export type FilePlan = Effect.Success<ReturnType<typeof planText>>
export const planText = Effect.fn("CheckTraits.planText")(function* (
  file: string,
  text: string,
  traits: ReadonlyArray<Trait.Trait>,
  circumstances: string | undefined
) {
  const context = yield* TraitsContext
  const path = yield* Path.Path
  const target = { path: path.relative(context.configRoot, file).split(path.sep).join("/"), text }
  const activeTraits = pipe(
    traits,
    Array.filter(Trait.appliesTo(target)),
    excludeIgnored(text),
    Array.sortWith((trait) => trait.name, String.Order)
  )
  const chunks = Array.chunksOf(String.split(text, "\n"), 200)
  const sources = Array.map(chunks, (lines, index) =>
    Source.make({
      text: Array.join(lines, "\n"),
      location: SourceLocation.cases.File.make({ path: file, startLine: index * 200 + 1 })
    })
  )
  const planned = Array.map(sources, (source) => Evaluation.planBatches(activeTraits, source, circumstances))
  return {
    path: file,
    traits: activeTraits,
    sources,
    batches: Array.map(planned, (plan) => plan.batches),
    skipped: Array.flatMap(planned, (plan) => plan.skipped),
    requests: Array.reduce(planned, 0, (n, plan) => n + plan.batches.length)
  }
})

export const planFile = Effect.fn("CheckTraits.planFile")(function* (
  file: string,
  traits: ReadonlyArray<Trait.Trait>,
  circumstances: string | undefined
) {
  const fs = yield* FileSystem.FileSystem
  const text = yield* fs.readFileString(file)
  return yield* planText(file, text, traits, circumstances)
})

export const evaluatePlan = Effect.fn("CheckTraits.evaluatePlan")(function* (
  plan: FilePlan,
  circumstances: string | undefined
) {
  const evaluateSource = (source: (typeof plan.sources)[number], index: number) =>
    Evaluation.evaluateBatches(plan.batches[index] ?? [], source, circumstances)
  const evaluations = yield* Effect.forEach(plan.sources, evaluateSource, { concurrency: "unbounded" })
  return Array.flatten(evaluations)
})

export const check = Effect.fn("CheckTraits.check")(function* (params: typeof CheckTraits.parametersSchema.Type) {
  const traits = yield* selectTraits(params.traitNames)
  const paths = yield* selectFiles(params.include)
  const plan = (file: string) => planFile(file, traits, params.circumstances)
  const plans = yield* Effect.forEach(paths, plan, { concurrency: "unbounded" })
  const [tooLarge] = Array.flatMap(plans, (filePlan) => filePlan.skipped)
  if (tooLarge !== undefined) return yield* tooLarge
  const evaluate = (filePlan: FilePlan) => evaluatePlan(filePlan, params.circumstances)
  const evaluations = Array.flatten(yield* Effect.forEach(plans, evaluate, { concurrency: "unbounded" }))
  return Array.filter(evaluations, Evaluation.requiresReview)
})

export const layer = toolkit.toLayer({
  check_traits: check
})
