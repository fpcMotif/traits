import { expect, it } from "@effect/vitest"
import { Array, Effect, Layer, pipe, Predicate, Record, Schema as S, Semaphore, Stream, String } from "effect"
import { DecisionModel, LanguageModel } from "effect/ai"
import { toCodecOpenAI } from "effect/ai/OpenAiStructuredOutput"

import * as Generation from "../Generation.ts"
import * as Trait from "../Trait.ts"
import { derive, type TraitDerivation } from "../TraitDerivation.ts"
import { TraitsContext } from "../TraitsContext.ts"
import * as TraitStore from "../TraitStore.ts"

const name = Trait.TraitName.make("indentation")
const original = Trait.Trait.make({
  name,
  subject: "Code indentation.",
  requirement: "Use tabs for indentation.",
  purpose: "Keep indentation consistent."
})
const proposedTrait = Trait.Trait.make({ ...original, requirement: "Use two spaces for indentation." })

const harness = Effect.fn("test.harness")(function* (options: {
  readonly responseText?: string | undefined
  readonly unaffected?: Trait.Trait | undefined
  readonly relationships: Readonly<Record<Trait.TraitName, "distinct" | "clarification" | "conflict">>
  readonly languageModel?: boolean | undefined
  readonly decomposable?: boolean | undefined
}) {
  const stored = new Map([[original.name, original]])
  if (options.unaffected !== undefined) stored.set(options.unaffected.name, options.unaffected)
  const mutations: Array<string> = []
  const requests: Array<LanguageModel.ProviderOptions> = []
  const decisionModel = yield* DecisionModel.make({
    decide: Effect.fnUntraced(function* (request) {
      let label = options.decomposable === true ? "decomposable" : "atomic"
      let labels = ["atomic", "decomposable"]
      if (Predicate.hasProperty(request.state, "trait")) {
        const trait = yield* pipe(request.state.trait, S.decodeUnknownEffect(Trait.Trait), Effect.orDie)
        label = options.relationships[trait.name] ?? (yield* Effect.die(`Missing relationship for ${trait.name}`))
        labels = ["distinct", "covered", "clarification", "conflict", "inconclusive"]
      }
      return {
        answers: {
          assessment: {
            _tag: "Classify",
            label,
            probabilities: pipe(
              labels,
              Array.map((key) => [key, key === label ? 1 : 0] as const),
              Record.fromEntries
            )
          }
        },
        usage: { inputTokens: 0, outputTokens: 0 }
      }
    })
  })
  const languageModel = yield* LanguageModel.make({
    generateText: (request) => {
      requests.push(request)
      return Effect.succeed([
        {
          type: "text",
          text: options.responseText ?? JSON.stringify({ traits: [proposedTrait] })
        }
      ])
    },
    streamText: () => Stream.empty,
    codecTransformer: toCodecOpenAI
  })
  const store = TraitStore.TraitStore.of({
    ls: Effect.sync(() => [...stored.values()]),
    add: (trait) =>
      Effect.suspend(() => {
        if (stored.has(trait.name)) return TraitStore.TraitAlreadyExistsError.make({ name: trait.name })
        mutations.push("add")
        stored.set(trait.name, trait)
        return Effect.succeed(trait)
      }),
    update: (trait) =>
      Effect.sync(() => {
        mutations.push("update")
        stored.set(trait.name, trait)
      }),
    get: (name) =>
      Effect.suspend(() => {
        const trait = stored.get(name)
        return trait === undefined ? TraitStore.TraitNotFoundError.make({ name }) : Effect.succeed(trait)
      }),
    rm: (names) =>
      Effect.sync(() => {
        mutations.push("rm")
        for (const name of names) stored.delete(name)
      })
  })
  const semaphore = yield* Semaphore.make(4)
  const layerLanguageModel =
    options.languageModel === false ? undefined : Layer.succeed(LanguageModel.LanguageModel, languageModel)
  const layer = Layer.mergeAll(
    Layer.succeed(DecisionModel.DecisionModel, decisionModel),
    layerLanguageModel ?? Layer.empty,
    Layer.succeed(TraitStore.TraitStore, store),
    Layer.succeed(TraitsContext, {
      configRoot: "/test",
      excludes: [],
      semaphore,
      config: {
        decisionConcurrency: 4,
        excludeGitignored: true,
        excludes: [],
        layerDecisionModel: Layer.succeed(DecisionModel.DecisionModel, decisionModel),
        layerLanguageModel
      }
    })
  )
  return { stored, mutations, requests, layer }
})

