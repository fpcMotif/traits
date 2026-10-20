import {
  Array,
  Cause,
  Console,
  Effect,
  Equal,
  Layer,
  Option,
  Path,
  pipe,
  Runtime,
  Schema as S,
  Stdio,
  Stream,
  String
} from "effect"
import { Flag } from "effect/cli"
import { ChildProcess, ChildProcessSpawner } from "effect/process"

import { getWorktreeRoot } from "./_util/Git.ts"
import { Assessment } from "./Assessment.ts"
import { Source } from "./Source.ts"
import * as CheckTraits from "./toolkit/CheckTraits.ts"
import { DeriveTrait } from "./toolkit/DeriveTrait.ts"
import * as Trait from "./Trait.ts"
import * as Derivation from "./TraitDerivation.ts"
import * as TraitsConfig from "./TraitsConfig.ts"
import { TraitsContext } from "./TraitsContext.ts"
import * as TraitStore from "./TraitStore.ts"
import * as Verdict from "./Verdict.ts"

export const ExitCode = { pass: 0, failed: 1, failure: 2 } as const

export class CliExit extends S.TaggedError<CliExit>()("CliExit", { code: S.Int, reason: S.String }) {
  override get [Runtime.errorExitCode]() {
    return this.code
  }
  override get message() {
    return this.reason
  }
}

export const isCliExit = (cause: Cause.Cause<unknown>) => S.is(CliExit)(Cause.squash(cause))

export const reportExit = (cause: Cause.Cause<unknown>) => {
  const error = Cause.squash(cause)
  if (!S.is(CliExit)(error)) return Effect.logError(cause)
  return error.code === ExitCode.failure ? Effect.void : Console.error(error.reason)
}

const reportFailures = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.catchCauseIf(
      (cause) => !Cause.hasInterruptsOnly(cause) && !isCliExit(cause),
      (cause) =>
        Console.error(Cause.pretty(cause)).pipe(
          Effect.andThen(CliExit.make({ code: ExitCode.failure, reason: "traits failed" }))
        )
    )
  )

const failWith = (reason: string) => CliExit.make({ code: ExitCode.failure, reason })

export const storeDirectory = ".agents/traits"

const layerStore = TraitStore.layerFileSystem(storeDirectory)

const layerDryRunStore = Layer.effect(
  TraitStore.TraitStore,
  Effect.gen(function* () {
    const store = yield* TraitStore.TraitStore
    return TraitStore.TraitStore.of({
      ...store,
      add: (trait) => Effect.succeed(trait),
      update: () => Effect.void,
      rm: () => Effect.void
    })
  })
).pipe(Layer.provide(layerStore))

const layerTraits = (options: { readonly model?: string | undefined; readonly dryRun?: boolean | undefined }) =>
  (options.dryRun === true ? layerDryRunStore : layerStore).pipe(
    Layer.provideMerge(TraitsConfig.layerWith({ model: options.model }))
  )

const layerPlanning = layerStore.pipe(Layer.provideMerge(TraitsConfig.layerContext))

const changeDirectory = (path: Option.Option<string>) =>
  Option.match(path, {
    onNone: () => Effect.void,
    onSome: (directory) =>
      Effect.try({
        try: () => process.chdir(directory),
        catch: () => failWith(`Cannot change to --path ${directory}`)
      })
  })

const gitPaths = Effect.fn("Cli.gitPaths")(function* (root: string, args: ReadonlyArray<string>) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const child = yield* spawner.spawn(ChildProcess.make("git", [...args, "-z"], { cwd: root }))
  const output = yield* child.stdout.pipe(Stream.decodeText(), Stream.mkString)
  yield* child.exitCode.pipe(
    Effect.filterOrFail(Equal.equals(0), (code) => failWith(`git ${args[0]} exited with ${code}`))
  )
  return pipe(output, String.split("\0"), Array.filter(String.isNonEmpty))
}, Effect.scoped)

export const Target = S.Literals(["changed", "staged", "unstaged", "untracked", "files"])
export type Target = typeof Target.Type

export const Kind = S.Literals(["edit", "write"])
export type Kind = typeof Kind.Type

const targetPatterns = Effect.fn("Cli.targetPatterns")(function* (target: Exclude<Target, "files">) {
  const path = yield* Path.Path
  const root = yield* getWorktreeRoot
  const staged = ["diff", "--cached", "--name-only", "--diff-filter=d"]
  const unstaged = ["diff", "--name-only", "--diff-filter=d"]
  const untracked = ["ls-files", "--others", "--exclude-standard"]
  const commands = {
    changed: [staged, unstaged, untracked],
    staged: [staged],
    unstaged: [unstaged],
    untracked: [untracked]
  }[target]
  const files = yield* Effect.forEach(commands, (args) => gitPaths(root, args))
  return pipe(
    files,
    Array.flatten,
    Array.dedupe,
    Array.map((file) => String.replace(/[*?[\]{}()!\\]/g, "\\$&")(path.join(root, file)))
  )
})

