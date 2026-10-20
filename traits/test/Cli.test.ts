import { NodeServices } from "@effect/platform-node"
import { expect, it } from "@effect/vitest"
import { Effect, FileSystem, Path, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"

const effectUrl = new URL("../../node_modules/effect/dist/index.js", import.meta.url).href
const effectAiUrl = new URL("../../node_modules/effect/dist/ai/index.js", import.meta.url).href
const server = new URL("../main.ts", import.meta.url).pathname

const fakeDecide = `
const labels = {
  relationship: ["distinct", "covered", "clarification", "conflict", "inconclusive"],
  decomposition: ["atomic", "decomposable"]
}
const answer = (kind, label) => ({
  _tag: "Classify",
  label,
  probabilities: Object.fromEntries(labels[kind].map((key) => [key, key === label ? 1 : 0]))
})
const evaluation = (text) => {
  const probabilities = text.includes("VIOLATION")
    ? { compliant: 0, violation: 1, "not-applicable": 0, inconclusive: 0 }
    : text.includes("MAYBE")
      ? { compliant: 0.4, violation: 0.6, "not-applicable": 0, inconclusive: 0 }
      : text.includes("UNSURE")
        ? { compliant: 0.7, violation: 0, "not-applicable": 0, inconclusive: 0.3 }
        : { compliant: 1, violation: 0, "not-applicable": 0, inconclusive: 0 }
  const label = Object.entries(probabilities).sort((a, b) => b[1] - a[1])[0][0]
  return { _tag: "Classify", label, probabilities }
}
const decide = (request) => {
  const answers = {}
  for (const key of Object.keys(request.decisions)) {
    if (key !== "assessment") answers[key] = evaluation(request.state.source.text)
    else if ("trait" in request.state) answers[key] = answer("relationship", "conflict")
    else answers[key] = answer("decomposition", "atomic")
  }
  return Effect.succeed({ answers, usage: { inputTokens: 0, outputTokens: 0 } })
}
`

const fakeConfig = `import { Effect, Layer } from ${JSON.stringify(effectUrl)}
import { DecisionModel } from ${JSON.stringify(effectAiUrl)}
${fakeDecide}
export default { layerDecisionModel: Layer.effect(DecisionModel.DecisionModel, DecisionModel.make({ decide })) }
`

const keyedConfig = (marker: string) => `import { writeFileSync } from "node:fs"
import { Config, Effect, Layer } from ${JSON.stringify(effectUrl)}
import { DecisionModel } from ${JSON.stringify(effectAiUrl)}
export default {
  layerDecisionModel: Layer.effect(
    DecisionModel.DecisionModel,
    Effect.gen(function* () {
      yield* Config.Redacted("TRAITS_TEST_MISSING_KEY")
      return yield* DecisionModel.make({
        decide: () => Effect.sync(() => writeFileSync(${JSON.stringify(marker)}, "called")).pipe(Effect.andThen(Effect.die("unreachable")))
      })
    })
  )
}
`

const storedTrait =
  "---\nname: indentation\nsubject: Code indentation.\nrequirement: Use tabs for indentation.\npurpose: Keep indentation consistent.\n---\n"

const project = Effect.fn("test.CliProject")(function* (config: (cwd: string) => string | undefined) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "traits-cli-" })
  const git = (...args: ReadonlyArray<string>) =>
    spawner.exitCode(ChildProcess.make("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd }))
  yield* git("init", "--quiet")
  const source = config(cwd)
  if (source !== undefined) yield* fs.writeFileString(path.join(cwd, "traits.ts"), source)
  yield* fs.makeDirectory(path.join(cwd, ".agents/traits"), { recursive: true })
  yield* fs.writeFileString(path.join(cwd, ".agents/traits/indentation.md"), storedTrait)
  for (const [file, text] of [
    ["clean.ts", "export const clean = 1\n"],
    ["bad.ts", "// VIOLATION\nexport const bad = 1\n"],
    ["maybe.ts", "// MAYBE\nexport const maybe = 1\n"],
    ["unsure.ts", "// UNSURE\nexport const unsure = 1\n"]
  ] as const) {
    yield* fs.writeFileString(path.join(cwd, file), text)
  }
  const run = Effect.fn("test.runCli")(function* (
    args: ReadonlyArray<string>,
    stdin = "",
    env?: Readonly<Record<string, string>>
  ) {
    const child = yield* spawner.spawn(
      ChildProcess.make(process.execPath, [server, ...args], {
        cwd,
        stdin: Stream.make(stdin).pipe(Stream.encodeText),
        ...(env === undefined ? {} : { env })
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
  return { cwd, git, run }
})

it.effect(
  "check exits by --fail-on: 0 below it, 1 at or above it, 2 on failure, 0 with a note when nothing is selected",
  Effect.fn("test.CliCheck")(function* () {
    const { run } = yield* project(() => fakeConfig)
    const clean = yield* run(["check", "--include", "clean.ts", "--json"])
    expect(clean.exitCode).toBe(0)
    expect(JSON.parse(clean.stdout)).toMatchObject({
      findings: [],
      summary: { files: 1, traits: 1, requests: 1, verdicts: { fix: 0, check: 0, unsure: 0, pass: 1 } }
    })
    const fix = yield* run(["check", "--include", "clean.ts", "--include", "bad.ts", "--json"])
    expect(fix.exitCode).toBe(1)
    expect(JSON.parse(fix.stdout).findings).toMatchObject([
      {
        trait: { name: "indentation" },
        source: { location: { _tag: "File", path: expect.stringContaining("bad.ts"), startLine: 1 } },
        assessment: { classification: "violation", probabilities: { violation: 1 }, verdict: "fix" }
      }
    ])
    const human = yield* run(["check", "--include", "bad.ts"])
    expect(human.exitCode).toBe(1)
    expect(human.stdout).toMatch(/^fix\s+bad\.ts:1 indentation p\(violation\) 1\.00/m)
    const quiet = yield* run(["check", "--include", "bad.ts", "--quiet"])
    expect(quiet.stderr).not.toContain("judgments")
    const exits = (include: string, failOn: string) =>
      run(["check", "--include", include, "--fail-on", failOn]).pipe(Effect.map((result) => result.exitCode))
    expect(yield* exits("maybe.ts", "fix")).toBe(0)
    expect(yield* exits("maybe.ts", "check")).toBe(1)
    expect(yield* exits("unsure.ts", "check")).toBe(0)
    expect(yield* exits("unsure.ts", "unsure")).toBe(1)
    expect(yield* exits("bad.ts", "never")).toBe(0)
    const raised = yield* run(["check", "--include", "maybe.ts", "--check-threshold", "0.7", "--fail-on", "check"])
    expect(raised.exitCode).toBe(0)
    const nothing = yield* run(["check", "--include", "missing/**/*.ts", "--json"])
    expect(nothing.exitCode).toBe(0)
    expect(JSON.parse(nothing.stdout).findings).toEqual([])
    expect(nothing.stderr).toContain("selected nothing to check")
    const unknownTrait = yield* run(["check", "--include", "clean.ts", "--trait", "missing-trait"])
    expect(unknownTrait.exitCode).toBe(2)
    expect(unknownTrait.stderr).toContain("missing-trait")
    const conflicting = yield* run(["check", "--include", "clean.ts", "--target", "staged"])
    expect(conflicting.exitCode).toBe(2)
  }, Effect.provide(NodeServices.layer)),
  { timeout: 60000 }
)

it.effect(
  "check selects changed, staged, unstaged, and untracked files from Git",
  Effect.fn("test.CliTarget")(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const { cwd, git, run } = yield* project(() => fakeConfig)
    const planned = (target: string) =>
      run(["check", "--dry-run", "--json", "--target", target]).pipe(
        Effect.map((result) =>
          (JSON.parse(result.stdout).files as ReadonlyArray<{ readonly path: string }>).map((file) =>
            path.basename(file.path)
          )
        )
      )
    expect(yield* planned("untracked")).toEqual(expect.arrayContaining(["bad.ts", "clean.ts"]))
    yield* git("add", "-A")
    yield* git("commit", "--quiet", "-m", "base")
    expect(yield* planned("changed")).toEqual([])
    yield* fs.writeFileString(path.join(cwd, "clean.ts"), "export const clean = 2\n")
    yield* fs.writeFileString(path.join(cwd, "bad.ts"), "// VIOLATION\nexport const bad = 2\n")
    yield* git("add", "bad.ts")
    expect(yield* planned("unstaged")).toEqual(["clean.ts"])
    expect(yield* planned("staged")).toEqual(["bad.ts"])
    expect((yield* planned("changed")).sort()).toEqual(["bad.ts", "clean.ts"])
    const changed = yield* run(["check"])
    expect(changed.exitCode).toBe(1)
  }, Effect.provide(NodeServices.layer)),
  { timeout: 60000 }
)

it.effect(
  "check --dry-run plans without building the decision model or calling it, and .env files are never read",
  Effect.fn("test.CliDryRun")(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const markerPath = (cwd: string) => path.join(cwd, "decide-called")
    const { cwd, run } = yield* project((cwd) => keyedConfig(markerPath(cwd)))
    const plan = yield* run(["check", "--dry-run", "--json", "--include", "bad.ts", "--include", "clean.ts"])
    expect(plan.exitCode).toBe(0)
    expect(JSON.parse(plan.stdout)).toMatchObject({
      dryRun: true,
      files: [
        { path: expect.stringContaining("bad.ts"), traits: ["indentation"], chunks: 1, requests: 1 },
        { path: expect.stringContaining("clean.ts"), traits: ["indentation"], chunks: 1, requests: 1 }
      ],
      summary: { files: 2, traits: 1, pairs: 2, chunks: 2, requests: 2 }
    })
    expect(yield* fs.exists(markerPath(cwd))).toBe(false)
    yield* fs.writeFileString(path.join(cwd, ".env"), "TRAITS_TEST_MISSING_KEY=from-dotenv\n")
    const real = yield* run(["check", "--include", "bad.ts", "--json"])
    expect(real.exitCode).toBe(2)
    expect(real.stderr).toContain("TRAITS_TEST_MISSING_KEY")
    expect(yield* fs.exists(markerPath(cwd))).toBe(false)
  }, Effect.provide(NodeServices.layer)),
  { timeout: 60000 }
)

it.effect(
  "exits 2 when the traits config cannot load",
  Effect.fn("test.CliConfigFailure")(function* () {
    const { run } = yield* project(() => 'export default { excludes: "generated" }')
    const result = yield* run(["check", "--include", "clean.ts", "--json"])
    expect(result.exitCode).toBe(2)
    expect(result.stdout).toBe("")
    expect(result.stderr).toContain("excludes")
    expect(result.stderr.trim().split("\n")).toHaveLength(1)
    expect((yield* run(["derive"], "{}")).exitCode).toBe(2)
    const fixed = yield* project(() => fakeConfig)
    const model = yield* fixed.run(["check", "--include", "clean.ts", "--model", "other"])
    expect(model.exitCode).toBe(2)
    expect(model.stderr).toContain("--model other cannot apply")
  }, Effect.provide(NodeServices.layer)),
  { timeout: 60000 }
)

it.effect(
  "derive passes GenerationRequired through and --dry-run never writes",
  Effect.fn("test.CliDerive")(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const { cwd, run } = yield* project(() => fakeConfig)
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
    const generated = [{ id: outcome.requests[0].id, output: { traits: [proposedTrait] } }]
    const approval = yield* run(["derive"], JSON.stringify({ proposedTrait, generated }))
    expect(JSON.parse(approval.stdout)).toMatchObject({ _tag: "ApprovalRequired" })
    const dryRun = yield* run(["derive", "--dry-run"], JSON.stringify({ proposedTrait, generated, approved: true }))
    expect(dryRun.exitCode).toBe(0)
    expect(JSON.parse(dryRun.stdout)).toMatchObject({ _tag: "Resolved", dryRun: true, traits: [proposedTrait] })
    expect(yield* fs.readFileString(path.join(cwd, ".agents/traits/indentation.md"))).toBe(storedTrait)
    expect((yield* run(["derive"], "not json")).exitCode).toBe(2)
  }, Effect.provide(NodeServices.layer)),
  { timeout: 60000 }
)

it.effect(
  "check --stdin applies grouped paths and when to the given repo-relative path",
  Effect.fn("test.CliStdin")(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const { cwd, run } = yield* project(() => fakeConfig)
    yield* fs.makeDirectory(path.join(cwd, ".agents/traits/style"))
    yield* fs.writeFileString(path.join(cwd, ".agents/traits/style/tabs.md"), "# Prefer tabs\n\nIndent with tabs.\n")
    yield* fs.writeFileString(
      path.join(cwd, ".agents/traits/style/hooks.md"),
      "---\npaths:\n  - src/**/*.tsx\nwhen:\n  - usestate\n---\n# Hooks first\n\nCall hooks first.\n"
    )
    const stdin = (filepath: string, text: string, ...extra: ReadonlyArray<string>) =>
      run(["check", "--stdin", "--stdin-filepath", filepath, ...extra], text)
    const plannedTraits = (filepath: string, text: string, ...extra: ReadonlyArray<string>) =>
      stdin(filepath, text, "--kind", "edit", "--dry-run", "--json", ...extra).pipe(
        Effect.map((result) => JSON.parse(result.stdout).files[0].traits)
      )
    expect(yield* plannedTraits("src/View.tsx", "const [a] = useState(0)")).toEqual([
      "indentation",
      "style/hooks",
      "style/tabs"
    ])
    expect(yield* plannedTraits("src/View.tsx", "const a = 0")).toEqual(["indentation", "style/tabs"])
    expect(yield* plannedTraits("lib/View.tsx", "const [a] = useState(0)")).toEqual(["indentation", "style/tabs"])
    expect(yield* plannedTraits("src/View.tsx", "useState", "--trait", "style/hooks")).toEqual(["style/hooks"])
    const written = yield* stdin("src/View.tsx", "// VIOLATION\nconst [a] = useState(0)\n", "--kind", "write", "--json")
    expect(written.exitCode).toBe(1)
    const findings = JSON.parse(written.stdout).findings
    expect(findings.map((finding: { readonly trait: { readonly name: string } }) => finding.trait.name)).toEqual([
      "indentation",
      "style/hooks",
      "style/tabs"
    ])
    expect(findings[0]).toMatchObject({
      source: {
        location: { _tag: "File", path: expect.stringMatching(/traits-cli-[^/]+\/src\/View\.tsx$/), startLine: 1 }
      }
    })
    expect(yield* fs.exists(path.join(cwd, "src/View.tsx"))).toBe(false)
    expect((yield* run(["check", "--stdin"], "x")).exitCode).toBe(2)
    expect((yield* stdin("src/View.tsx", "x", "--include", "clean.ts")).exitCode).toBe(2)
    const listed = yield* run(["ls", "--json"])
    expect(JSON.parse(listed.stdout).map((entry: { readonly name: string }) => entry.name)).toEqual([
      "indentation",
      "style/hooks",
      "style/tabs"
    ])
  }, Effect.provide(NodeServices.layer)),
  { timeout: 60000 }
)

it.effect(
  "a traits.ts with only excludes and no imports uses the built-in TypeSafe model",
  Effect.fn("test.CliExcludesOnlyConfig")(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const { cwd, run } = yield* project(() => 'export default { excludes: ["generated/**", "**/*.md"] }')
    for (const [file, text] of [
      ["generated/out.ts", "export const out = 1\n"],
      [".hidden/x.md", "# Hidden\n"],
      ["docs/y.md", "# Docs\n"],
      [".hidden/kept.ts", "export const kept = 1\n"]
    ] as const) {
      yield* fs.makeDirectory(path.dirname(path.join(cwd, file)), { recursive: true })
      yield* fs.writeFileString(path.join(cwd, file), text)
    }
    const env = Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] => entry[0] !== "TYPESAFE_API_KEY" && entry[1] !== undefined
      )
    )
    const plan = yield* run(
      ["check", "--include", "**/*.ts", "--include", "**/*.md", "--include", ".hidden/*", "--dry-run", "--json"],
      "",
      env
    )
    expect(plan.exitCode).toBe(0)
    const root = yield* fs.realPath(cwd)
    const planned = JSON.parse(plan.stdout).files.map((file: { readonly path: string }) =>
      path.relative(root, file.path)
    )
    expect(planned).toEqual([".hidden/kept.ts", "bad.ts", "clean.ts", "maybe.ts", "traits.ts", "unsure.ts"])
    const missing = yield* run(["check", "--include", "bad.ts", "--json"], "", env)
    expect(missing.exitCode).toBe(2)
    expect(missing.stdout).toBe("")
    expect(missing.stderr).toContain("TYPESAFE_API_KEY is not set")
    expect(missing.stderr).not.toContain("Without traits.ts")
    expect(missing.stderr.trim().split("\n")).toHaveLength(1)
  }, Effect.provide(NodeServices.layer)),
  { timeout: 60000 }
)

