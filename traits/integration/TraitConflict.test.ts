import { fileURLToPath } from "node:url"

import { NodeServices } from "@effect/platform-node"
import { expect, it } from "@effect/vitest"
import { Effect, FileSystem, Layer, String } from "effect"
import { FetchHttpClient } from "effect/http"

import { Source } from "../Source.ts"
import * as Trait from "../Trait.ts"
import * as TraitConflict from "../TraitConflict.ts"
import * as TraitEvaluation from "../TraitEvaluation.ts"
import * as TraitsConfig from "../TraitsConfig.ts"

const layer = TraitsConfig.layer.pipe(Layer.provideMerge(FetchHttpClient.layer), Layer.provideMerge(NodeServices.layer))

const rawMultilineExample = String.stripMargin(`
|type TraitField = { readonly value: string }
|const field: TraitField = {
|  value: \`---
|
|\\\`\\\`\\\`diff
|-import { InvalidDocument } from "./InvalidDocument.ts"
|+export class InvalidDocument
|+  extends S.TaggedError<InvalidDocument>()("InvalidDocument", {
|+    path: S.String,
|+  }) {}
|\\\`\\\`\\\`\`
|}
`)

it.effect(
  "detects missing stripMargin in raw multiline text and accepts the corrected real component",
  Effect.fnUntraced(function* () {
    const fs = yield* FileSystem.FileSystem
    const traitPath = fileURLToPath(new URL("../../.agents/traits/strip-margin-for-multiline-text.md", import.meta.url))
    const traitText = yield* fs.readFileString(traitPath)
    const trait = yield* Trait.parse(traitText, traitPath)
    const componentPath = fileURLToPath(new URL("../../traits.sh/src/TraitAnatomy.tsx", import.meta.url))
    const component = yield* fs.readFileString(componentPath)
    for (const example of [
      { text: rawMultilineExample, classification: "violation" },
      { text: component, classification: "compliant" }
    ]) {
      const result = yield* TraitEvaluation.evaluateAll(
        [trait],
        Source.make({ text: example.text }),
        "Reviewing a TypeScript/TSX component containing a large embedded Markdown diff. Assess the complete source."
      )
      expect(result[0]?.assessment.classification).toBe(example.classification)
    }
  }, Effect.provide(layer)),
  { timeout: 120000 }
)

it.effect(
  "assesses a non-code subject using invocation circumstances without treating guidance as authority",
  Effect.fnUntraced(function* () {
    const trait = Trait.Trait.make({
      name: Trait.TraitName.make("delegated-payments"),
      subject: "A proposed autonomous payment.",
      requirement: "The payment amount must not exceed the remaining delegated budget.",
      applicability: "Before committing funds on behalf of another party.",
      purpose: "Prevent unauthorized spending.",
      guidance: "Negotiate, decline, or escalate when the budget is insufficient.",
      context: "A payment exactly equal to the remaining budget satisfies this requirement."
    })
    for (const example of [
      { text: "Proposed autonomous payment: USD 12.", classification: "violation" },
      { text: "Proposed autonomous payment: USD 10.", classification: "compliant" },
      { text: "A poem about a river.", classification: "not-applicable" },
      { text: "Proposed autonomous payment: amount not supplied.", classification: "inconclusive" }
    ]) {
      const result = yield* TraitEvaluation.evaluateAll(
        [trait],
        Source.make({ text: example.text }),
        "Before committing funds for the account owner. Remaining delegated budget: USD 10. No approval to exceed it."
      )
      expect(result[0]?.assessment.classification).toBe(example.classification)
    }
  }, Effect.provide(layer)),
  { timeout: 60000 }
)

const callbacks = Trait.Trait.make({
  name: Trait.TraitName.make("direct-callbacks"),
  subject: "Callbacks.",
  requirement:
    "Pass compatible functions directly as callbacks instead of wrapping them in forwarding arrows. Retain wrappers needed to preserve the receiver or control forwarded arguments.",
  applicability: "In TypeScript.",
  purpose: "Expose callback behavior without redundant forwarding wrappers."
})
const broaderProposal =
  "Pass compatible functions directly instead of wrapping them in forwarding arrows, both for callbacks and service method definitions. Use a curried library overload directly when it produces the required function. Retain wrappers needed to preserve the receiver or control forwarded arguments."

it.effect(
  "recognizes a genuinely covered preference with the configured decision model",
  Effect.fnUntraced(function* () {
    const result = yield* TraitConflict.check(callbacks, Trait.serialize(callbacks))
    expect(TraitConflict.TraitConflict.guards.Covered(result)).toBe(true)
  }, Effect.provide(layer))
)

it.effect(
  "does not claim a callback-only trait fully covers forwarding service methods",
  Effect.fnUntraced(function* () {
    const result = yield* TraitConflict.check(callbacks, broaderProposal)
    expect(TraitConflict.TraitConflict.guards.Covered(result)).toBe(false)
    if (TraitConflict.TraitConflict.guards.Fail(result)) {
      expect(result.reason).toBe("coverage_gap")
    }
  }, Effect.provide(layer))
)