const CheckFinding = S.Struct({
  trait: Trait.Trait,
  source: Source,
  assessment: S.Struct({ ...Assessment.fields, verdict: Verdict.Verdict })
})

const CheckReport = S.Struct({
  findings: S.Array(CheckFinding),
  summary: S.Struct({
    files: S.Int,
    traits: S.Int,
    requests: S.Int,
    verdicts: S.Record(Verdict.Verdict, S.Int)
  })
})

const PlanReport = S.Struct({
  dryRun: S.Literal(true),
  files: S.Array(S.Struct({ path: S.String, traits: S.Array(Trait.TraitId), chunks: S.Int, requests: S.Int })),
  summary: S.Struct({ files: S.Int, traits: S.Int, pairs: S.Int, chunks: S.Int, requests: S.Int })
})

const threshold = (name: string, value: number) =>
  Flag.Finite(name).pipe(
    Flag.withDefault(value),
    Flag.withSchema(S.Finite.check(S.isBetween({ minimum: 0, maximum: 1 }))),
    Flag.withDescription(`Probability threshold from 0 to 1. Defaults to ${value}.`)
  )

export const checkFlags = {
  target: Flag.Literals("target", Target.literals).pipe(
    Flag.optional,
    Flag.withDescription(
      "Files to check: changed (default: staged + unstaged + untracked), staged, unstaged, untracked, or files."
    )
  ),
  include: Flag.String("include").pipe(
    Flag.atLeast(0),
    Flag.withDescription("File path or glob to check. Repeatable. Implies --target files.")
  ),
  trait: Flag.String("trait").pipe(
    Flag.atLeast(0),
    Flag.withDescription("Trait name to check. Repeatable. Omit to check every stored trait.")
  ),
  path: Flag.Directory("path", { mustExist: true }).pipe(
    Flag.optional,
    Flag.withDescription("Folder inside the repository to run from. Defaults to the current directory.")
  ),
  circumstances: Flag.String("circumstances").pipe(
    Flag.optional,
    Flag.withDescription("The task or workflow stage that triggered this check.")
  ),
  dryRun: Flag.Boolean("dry-run").pipe(
    Flag.withDefault(false),
    Flag.withDescription("Print the files, traits, chunks, and Jev request count without any model call.")
  ),
  json: Flag.Boolean("json").pipe(
    Flag.withDefault(false),
    Flag.withDescription("Print machine-readable JSON on stdout. Logs go to stderr.")
  ),
  model: Flag.String("model").pipe(
    Flag.optional,
    Flag.withDescription(
      `Decision model id passed to a function-form layerDecisionModel. Defaults to ${TraitsConfig.defaultModel}.`
    )
  ),
  fixThreshold: threshold("fix-threshold", Verdict.defaultThresholds.fix),
  checkThreshold: threshold("check-threshold", Verdict.defaultThresholds.check),
  passThreshold: threshold("pass-threshold", Verdict.defaultThresholds.pass),
  failOn: Flag.Literals("fail-on", Verdict.FailOn.literals).pipe(
    Flag.withDefault("fix" as const),
    Flag.withDescription("Lowest verdict that exits 1: fix (default), check, unsure, or never.")
  ),
  quiet: Flag.Boolean("quiet").pipe(Flag.withDefault(false), Flag.withDescription("Print only findings.")),
  stdin: Flag.Boolean("stdin").pipe(
    Flag.withDefault(false),
    Flag.withDescription("Check code read from stdin instead of files. Requires --stdin-filepath.")
  ),
  stdinFilepath: Flag.String("stdin-filepath").pipe(
    Flag.optional,
    Flag.withDescription("Repository-relative path of the stdin code. Grouped trait paths and when use it.")
  ),
  kind: Flag.Literals("kind", Kind.literals).pipe(
    Flag.withDefault("write" as const),
    Flag.withDescription("With --stdin: edit for a snippet, or write (default) for a whole file.")
  )
}

export interface CheckOptions {
  readonly target: Option.Option<Target>
  readonly include: ReadonlyArray<string>
  readonly trait: ReadonlyArray<string>
  readonly path: Option.Option<string>
  readonly circumstances: Option.Option<string>
  readonly dryRun: boolean
  readonly json: boolean
  readonly model: Option.Option<string>
  readonly fixThreshold: number
  readonly checkThreshold: number
  readonly passThreshold: number
  readonly failOn: Verdict.FailOn
  readonly quiet: boolean
  readonly stdin: boolean
  readonly stdinFilepath: Option.Option<string>
  readonly kind: Kind
}

