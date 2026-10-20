import { NodeServices } from "@effect/platform-node"
import { expect, it } from "@effect/vitest"
import { Effect, FileSystem, Path, pipe, Queue, Schema as S, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"

import { CheckTraits } from "../toolkit/CheckTraits.ts"
import { DeriveTrait } from "../toolkit/DeriveTrait.ts"

const effectUrl = new URL("../../node_modules/effect/dist/index.js", import.meta.url).href
const server = new URL("../main.ts", import.meta.url).pathname

for (const fixture of [
  {
    name: "throwing module",
    source: 'throw new Error("example module failure")',
    diagnostic: "example module failure"
  },
  { name: "invalid config", source: "export default {}", diagnostic: "layerDecisionModel" },
  {
    name: "missing credentials",
    source: `import { Config, Layer } from ${JSON.stringify(effectUrl)};
      export default { layerDecisionModel: Layer.effectDiscard(Config.Redacted("TRAITS_TEST_MISSING_KEY")), layerLanguageModel: Layer.empty }`,
    diagnostic: "TRAITS_TEST_MISSING_KEY"
  },
  {
    name: "provider defect",
    source: `import { Effect, Layer } from ${JSON.stringify(effectUrl)};
      export default { layerDecisionModel: Layer.effectDiscard(Effect.die("example provider defect")), layerLanguageModel: Layer.empty }`,
    diagnostic: "example provider defect"
  },
  {
    name: "arbitrary provider failure",
    source: `import { Effect, Layer } from ${JSON.stringify(effectUrl)};
      export default { layerDecisionModel: Layer.effectDiscard(Effect.fail({ _tag: "CustomFailure", message: "example custom failure" })), layerLanguageModel: Layer.empty }`,
    diagnostic: "example custom failure"
  },
  {
    name: "outdated stored trait",
    source: `import { Layer } from ${JSON.stringify(effectUrl)};
      export default { layerDecisionModel: Layer.empty, layerLanguageModel: Layer.empty }`,
    trait: "---\nname: outdated-trait\n---\nKeep this rule.\n",
    diagnostic: "Recovery requires developer consent"
  }
]) {
  it.effect(
    `keeps MCP connected with ${fixture.name}`,
    Effect.fn("test.TraitsInitialization")(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const directory = yield* fs.exists("/tmp/opencode")
      const cwd = yield* fs.makeTempDirectoryScoped({
        directory: directory ? "/tmp/opencode" : undefined,
        prefix: "traits-mcp-"
      })
      yield* spawner.exitCode(ChildProcess.make("git", ["init", "--quiet"], { cwd }))
      yield* fs.writeFileString(path.join(cwd, "traits.ts"), fixture.source)
      const traitPath = path.join(cwd, ".agents/traits/outdated-trait.md")
      if ("trait" in fixture) {
        yield* fs.makeDirectory(path.dirname(traitPath), { recursive: true })
        yield* fs.writeFileString(traitPath, fixture.trait)
      }
      const requests = yield* Queue.unbounded<string>()
      const responses = yield* Queue.unbounded<string>()
      const child = yield* spawner.spawn(
        ChildProcess.make(process.execPath, [server], {
          cwd,
          stdin: Stream.fromQueue(requests).pipe(Stream.encodeText),
          stderr: "inherit"
        })
      )
      yield* child.stdout.pipe(
        Stream.decodeText(),
        Stream.splitLines,
        Stream.runForEach((line) => Queue.offer(responses, line)),
        Effect.forkScoped
      )
      const request = Effect.fn("test.McpRequest")(function* (id: number, method: string, params: unknown = {}) {
        yield* Queue.offer(requests, `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`)
        while (true) {
          const line = yield* Queue.take(responses)
          const response = yield* pipe(
            line,
            S.decodeEffect(
              S.fromJsonString(
                S.Struct({
                  id: S.Int.pipe(S.optional),
                  result: S.Unknown.pipe(S.optional)
                })
              )
            )
          )
          if (response.id === id) return response.result
        }
      })
      const initialized = yield* request(1, "initialize", {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "test", version: "1" }
      })
      expect(initialized).toMatchObject({ serverInfo: { name: "traits" } })
      yield* Queue.offer(requests, `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`)
      const listed = yield* request(2, "tools/list")
      expect(listed).toMatchObject({
        tools: expect.arrayContaining([
          expect.objectContaining({ name: "check_traits", description: CheckTraits.description }),
          expect.objectContaining({ name: "derive_trait", description: DeriveTrait.description })
        ])
      })
      for (const index of [3, 4]) {
        const tool =
          index === 3
            ? { name: "check_traits", arguments: { include: [] } }
            : {
                name: "derive_trait",
                arguments: {
                  proposedTrait: {
                    name: "example",
                    subject: "An artifact.",
                    requirement: "Example requirement.",
                    purpose: "Preserve consistency."
                  }
                }
              }
        const result = yield* request(index, "tools/call", tool)
        expect(result).toMatchObject({
          isError: true,
          content: [{ type: "text", text: expect.stringContaining(fixture.diagnostic) }]
        })
        if ("trait" in fixture) {
          expect(JSON.stringify(result)).toContain(traitPath)
          expect(JSON.stringify(result)).toContain("TraitParseError")
          expect(JSON.stringify(result)).toContain("Ask the developer:")
          expect(JSON.stringify(result)).toContain("original arguments")
          expect(JSON.stringify(result)).toContain("A server restart is not necessary")
        } else {
          expect(JSON.stringify(result)).toContain("restart the Traits MCP server")
          if (tool.name === "derive_trait") {
            expect(JSON.stringify(result)).toContain("retry the same trait derivation with the identical arguments")
            expect(JSON.stringify(result)).toContain("No trait was saved")
          }
        }
      }
      if ("trait" in fixture) {
        const unchanged = yield* fs.readFileString(traitPath)
        expect(unchanged).toBe(fixture.trait)
        yield* fs.writeFileString(
          traitPath,
          "---\nname: outdated-trait\nsubject: An artifact.\nrequirement: Keep this rule.\npurpose: Preserve consistency.\n---\n"
        )
        const recovered = yield* request(6, "tools/call", { name: "check_traits", arguments: { include: [] } })
        expect(recovered).toMatchObject({ isError: false })
      }
      const ping = yield* request(5, "ping")
      expect(ping).toEqual({})
    }, Effect.provide(NodeServices.layer)),
    { timeout: 20000 }
  )
}
