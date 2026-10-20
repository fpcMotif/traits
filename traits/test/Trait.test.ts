import { expect, it } from "@effect/vitest"
import { Array, Effect, Layer, pipe, Result, Schema as S, Semaphore, Stream, String } from "effect"
import { DecisionModel, LanguageModel } from "effect/ai"
import { toCodecOpenAI } from "effect/ai/OpenAiStructuredOutput"

import * as Trait from "../Trait.ts"
import { TraitsContext } from "../TraitsContext.ts"

const name = Trait.TraitName.make("delegated-spending")
const minimal = Trait.Trait.make({
  name,
  subject: "A payment an agent is considering authorizing.",
  requirement: "The payment must fall within delegated spending authority.",
  purpose: "Prevent unauthorized spending."
})

const multilineContext = String.stripMargin(`
|Supporting context.
|
|---
|
|\`\`\`diff
| const value = {
|-  bad: true,
|+  good: true,
| }
|\`\`\`
`)

const foldedDocument = String.stripMargin(`
|---
|name: ${name}
|subject: A payment.
|requirement: >
|  Stay within
|  delegated authority.
|purpose: Protect funds.
|applicability: |-
|  Before payment.
|  Except test transactions.
|---
|
|# Context
|
|---
|Not frontmatter.
`)

it.effect(
  "requests the distinct JSON shape required for decomposition",
  Effect.fnUntraced(function* () {
    const bodies = ["Use two spaces for indentation.", "Use single quotes."]
    const requests: Array<LanguageModel.ProviderOptions> = []
    const decisionModel = yield* DecisionModel.make({
      decide: () =>
        Effect.succeed({
          answers: {
            assessment: { _tag: "Classify", label: "decomposable", probabilities: { atomic: 0, decomposable: 1 } }
          },
          usage: { inputTokens: 0, outputTokens: 0 }
        })
    })
    const languageModel = yield* LanguageModel.make({
      generateText: (request) => {
        requests.push(request)
        return Effect.succeed([{ type: "text", text: JSON.stringify({ traits: bodies }) }])
      },
      streamText: () => Stream.empty,
      codecTransformer: toCodecOpenAI
    })
    const semaphore = yield* Semaphore.make(1)
    const layerDecisionModel = Layer.succeed(DecisionModel.DecisionModel, decisionModel)
    const layerLanguageModel = Layer.succeed(LanguageModel.LanguageModel, languageModel)
    const result = yield* Trait.checkDecomposability(Array.join(bodies, " ")).pipe(
      Effect.provide(
        Layer.mergeAll(
          layerDecisionModel,
          layerLanguageModel,
          Layer.succeed(TraitsContext, {
            configRoot: "/test",
            excludes: [],
            semaphore,
            config: {
              decisionConcurrency: 1,
              excludeGitignored: true,
              excludes: [],
              layerDecisionModel,
              layerLanguageModel
            }
          })
        )
      )
    )
    expect(result).toEqual(bodies)
    expect(requests[0]?.prompt.content[0]).toMatchObject({
      role: "system",
      content: expect.stringContaining('Return only a JSON object with this shape: {"traits":["')
    })
  })
)

it.effect(
  "roundtrips a minimal trait without optional fields or context",
  Effect.fnUntraced(function* () {
    const text = Trait.serialize(minimal)
    const parsed = yield* Trait.parse(text, "/traits/test.md")
    expect(parsed).toEqual(minimal)
    expect(text).not.toContain("context:")
    expect(text).not.toContain("applicability:")
    const atEnd = yield* Trait.parse(pipe(text, String.trimEnd), "/traits/test.md")
    expect(atEnd).toEqual(minimal)
  })
)