const stdinSelection = Effect.fn("Cli.stdinSelection")(function* (
  options: CheckOptions,
  traits: ReadonlyArray<Trait.Trait>
) {
  if (options.include.length > 0 || Option.isSome(options.target)) {
    return yield* failWith("--stdin cannot combine with --include or --target")
  }
  if (Option.isNone(options.stdinFilepath)) return yield* failWith("--stdin requires --stdin-filepath")
  const context = yield* TraitsContext
  const path = yield* Path.Path
  const stdio = yield* Stdio.Stdio
  const text = yield* pipe(stdio.stdin, Stream.decodeText(), Stream.mkString)
  const file = path.resolve(context.configRoot, options.stdinFilepath.value)
  const circumstances = Array.join(
    [
      ...Option.toArray(options.circumstances),
      ...(options.kind === "edit"
        ? [`The source is an edited snippet of ${options.stdinFilepath.value}, not the whole file.`]
        : [])
    ],
    "\n"
  )
  const effective = circumstances === "" ? undefined : circumstances
  const plan = yield* CheckTraits.planText(file, text, traits, effective)
  return { target: "stdin", traits, plans: [plan], circumstances: effective }
})

const selection = Effect.fn("Cli.selection")(function* (options: CheckOptions) {
  const traitNames = yield* S.decodeEffect(S.Array(Trait.TraitId))(options.trait)
  const traits = yield* CheckTraits.selectTraits(traitNames.length === 0 ? undefined : traitNames)
  if (options.stdin) return yield* stdinSelection(options, traits)
  const target = Option.getOrElse(options.target, () => (options.include.length > 0 ? "files" : "changed"))
  if (options.include.length > 0 && target !== "files") {
    return yield* failWith(`--include implies --target files; it cannot combine with --target ${target}`)
  }
  const patterns = target === "files" ? options.include : yield* targetPatterns(target)
  const paths = yield* CheckTraits.selectFiles(patterns)
  const circumstances = Option.getOrUndefined(options.circumstances)
  const plan = (file: (typeof paths)[number]) => CheckTraits.planFile(file, traits, circumstances)
  const plans = yield* Effect.forEach(paths, plan, { concurrency: "unbounded" })
  return { target, traits, plans, circumstances }
})

const noteEmpty = (target: string, plans: ReadonlyArray<CheckTraits.FilePlan>, traits: number) =>
  plans.length === 0 || traits === 0
    ? Console.error(
        `traits check: selected nothing to check (target ${target}: ${plans.length} files, ${traits} traits).`
      )
    : Effect.void

const runPlan = Effect.fn("Cli.plan")(function* (options: CheckOptions) {
  const { target, traits, plans } = yield* selection(options)
  const path = yield* Path.Path
  const report = PlanReport.make({
    dryRun: true,
    files: Array.map(plans, (plan) => ({
      path: plan.path,
      traits: Array.map(plan.traits, (trait) => trait.name),
      chunks: plan.sources.length,
      requests: plan.requests
    })),
    summary: {
      files: plans.length,
      traits: traits.length,
      pairs: Array.reduce(plans, 0, (n, plan) => n + plan.traits.length),
      chunks: Array.reduce(plans, 0, (n, plan) => n + plan.sources.length),
      requests: Array.reduce(plans, 0, (n, plan) => n + plan.requests)
    }
  })
  yield* noteEmpty(target, plans, traits.length)
  if (options.json) return yield* Console.log(yield* S.encodeEffect(S.fromJsonString(PlanReport))(report))
  for (const file of report.files) {
    yield* Console.log(
      `${path.relative(path.resolve(), file.path)}  chunks ${file.chunks}  requests ${file.requests}  traits ${file.traits.length}`
    )
  }
  if (!options.quiet) {
    const { summary } = report
    yield* Console.error(
      `dry run: ${summary.files} files, ${summary.traits} traits, ${summary.pairs} file-trait pairs, ${summary.chunks} chunks, ${summary.requests} Jev requests.`
    )
  }
})

