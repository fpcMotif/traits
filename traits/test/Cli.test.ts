import { NodeServices } from "@effect/platform-node"
import { expect, it } from "@effect/vitest"
import { Effect, FileSystem, Path, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"

const effectUrl = new URL("../../node_modules/effect/dist/index.js", import.meta.url).href
const effectAiUrl = new URL("../../node_modules/effect/dist/ai/index.js", import.meta.url).href
const server = new URL("../main.ts", import.meta.url).pathname

const fakeConfig = `import { Effect, Layer } from ${JSON.stringify(effectUrl)}
import { DecisionModel } from ${JSON.stringify(effectAiUrl)}
const labels = {
  relationship: ["distinct", "covered", "clarification", "conflict", "inconclusive"],
  decomposition: ["atomic", "decomposable"],
  evaluation: ["compliant", "violation", "not-applicable", "inconclusive"]
}
const answer = (kind, label) => ({
  _tag: "Classify",
  label,
  probabilities: Object.fromEntries(labels[kind].map((key) => [key, key === label ? 1 : 0]))
})
const decide = (request) => {
  const answers = {}
  for (const key of Object.keys(request.decisions)) {
    if (key !== "assessment") answers[key] = answer("evaluation", request.state.source.text.includes("VIOLATION") ? "violation" : "compliant")
    else if ("trait" in request.state) answers[key] = answer("relationship", "conflict")
    else answers[key] = answer("decomposition", "atomic")
  }
  return Effect.succeed({ answers, usage: { inputTokens: 0, outputTokens: 0 } })
}
export default { layerDecisionModel: Layer.effect(DecisionModel.DecisionModel, DecisionModel.make({ decide })) }
`

const storedTrait =
  "---\nname: indentation\nsubject: Code indentation.\nrequirement: Use tabs for indentation.\npurpose: Keep indentation consistent.\n---\n"

const project = Effect.fn("test.CliProject")(function* (config: string) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "traits-cli-" })
  yield* spawner.exitCode(ChildProcess.make("git", ["init", "--quiet"], { cwd }))
  yield* fs.writeFileString(path.join(cwd, "traits.ts"), config)
  yield* fs.makeDirectory(path.join(cwd, ".agents/traits"), { recursive: true })
  yield* fs.writeFileString(path.join(cwd, ".agents/traits/indentation.md"), storedTrait)
  yield* fs.writeFileString(path.join(cwd, "clean.ts"), "export const clean = 1\n")
  yield* fs.writeFileString(path.join(cwd, "bad.ts"), "// VIOLATION\nexport const bad = 1\n")
  return Effect.fn("test.runCli")(function* (args: ReadonlyArray<string>, stdin = "") {
    const child = yield* spawner.spawn(
      ChildProcess.make(process.execPath, [server, ...args], {
        cwd,
        stdin: Stream.make(stdin).pipe(Stream.encodeText)
      })
    )
    const [stdout, stderr, exitCode] = yield* Effect.all(
      [
        child.stdout.pipe(Stream.decodeText(), Stream.mkString),
        child.stderr.pipe(Stream.decodeText(), Stream.mkString),
        child.exitCode
      ],
      { concurrency: "unbounded" }
    )
    return { stdout, stderr, exitCode }
  })
})

it.effect(
  "maps check results to exit codes: 0 clean, 1 findings, 3 nothing selected, 2 failure",
  Effect.fn("test.CliCheck")(function* () {
    const run = yield* project(fakeConfig)
    const clean = yield* run(["check", "--include", "clean.ts", "--json"])
    expect(clean.exitCode).toBe(0)
    expect(JSON.parse(clean.stdout)).toEqual([])
    const findings = yield* run(["check", "--include", "clean.ts", "--include", "bad.ts", "--json"])
    expect(findings.exitCode).toBe(1)
    expect(JSON.parse(findings.stdout)).toMatchObject([
      {
        trait: { name: "indentation" },
        source: { location: { _tag: "File", path: expect.stringContaining("bad.ts"), startLine: 1 } },
        assessment: { classification: "violation" }
      }
    ])
    const human = yield* run(["check", "--include", "bad.ts"])
    expect(human.exitCode).toBe(1)
    expect(human.stdout).toMatch(/bad\.ts:1 indentation violation/)
    const nothing = yield* run(["check", "--include", "missing/**/*.ts", "--json"])
    expect(nothing.exitCode).toBe(3)
    expect(JSON.parse(nothing.stdout)).toEqual([])
    expect(nothing.stderr).toContain("Selected nothing to check")
    const unknownTrait = yield* run(["check", "--include", "clean.ts", "--trait", "missing-trait"])
    expect(unknownTrait.exitCode).toBe(2)
    expect(unknownTrait.stderr).toContain("missing-trait")
  }, Effect.provide(NodeServices.layer)),
  { timeout: 30000 }
)

it.effect(
  "exits 2 when the traits config cannot load",
  Effect.fn("test.CliConfigFailure")(function* () {
    const run = yield* project("export default {}")
    const result = yield* run(["check", "--include", "clean.ts", "--json"])
    expect(result.exitCode).toBe(2)
    expect(result.stdout).toBe("")
    expect(result.stderr).toContain("layerDecisionModel")
    const derived = yield* run(["derive"], "{}")
    expect(derived.exitCode).toBe(2)
  }, Effect.provide(NodeServices.layer)),
  { timeout: 30000 }
)

it.effect(
  "derive reads derive_trait input from stdin and prints GenerationRequired without a language model",
  Effect.fn("test.CliDerive")(function* () {
    const run = yield* project(fakeConfig)
    const proposedTrait = {
      name: "indentation",
      subject: "Code indentation.",
      requirement: "Use two spaces for indentation.",
      purpose: "Keep indentation consistent."
    }
    const result = yield* run(["derive"], JSON.stringify({ proposedTrait }))
    expect(result.exitCode).toBe(0)
    const outcome = JSON.parse(result.stdout)
    expect(outcome).toMatchObject({
      _tag: "GenerationRequired",
      requests: [{ stage: "reconcile", input: expect.stringContaining("Use two spaces for indentation.") }]
    })
    const approval = yield* run(
      ["derive"],
      JSON.stringify({
        proposedTrait,
        generated: [{ id: outcome.requests[0].id, output: { traits: [proposedTrait] } }]
      })
    )
    expect(approval.exitCode).toBe(0)
    expect(JSON.parse(approval.stdout)).toMatchObject({ _tag: "ApprovalRequired" })
    const invalid = yield* run(["derive"], "not json")
    expect(invalid.exitCode).toBe(2)
  }, Effect.provide(NodeServices.layer)),
  { timeout: 30000 }
)
