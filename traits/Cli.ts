import { Cause, Console, Effect, Layer, Option, pipe, Runtime, Schema as S, Stdio, Stream } from "effect"
import { Flag } from "effect/cli"

import * as TraitsConfigProvider from "./_util/TraitsConfigProvider.ts"
import * as CheckTraits from "./toolkit/CheckTraits.ts"
import { DeriveTrait } from "./toolkit/DeriveTrait.ts"
import * as Trait from "./Trait.ts"
import * as Derivation from "./TraitDerivation.ts"
import * as Evaluation from "./TraitEvaluation.ts"
import * as TraitsConfig from "./TraitsConfig.ts"
import * as TraitStore from "./TraitStore.ts"

export const ExitCode = {
  clean: 0,
  findings: 1,
  failure: 2,
  nothingSelected: 3
} as const

export class CliExit extends S.TaggedError<CliExit>()("CliExit", { code: S.Int, reason: S.String }) {
  override get [Runtime.errorExitCode]() {
    return this.code
  }
  override get message() {
    return this.reason
  }
}

export const isCliExit = (cause: Cause.Cause<unknown>) => S.is(CliExit)(Cause.squash(cause))

export const layerTraits = TraitStore.layerFileSystem(".agents/traits").pipe(
  Layer.provideMerge(TraitsConfig.layer),
  Layer.provide(TraitsConfigProvider.layer)
)

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

export const checkFlags = {
  include: Flag.String("include").pipe(
    Flag.atLeast(0),
    Flag.withDescription("File path or glob to check. Repeat for more. Relative to the current directory.")
  ),
  trait: Flag.String("trait").pipe(
    Flag.atLeast(0),
    Flag.withDescription("Trait name to check. Repeat for more. Omit to check every stored trait.")
  ),
  circumstances: Flag.String("circumstances").pipe(
    Flag.optional,
    Flag.withDescription("The task or workflow stage that triggered this check.")
  ),
  json: Flag.Boolean("json").pipe(
    Flag.withDefault(false),
    Flag.withDescription("Print the check_traits result as JSON.")
  )
}

export const runCheck = Effect.fn("Cli.check")(function* (flags: {
  readonly include: ReadonlyArray<string>
  readonly trait: ReadonlyArray<string>
  readonly circumstances: Option.Option<string>
  readonly json: boolean
}) {
  const traitNames = yield* S.decodeEffect(S.Array(Trait.TraitName))(flags.trait)
  const result = yield* CheckTraits.check({
    include: flags.include,
    traitNames: traitNames.length === 0 ? undefined : traitNames,
    circumstances: Option.getOrUndefined(flags.circumstances)
  }).pipe(Effect.provide(layerTraits))
  if (flags.json) {
    yield* Console.log(yield* S.encodeEffect(S.fromJsonString(S.Array(Evaluation.TraitEvaluation)))(result.findings))
  } else {
    for (const finding of result.findings) {
      const location =
        finding.source.location?._tag === "File"
          ? `${finding.source.location.path}:${finding.source.location.startLine}`
          : "(generated)"
      yield* Console.log(`${location} ${finding.trait.name} ${finding.assessment.classification}`)
    }
  }
  const summary = `${result.findings.length} findings in ${result.paths.length} files against ${result.traits.length} traits.`
  if (result.paths.length === 0 || result.traits.length === 0) {
    return yield* CliExit.make({ code: ExitCode.nothingSelected, reason: `Selected nothing to check. ${summary}` })
  }
  if (result.findings.length > 0) return yield* CliExit.make({ code: ExitCode.findings, reason: summary })
  yield* Console.error(summary)
}, reportFailures)

export const runDerive = Effect.fn("Cli.derive")(function* () {
  const stdio = yield* Stdio.Stdio
  const input = yield* pipe(stdio.stdin, Stream.decodeText(), Stream.mkString)
  const params = yield* S.decodeEffect(S.fromJsonString(DeriveTrait.parametersSchema))(input)
  const outcome = yield* Derivation.derive(params).pipe(Effect.provide(layerTraits))
  yield* Console.log(yield* S.encodeEffect(S.fromJsonString(Derivation.TraitDerivation))(outcome))
}, reportFailures)

export const reportExit = (cause: Cause.Cause<unknown>) => {
  const error = Cause.squash(cause)
  if (!S.is(CliExit)(error)) return Effect.logError(cause)
  return error.code === ExitCode.failure ? Effect.void : Console.error(error.reason)
}