it.effect(
  "approves and persists the complete caller trait without generation for creation and clarification",
  Effect.fnUntraced(function* () {
    const proposal = Trait.Trait.make({
      ...proposedTrait,
      name: Trait.TraitName.make("state-updates"),
      applicability: "Editing state in TSX, except generated components.",
      purpose: "Keep state updates consistent.",
      guidance: "Update the state operation.",
      context: "A supporting example.\n"
    })
    for (const relationship of ["distinct", "clarification"] as const) {
      const test = yield* harness({ relationships: { [name]: relationship } })
      const pending = yield* derive({
        proposedTrait: proposal
      }).pipe(Effect.provide(test.layer))
      expect(pending).toMatchObject({
        _tag: "ApprovalRequired",
        message: expect.stringContaining(
          pipe(
            Trait.serialize(proposal),
            String.replace("name: state-updates", `name: ${relationship === "distinct" ? "state-updates" : name}`)
          )
        )
      })
      expect(test.mutations).toEqual([])
      const result = yield* derive({
        proposedTrait: proposal,
        approved: true
      }).pipe(Effect.provide(test.layer))
      expect(result).toMatchObject({
        _tag: relationship === "distinct" ? "Created" : "Updated",
        instructions: expect.stringContaining(`Saved traits: ${relationship === "distinct" ? "state-updates" : name}.`),
        trait: { ...proposal, name: relationship === "distinct" ? "state-updates" : name }
      })
      expect(test.stored.get(relationship === "distinct" ? proposal.name : name)).toEqual({
        ...proposal,
        name: relationship === "distinct" ? proposal.name : name
      })
      if (relationship === "clarification") {
        const cleared = yield* derive({ proposedTrait, approved: true }).pipe(Effect.provide(test.layer))
        expect(cleared).toMatchObject({ _tag: "Updated", trait: proposedTrait })
        expect(test.stored.get(name)).toEqual(proposedTrait)
      }
      expect(test.requests).toEqual([])
    }
  })
)

it.effect(
  "requires whole-project post-save trait checks for every saved outcome",
  Effect.fnUntraced(function* () {
    for (const relationship of ["distinct", "clarification", "conflict"] as const) {
      const test = yield* harness({ relationships: { [name]: relationship } })
      const result = yield* derive({
        proposedTrait: Trait.Trait.make({ ...proposedTrait, name: Trait.TraitName.make("state-updates") }),
        approved: true
      }).pipe(Effect.provide(test.layer))
      expect(result._tag).toBe(
        relationship === "distinct" ? "Created" : relationship === "clarification" ? "Updated" : "Resolved"
      )
      if (!("instructions" in result)) throw new Error("Expected post-save instructions")
      for (const requirement of [
        `Saved traits: ${relationship === "distinct" ? "state-updates" : name}.`,
        "Required post-save trait checks: This task is incomplete until you run check_traits against all eligible project-owned files",
        "traitNames set to the saved trait names",
        "Checking only changed files or the file that prompted the trait does not satisfy this requirement",
        "project-owned source, authored configuration, and documentation",
        "Respect trait applicability and configured exclusions",
        "dependencies, reference repositories, generated output, lockfiles, Git metadata, secrets, .env files, credentials, and binary assets",
        "minimal behavior-preserving edits",
        "rerun check_traits on corrected files, and run relevant verification",
        "ask before behavior-changing fixes or ambiguous interpretations",
        "explicitly report the blocker and state that the required post-save trait checks remain incomplete",
        "Saving a trait does not itself check or update project files"
      ]) {
        expect(result.instructions).toContain(requirement)
      }
    }
  })
)