it.effect(
  "without traits.ts, check uses the built-in TypeSafe config: dry runs need no key, a missing key exits 2",
  Effect.fn("test.CliDefaultConfig")(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const { cwd, run } = yield* project(() => undefined)
    const marker = path.join(cwd, "fetch-called")
    const stub = path.join(cwd, "stub-fetch.mjs")
    yield* fs.writeFileString(
      stub,
      `import { writeFileSync } from "node:fs"\nglobalThis.fetch = async () => { writeFileSync(${JSON.stringify(marker)}, "called"); throw new Error("network stubbed") }\n`
    )
    const { TYPESAFE_API_KEY: _ignored, ...inherited } = process.env
    const env = (extra: Readonly<Record<string, string>> = {}) => ({
      ...Object.fromEntries(
        Object.entries(inherited).filter((entry): entry is [string, string] => entry[1] !== undefined)
      ),
      NODE_OPTIONS: `--import=${stub}`,
      ...extra
    })
    const plan = yield* run(["check", "--include", "bad.ts", "--dry-run", "--json"], "", env())
    expect(plan.exitCode).toBe(0)
    expect(JSON.parse(plan.stdout)).toMatchObject({ files: [{ traits: ["indentation"], requests: 1 }] })
    const stdin = yield* run(
      ["check", "--stdin", "--stdin-filepath", "a.ts", "--kind", "edit", "--dry-run"],
      "export const x = 1\n",
      env()
    )
    expect(stdin.exitCode).toBe(0)
    const missing = yield* run(["check", "--include", "bad.ts", "--json"], "", env())
    expect(missing.exitCode).toBe(2)
    expect(missing.stdout).toBe("")
    for (const text of ["TYPESAFE_API_KEY", "typesafe-api-key", "Varlock"]) expect(missing.stderr).toContain(text)
    expect(missing.stderr.trim().split("\n")).toHaveLength(1)
    expect(missing.stderr).not.toMatch(/^\s+at /m)
    const verbose = yield* run(["check", "--include", "bad.ts", "--json", "--verbose"], "", env())
    expect(verbose.exitCode).toBe(2)
    expect(verbose.stderr).toContain("TYPESAFE_API_KEY")
    expect(verbose.stderr).toMatch(/^\s+at /m)
    expect(yield* fs.exists(marker)).toBe(false)
    const keyed = yield* run(
      ["check", "--include", "bad.ts", "--json"],
      "",
      env({ TYPESAFE_API_KEY: "test-key-value" })
    )
    expect(keyed.exitCode).toBe(2)
    expect(keyed.stderr).not.toContain("test-key-value")
    expect(yield* fs.exists(marker)).toBe(true)
  }, Effect.provide(NodeServices.layer)),
  { timeout: 60000 }
)