const runEvaluation = Effect.fn("Cli.evaluate")(function* (options: CheckOptions) {
  const { target, traits, plans, circumstances } = yield* selection(options)
  const path = yield* Path.Path
  const thresholds = { fix: options.fixThreshold, check: options.checkThreshold, pass: options.passThreshold }
  const evaluate = (plan: CheckTraits.FilePlan) => CheckTraits.evaluatePlan(plan, circumstances)
  const evaluations = Array.flatten(yield* Effect.forEach(plans, evaluate, { concurrency: "unbounded" }))
  const judged = Array.map(evaluations, (evaluation) => ({
    ...evaluation,
    assessment: {
      ...evaluation.assessment,
      verdict: Verdict.verdictFor(evaluation.assessment.probabilities, thresholds)
    }
  }))
  const findings = Array.filter(judged, (finding) => finding.assessment.verdict !== "pass")
  const report = CheckReport.make({
    findings,
    summary: {
      files: plans.length,
      traits: traits.length,
      requests: Array.reduce(plans, 0, (n, plan) => n + plan.requests),
      verdicts: {
        fix: Array.filter(judged, (j) => j.assessment.verdict === "fix").length,
        check: Array.filter(judged, (j) => j.assessment.verdict === "check").length,
        unsure: Array.filter(judged, (j) => j.assessment.verdict === "unsure").length,
        pass: Array.filter(judged, (j) => j.assessment.verdict === "pass").length
      }
    }
  })
  yield* noteEmpty(target, plans, traits.length)
  if (options.json) yield* Console.log(yield* S.encodeEffect(S.fromJsonString(CheckReport))(report))
  else {
    for (const finding of findings) {
      const location =
        finding.source.location?._tag === "File"
          ? `${path.relative(path.resolve(), finding.source.location.path)}:${finding.source.location.startLine}`
          : "(generated)"
      yield* Console.log(
        `${finding.assessment.verdict.padEnd(6)} ${location} ${finding.trait.name} p(violation) ${finding.assessment.probabilities.violation.toFixed(2)}`
      )
    }
  }
  if (!options.quiet) {
    const { verdicts } = report.summary
    yield* Console.error(
      `${judged.length} judgments in ${plans.length} files against ${traits.length} traits: ${verdicts.fix} fix, ${verdicts.check} check, ${verdicts.unsure} unsure, ${verdicts.pass} pass.`
    )
  }
  const failing = Array.filter(findings, (finding) => Verdict.fails(finding.assessment.verdict, options.failOn))
  if (failing.length > 0) {
    return yield* CliExit.make({
      code: ExitCode.failed,
      reason: `${failing.length} findings at or above --fail-on ${options.failOn}.`
    })
  }
})

export const runCheck = Effect.fn("Cli.check")(function* (options: CheckOptions) {
  yield* changeDirectory(options.path)
  if (options.dryRun) return yield* runPlan(options).pipe(Effect.provide(layerPlanning))
  return yield* runEvaluation(options).pipe(
    Effect.provide(layerTraits({ model: Option.getOrUndefined(options.model) }))
  )
}, reportFailures)

export const deriveFlags = {
  dryRun: Flag.Boolean("dry-run").pipe(
    Flag.withDefault(false),
    Flag.withDescription("Run validation, Jev checks, and the generation handshake, but never write to the store.")
  )
}

export const runDerive = Effect.fn("Cli.derive")(function* (options: { readonly dryRun: boolean }) {
  const stdio = yield* Stdio.Stdio
  const input = yield* pipe(stdio.stdin, Stream.decodeText(), Stream.mkString)
  const params = yield* S.decodeEffect(S.fromJsonString(DeriveTrait.parametersSchema))(input)
  const outcome = yield* Derivation.derive(params).pipe(Effect.provide(layerTraits({ dryRun: options.dryRun })))
  const encoded = yield* S.encodeEffect(Derivation.TraitDerivation)(outcome)
  yield* Console.log(JSON.stringify(options.dryRun ? { ...encoded, dryRun: true } : encoded))
}, reportFailures)

export const lsFlags = {
  json: Flag.Boolean("json").pipe(Flag.withDefault(false), Flag.withDescription("Print the traits as JSON."))
}

const StoredTraits = S.Array(S.Struct({ name: Trait.TraitId, path: S.String }))

export const runLs = Effect.fn("Cli.ls")(
  function* (options: { readonly json: boolean }) {
    const store = yield* TraitStore.TraitStore
    const path = yield* Path.Path
    const traits = yield* store.ls
    const entries = Array.map(traits, (trait) => ({
      name: trait.name,
      path: path.resolve(storeDirectory, `${trait.name}.md`)
    }))
    if (options.json) return yield* Console.log(yield* S.encodeEffect(S.fromJsonString(StoredTraits))(entries))
    for (const entry of entries) yield* Console.log(`${entry.name}  ${path.relative(path.resolve(), entry.path)}`)
  },
  (effect) => effect.pipe(Effect.provide(layerStore), reportFailures)
)
