import type { NodeServices } from "@effect/platform-node"
import { Array, Data, Effect, Layer, Path, pipe, Schema as S, Semaphore } from "effect"
import { DecisionModel, LanguageModel } from "effect/ai"
import { HttpClient } from "effect/http"

import { getWorktreeRoot } from "./_util/Git.ts"
import { TraitsContext } from "./TraitsContext.ts"

export type TraitsConfig = typeof TraitsConfig.Encoded
export const TraitsConfig = S.Struct({
  decisionConcurrency: S.Int.check(S.isGreaterThan(0))
    .pipe(S.withDecodingDefault(Effect.succeed(4)))
    .annotate({
      description: "Maximum concurrent decision model requests. Defaults to 4."
    }),
  excludeGitignored: S.Boolean.pipe(S.withDecodingDefault(Effect.succeed(true))).annotate({
    description: "Exclude Git-ignored files from checks by default. Set false to disable the Git file-set filter."
  }),
  excludes: S.Array(S.NonEmptyString)
    .pipe(S.withDecodingDefault(Effect.succeed([])))
    .annotate({
      description:
        "Filenames or native filesystem glob patterns excluded from trait checks, relative to traits.ts or absolute. Use directory/** to exclude a subtree. Bare directories are not expanded; escape glob characters in literal filenames using native glob syntax."
    }),
  layerDecisionModel: S.declare(
    (value): value is DecisionModelLayer | ((options: { readonly model: string }) => DecisionModelLayer) =>
      Layer.isLayer(value) || typeof value === "function"
  ).annotate({
    description:
      "Decision model layer, or a function from a model id to one. The function form lets the CLI --model flag choose the model; it receives jev-latest by default."
  }),
  layerLanguageModel: S.declare(
    (
      value
    ): value is Layer.Layer<LanguageModel.LanguageModel, any, NodeServices.NodeServices | HttpClient.HttpClient> =>
      Layer.isLayer(value)
  )
    .pipe(S.optional)
    .annotate({
      description:
        "Language model for trait decomposition and reconciliation. When omitted, derive_trait returns GenerationRequired and the calling agent supplies the generated JSON."
    })
})

type DecisionModelLayer = Layer.Layer<
  DecisionModel.DecisionModel,
  any,
  NodeServices.NodeServices | HttpClient.HttpClient
>

export const defaultModel = "jev-latest"

export class FixedDecisionModelError extends Data.TaggedError("FixedDecisionModelError")<{ readonly model: string }> {
  override get message() {
    return `traits.ts exports layerDecisionModel as a Layer, so --model ${this.model} cannot apply. Export a function ({ model }) => Layer to choose the model.`
  }
}

const load = Effect.gen(function* () {
  const path = yield* Path.Path
  const configRoot = yield* getWorktreeRoot
  const url = yield* path.toFileUrl(path.join(configRoot, "traits.ts"))
  const module = yield* Effect.promise(() => import(url.href))
  const config = yield* pipe(module.default, S.decodeUnknownEffect(TraitsConfig))
  const layerContext = Layer.effect(
    TraitsContext,
    Effect.gen(function* () {
      const excludes = Array.appendAll(
        Array.flatMap([".git", ".worktrees"], (directory) => [`**/${directory}`, `**/${directory}/**`]),
        Array.map(config.excludes, (pattern) =>
          path.isAbsolute(pattern) ? path.relative(configRoot, pattern) : pattern
        )
      )
      const semaphore = yield* Semaphore.make(config.decisionConcurrency)
      return { config, configRoot, excludes, semaphore }
    })
  )
  return { config, layerContext }
})

export const layerContext = load.pipe(
  Effect.map((loaded) => loaded.layerContext),
  Layer.unwrap
)

export const layerWith = (options: { readonly model?: string | undefined }) =>
  Effect.gen(function* () {
    const { config, layerContext } = yield* load
    const decisionModel = config.layerDecisionModel
    const model = options.model ?? defaultModel
    if (typeof decisionModel !== "function" && options.model !== undefined) {
      return yield* new FixedDecisionModelError({ model: options.model })
    }
    return Layer.mergeAll(
      // oxlint-disable-next-line effecttsgo/any-unknown-in-error-context
      (typeof decisionModel === "function" ? decisionModel({ model }) : decisionModel).pipe(Layer.orDie),
      config.layerLanguageModel === undefined
        ? Layer.empty
        : // oxlint-disable-next-line effecttsgo/any-unknown-in-error-context
          config.layerLanguageModel.pipe(Layer.orDie),
      layerContext
    )
  }).pipe(Layer.unwrap)

export const layer = layerWith({})
