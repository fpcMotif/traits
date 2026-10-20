import { TypeSafeClient, TypeSafeDecisionModel } from "@effect/ai-typesafe"
import { Layer } from "effect"
import type { TraitsConfig } from "traits"

export default {
  excludes: ["repos/**"],
  layerDecisionModel: ({ model }: { readonly model: string }) =>
    TypeSafeDecisionModel.layer({ model }).pipe(Layer.provide(TypeSafeClient.layerConfig()))
} satisfies TraitsConfig