it.effect(
  "preserves complete multiline traits and Markdown context through YAML roundtrips",
  Effect.fnUntraced(function* () {
    for (const suffix of ["", "\n", "\n\n"]) {
      const trait = Trait.Trait.make({
        ...minimal,
        subject: ` A payment proposal\nwith indented context.${suffix}`,
        requirement: `Require delegated authority.\n---\nDo not exceed the budget.${suffix}`,
        applicability: `Before committing funds.\nExcept explicitly authorized test transactions.${suffix}`,
        purpose: `Protect funds.\nEnable autonomous purchases.${suffix}`,
        guidance: `Negotiate, decline, or escalate.\nDo not assume permission.${suffix}`,
        context: `${String.trim(multilineContext)}${suffix}`
      })
      const text = Trait.serialize(trait)
      expect(text).toContain("requirement: |")
      const parsed = yield* Trait.parse(text, "/traits/test.md")
      expect(parsed).toEqual(trait)
      const crlf = yield* Trait.parse(pipe(text, String.replaceAll("\n", "\r\n")), "/traits/test.md")
      expect(crlf).toEqual({ ...trait, context: pipe(trait.context!, String.replaceAll("\n", "\r\n")) })
    }
  })
)

it.effect(
  "parses literal and folded YAML while leaving Markdown context untouched",
  Effect.fnUntraced(function* () {
    const trait = yield* Trait.parse(String.trimStart(foldedDocument), "/traits/test.md")
    expect(trait.requirement).toBe("Stay within delegated authority.\n")
    expect(trait.applicability).toBe("Before payment.\nExcept test transactions.")
    expect(trait.context).toBe("\n# Context\n\n---\nNot frontmatter.\n")
  })
)

it.effect(
  "rejects old-format traits and unsupported frontmatter rather than discarding content",
  Effect.fnUntraced(function* () {
    const header = `name: ${name}\nsubject: A payment.\nrequirement: Stay within authority.\npurpose: Protect funds.\n`
    for (const text of [
      `---\nname: ${name}\n---\nAn old body-only requirement.`,
      ...Array.map(
        [
          "mime: text/typescript",
          "when: editing",
          "skip: tests",
          "diff: example",
          "body: hidden",
          "context: hidden",
          "priority: 2",
          "extensionMetadata: {}"
        ],
        (field) => `---\n${header}${field}\n---\nContext`
      )
    ]) {
      const result = yield* Trait.parse(text, "/traits/test.md").pipe(Effect.result)
      expect(Result.isFailure(result)).toBe(true)
    }
  })
)

it.effect(
  "rejects missing, empty, and incorrectly typed core fields",
  Effect.fnUntraced(function* () {
    for (const field of ["name", "subject", "requirement", "applicability", "purpose", "guidance"]) {
      for (const value of ["", "   ", false, {}, []]) {
        const input: unknown = { ...minimal, [field]: value }
        const result = yield* pipe(input, S.decodeUnknownEffect(Trait.Trait), Effect.result)
        expect(Result.isFailure(result)).toBe(true)
      }
    }
    for (const header of [
      `name: ${name}\nsubject: A payment.\nrequirement: Stay within authority.`,
      `name: ${name}\nsubject: A payment.\npurpose: Protect funds.`,
      `name: ${name}\nrequirement: Stay within authority.\npurpose: Protect funds.`,
      "subject: A payment.\nrequirement: Stay within authority.\npurpose: Protect funds."
    ]) {
      const result = yield* Trait.parse(`---\n${header}\n---`, "/traits/test.md").pipe(Effect.result)
      expect(Result.isFailure(result)).toBe(true)
    }
  })
)

it.effect(
  "rejects malformed YAML, missing delimiters, and unsafe names",
  Effect.fnUntraced(function* () {
    for (const text of [
      "---\nsubject: [\n---\nContext",
      "---\nsubject: A payment.\nContext",
      "---\n- not an object\n---",
      "Context without frontmatter",
      "Context before frontmatter\n---\nname: test\n---"
    ]) {
      const result = yield* Trait.parse(text, "/traits/test.md").pipe(Effect.result)
      expect(Result.isFailure(result)).toBe(true)
    }
    for (const invalid of [
      "",
      "../escape",
      "with/slash",
      "name.md",
      "Uppercase",
      "two words",
      "snake_case",
      "trait-example",
      pipe("a", String.repeat(81))
    ]) {
      const result = yield* pipe({ ...minimal, name: invalid }, S.decodeEffect(Trait.FlatTrait), Effect.result)
      expect(Result.isFailure(result)).toBe(true)
    }
    for (const invalid of ["../escape", "group/..", "./name", "a/b/c", "group/two words"]) {
      const result = yield* pipe({ ...minimal, name: invalid }, S.decodeEffect(Trait.Trait), Effect.result)
      expect(Result.isFailure(result)).toBe(true)
    }
  })
)