it.effect(
  "does not generate replacements or mutate traits before approval",
  Effect.fnUntraced(function* () {
    const test = yield* harness({ relationships: { [name]: "conflict" } })
    const result = yield* derive({ proposedTrait }).pipe(Effect.provide(test.layer))
    expect(result._tag).toBe("ApprovalRequired")
    expect(test.requests).toEqual([])
    expect(test.mutations).toEqual([])
  })
)

it.effect(
  "requests explicit JSON and updates reused names without deleting replacements",
  Effect.fnUntraced(function* () {
    const test = yield* harness({ relationships: { [name]: "conflict" } })
    test.stored.set(
      name,
      Trait.Trait.make({
        ...original,
        applicability: "TypeScript, except generated files.",
        context: "Original context."
      })
    )
    const result = yield* derive({ proposedTrait, approved: true }).pipe(Effect.provide(test.layer))
    expect(result._tag).toBe("Resolved")
    expect(result).toMatchObject({
      instructions: expect.stringContaining(
        "This task is incomplete until you run check_traits against all eligible project-owned files"
      )
    })
    expect(test.mutations).toEqual(["update", "rm"])
    expect(test.stored.get(name)).toEqual(proposedTrait)
    expect(
      pipe(
        test.stored.values(),
        Array.fromIterable,
        Array.map((trait) => trait.requirement)
      )
    ).toEqual([proposedTrait.requirement])
    expect(test.requests).toHaveLength(1)
    expect(test.requests[0]?.prompt.content[0]).toMatchObject({
      role: "system",
      content: expect.stringContaining('Return only a JSON object with this shape: {"traits":[{"name":')
    })
  })
)

it.effect(
  "leaves originals untouched when generation returns invalid output",
  Effect.fnUntraced(function* () {
    for (const responseText of ["Use two spaces for indentation.", '{"traits":[]}']) {
      const test = yield* harness({ responseText, relationships: { [name]: "conflict" } })
      const error = yield* derive({ proposedTrait, approved: true }).pipe(Effect.provide(test.layer), Effect.flip)
      expect(error).toMatchObject({
        module: "LanguageModel",
        method: "generateObject",
        reason: { _tag: "StructuredOutputError" }
      })
      expect(test.mutations).toEqual([])
      expect([...test.stored.values()]).toEqual([original])
    }
  })
)

it.effect(
  "rejects duplicate replacement names and unaffected-name collisions before any writes",
  Effect.fnUntraced(function* () {
    const unaffected = Trait.Trait.make({
      name: Trait.TraitName.make("unrelated"),
      subject: "Other artifacts.",
      requirement: "Keep unrelated requirements.",
      purpose: "Preserve independent conventions."
    })
    for (const names of [
      ["replacement", "replacement"],
      ["replacement", unaffected.name]
    ]) {
      const test = yield* harness({
        relationships: { [name]: "conflict", [unaffected.name]: "distinct" },
        unaffected,
        responseText: JSON.stringify({
          traits: Array.map(names, (name) => ({
            ...proposedTrait,
            name
          }))
        })
      })
      const error = yield* derive({ proposedTrait, approved: true }).pipe(Effect.provide(test.layer), Effect.flip)
      expect(error).toBeInstanceOf(TraitStore.TraitAlreadyExistsError)
      expect(test.mutations).toEqual([])
      expect([...test.stored.values()]).toEqual([original, unaffected])
    }
  })
)

it.effect(
  "saves a new replacement name before removing the original",
  Effect.fnUntraced(function* () {
    const replacementName = Trait.TraitName.make("two-space-indentation")
    const test = yield* harness({
      relationships: { [name]: "conflict" },
      responseText: JSON.stringify({
        traits: [{ ...proposedTrait, name: replacementName }]
      })
    })
    const result = yield* derive({ proposedTrait, approved: true }).pipe(Effect.provide(test.layer))
    expect(result._tag).toBe("Resolved")
    expect(test.mutations).toEqual(["add", "rm"])
    expect([...test.stored.keys()]).toEqual([replacementName])
  })
)