it.effect(
  "check skips a file × trait pair over the request budget and keeps checking the rest",
  Effect.fn("test.CliTooLarge")(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const { cwd, run } = yield* project(() => fakeConfig)
    const line = `export const value = "${"x".repeat(120)}"`
    yield* fs.writeFileString(path.join(cwd, "big.ts"), Array.from({ length: 200 }, () => line).join("\n"))
    const plan = yield* run(["check", "--include", "big.ts", "--include", "bad.ts", "--dry-run", "--json"])
    expect(plan.exitCode).toBe(0)
    const planned = JSON.parse(plan.stdout)
    expect(planned.files).toMatchObject([
      { path: expect.stringContaining("bad.ts"), requests: 1, skipped: [] },
      {
        path: expect.stringContaining("big.ts"),
        requests: 0,
        skipped: [{ trait: "indentation", startLine: 1, bytes: expect.any(Number), maxBytes: 24000 }]
      }
    ])
    expect(planned.files[1].skipped[0].bytes).toBeGreaterThan(24000)
    expect(planned.summary).toMatchObject({ requests: 1, skipped: 1 })
    const checked = yield* run(["check", "--include", "big.ts", "--include", "bad.ts", "--json"])
    expect(checked.exitCode).toBe(1)
    const report = JSON.parse(checked.stdout)
    expect(report.findings).toHaveLength(1)
    expect(report.skipped).toMatchObject([
      { path: expect.stringContaining("big.ts"), trait: "indentation", startLine: 1, maxBytes: 24000 }
    ])
    expect(report.summary).toMatchObject({ skipped: 1 })
    const human = yield* run(["check", "--include", "big.ts"])
    expect(human.exitCode).toBe(0)
    expect(human.stdout).toMatch(/^skip\s+big\.ts:1 indentation too-large \d+\/24000 bytes$/m)
    expect((yield* run(["check", "--include", "big.ts", "--fail-on", "unsure"])).exitCode).toBe(1)
    expect((yield* run(["check", "--include", "big.ts", "--fail-on", "check"])).exitCode).toBe(0)
  }, Effect.provide(NodeServices.layer)),
  { timeout: 60000 }
)

it.effect(
  "an existing traits.ts still wins over the built-in config",
  Effect.fn("test.CliConfigWins")(function* () {
    const { run } = yield* project(() => fakeConfig)
    const { TYPESAFE_API_KEY: _ignored, ...inherited } = process.env
    const env = Object.fromEntries(
      Object.entries(inherited).filter((entry): entry is [string, string] => entry[1] !== undefined)
    )
    const result = yield* run(["check", "--include", "bad.ts", "--json"], "", env)
    expect(result.exitCode).toBe(1)
    expect(result.stderr).not.toContain("TYPESAFE_API_KEY")
  }, Effect.provide(NodeServices.layer)),
  { timeout: 60000 }
)

it.effect(
  "ls lists stored trait names and source files",
  Effect.fn("test.CliLs")(function* () {
    const { cwd, run } = yield* project(() => "export default {}")
    const result = yield* run(["ls", "--json"])
    expect(result.exitCode).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual([
      {
        name: "indentation",
        path: expect.stringMatching(new RegExp(`${cwd.split("/").pop()}/\\.agents/traits/indentation\\.md$`))
      }
    ])
  }, Effect.provide(NodeServices.layer)),
  { timeout: 60000 }
)
