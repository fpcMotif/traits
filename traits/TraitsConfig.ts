import type { NodeServices } from "@effect/platform-node"
import { Array, Effect, Layer, Path, pipe, Schema as S, Semaphore } from "effect"
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
    (
      value
    ): value is Layer.Layer<DecisionModel.DecisionModel, any, NodeServices.NodeServices | HttpClient.HttpClient> =>
      Layer.isLayer(value)
  ),
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

export const layer = Effect.gen(function* () {
  const path = yield* Path.Path
  const configRoot = yield* getWorktreeRoot
  const url = yield* path.toFileUrl(path.join(configRoot, "traits.ts"))
  const module = yield* Effect.promise(() => import(url.href))
  const config = yield* pipe(module.default, S.decodeUnknownEffect(TraitsConfig))
  return Layer.mergeAll(
    // oxlint-disable-next-line effecttsgo/any-unknown-in-error-context
    config.layerDecisionModel.pipe(Layer.orDie),
    config.layerLanguageModel === undefined
      ? Layer.empty
      : // oxlint-disable-next-line effecttsgo/any-unknown-in-error-context
        config.layerLanguageModel.pipe(Layer.orDie),
    Layer.effect(
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
  )
}).pipe(Layer.unwrap)