const generationRequests = (result: TraitDerivation) => {
  if (result._tag !== "GenerationRequired") throw new Error(`Expected GenerationRequired, got ${result._tag}`)
  return result.requests
}

it.effect(
  "returns GenerationRequired for reconciliation without a language model, then resolves with agent output",
  Effect.fnUntraced(function* () {
    const test = yield* harness({ languageModel: false, relationships: { [name]: "conflict" } })
    const pending = yield* derive({ proposedTrait }).pipe(Effect.provide(test.layer))
    const [request] = generationRequests(pending)
    expect(generationRequests(pending)).toHaveLength(1)
    expect(request).toMatchObject({
      stage: "reconcile",
      instructions: expect.stringContaining('Return only a JSON object with this shape: {"traits":[{"name":'),
      input: expect.stringContaining(proposedTrait.requirement),
      jsonSchema: { type: "object", required: ["traits"] }
    })
    expect(test.mutations).toEqual([])
    const generated = [{ id: request!.id, output: { traits: [proposedTrait] } }]
    const approval = yield* derive({ proposedTrait, generated }).pipe(Effect.provide(test.layer))
    expect(approval).toMatchObject({
      _tag: "ApprovalRequired",
      message: expect.stringContaining(`Replacement traits:\n\n${Trait.serialize(proposedTrait)}`)
    })
    expect(test.mutations).toEqual([])
    const result = yield* derive({ proposedTrait, generated, approved: true }).pipe(Effect.provide(test.layer))
    expect(result).toMatchObject({ _tag: "Resolved", traits: [proposedTrait] })
    expect(test.mutations).toEqual(["update", "rm"])
    expect(test.stored.get(name)).toEqual(proposedTrait)
    expect(test.requests).toEqual([])
  })
)

it.effect(
  "returns GenerationRequired for decomposition without a language model and feeds agent output into reconciliation",
  Effect.fnUntraced(function* () {
    const test = yield* harness({ languageModel: false, decomposable: true, relationships: { [name]: "conflict" } })
    const decompose = generationRequests(yield* derive({ proposedTrait }).pipe(Effect.provide(test.layer)))
    expect(Array.map(decompose, (request) => request.stage)).toEqual(["decompose", "decompose"])
    expect(Array.map(decompose, (request) => request.input)).toEqual([
      Trait.serialize(original),
      Trait.serialize(proposedTrait)
    ])
    const generated = Array.map(decompose, (request, index) => ({
      id: request.id,
      output: { traits: [`Agent rule ${index}a.`, `Agent rule ${index}b.`] }
    }))
    const [reconcile] = generationRequests(yield* derive({ proposedTrait, generated }).pipe(Effect.provide(test.layer)))
    expect(reconcile).toMatchObject({ stage: "reconcile", input: expect.stringContaining("Agent rule 1b.") })
    const result = yield* derive({
      proposedTrait,
      generated: [...generated, { id: reconcile!.id, output: { traits: [proposedTrait] } }],
      approved: true
    }).pipe(Effect.provide(test.layer))
    expect(result).toMatchObject({ _tag: "Resolved", traits: [proposedTrait] })
    expect(test.stored.get(name)).toEqual(proposedTrait)
  })
)

it.effect(
  "fails loudly on agent output that does not match the generation schema",
  Effect.fnUntraced(function* () {
    const test = yield* harness({ languageModel: false, relationships: { [name]: "conflict" } })
    const [request] = generationRequests(yield* derive({ proposedTrait }).pipe(Effect.provide(test.layer)))
    const error = yield* derive({
      proposedTrait,
      generated: [{ id: request!.id, output: { traits: [] } }],
      approved: true
    }).pipe(Effect.provide(test.layer), Effect.flip)
    expect(error).toBeInstanceOf(Generation.GeneratedOutputError)
    expect(error).toMatchObject({ id: request!.id, stage: "reconcile" })
    expect(test.mutations).toEqual([])
    expect([...test.stored.values()]).toEqual([original])
  })
)
