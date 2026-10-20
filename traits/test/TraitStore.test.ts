import { NodeServices } from "@effect/platform-node"
import { expect, it } from "@effect/vitest"
import { Effect, FileSystem, Path, Result } from "effect"

import * as Trait from "../Trait.ts"
import * as TraitStore from "../TraitStore.ts"

it.effect(
  "offers consent-based recovery with distinct schema and malformed-document diagnostics without writing",
  Effect.fn("test.TraitStore.parseError")(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: "traits-parse-" })
    const trait = Trait.Trait.make({
      name: Trait.TraitName.make("old-format"),
      subject: "Stored policies.",
      requirement: "Preserve this rule.",
      purpose: "Preserve stored intent."
    })
    const file = path.join(dir, "old-format.md")
    yield* Effect.gen(function* () {
      const store = yield* TraitStore.TraitStore
      for (const fixture of [
        {
          text: "---\nname: old-format\n---\nPreserve this rule.",
          tag: "SchemaError",
          diagnostic: "does not match the installed Trait schema"
        },
        {
          text: "---\nname: [\n---\nPreserve this rule.",
          tag: "InvalidYamlError",
          diagnostic: "do not assume this is a schema migration"
        }
      ]) {
        yield* fs.writeFileString(file, fixture.text)
        for (const operation of [store.ls, store.get(trait.name), store.update(trait), store.rm([trait.name])]) {
          const result = yield* operation.pipe(Effect.result)
          expect(Result.isFailure(result)).toBe(true)
          if (Result.isFailure(result)) {
            expect(result.failure).toMatchObject({
              _tag: "TraitParseError",
              path: file,
              cause: { _tag: fixture.tag },
              message: expect.stringContaining(fixture.diagnostic)
            })
            const { message } = result.failure
            for (const instruction of [
              "Ask the developer:",
              "Do not change files before approval",
              "If declined, leave files unchanged",
              "inspect the entire affected trait store",
              "authoritative requirements, applicability, exceptions, examples",
              "ask a focused question",
              "Validate all files",
              "original arguments",
              "A server restart is not necessary",
              "original operation failed"
            ])
              expect(message).toContain(instruction)
          }
        }
        const text = yield* fs.readFileString(file)
        expect(text).toBe(fixture.text)
      }
    }).pipe(Effect.provide(TraitStore.layerFileSystem(dir)))
  }, Effect.provide(NodeServices.layer))
)

it.effect(
  "stores complete traits by unique name without overwriting duplicates",
  Effect.fn("test.TraitStore")(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: "traits-names-" })
    const initial = Trait.Trait.make({
      name: Trait.TraitName.make("test-trait"),
      subject: "Asynchronous tests.",
      requirement: "Original",
      applicability: "In TypeScript and TSX, except when a synchronous framework contract must be preserved.",
      purpose: "Preserve test lifecycle behavior.",
      guidance: "Use the Effect-aware test APIs.",
      context: "Supporting context.\n\n---\nExample.\n"
    })
    yield* Effect.gen(function* () {
      const store = yield* TraitStore.TraitStore
      const added = yield* store.add(initial)
      expect(added).toEqual(initial)
      const loaded = yield* store.get(initial.name)
      expect(loaded).toEqual(initial)
      const updated = Trait.Trait.make({ ...initial, requirement: "Replacement", context: "Updated context.\n" })
      yield* store.update(updated)
      const reloaded = yield* store.get(initial.name)
      expect(reloaded).toEqual(updated)
      const listed = yield* store.ls
      expect(listed).toEqual([updated])
      const file = path.join(dir, `${initial.name}.md`)
      const text = yield* fs.readFileString(file)
      expect(text).toContain(`name: ${initial.name}`)
      expect(text).not.toContain("id:")
      const files = yield* fs.readDirectory(dir)
      expect(files).toEqual([`${initial.name}.md`])
      const collision = yield* store.add(initial).pipe(Effect.result)
      expect(Result.isFailure(collision)).toBe(true)
      if (Result.isFailure(collision)) {
        expect(collision.failure).toBeInstanceOf(TraitStore.TraitAlreadyExistsError)
        expect(collision.failure).toMatchObject({ name: initial.name })
      }
      const afterCollision = yield* store.get(initial.name)
      expect(afterCollision).toEqual(updated)
      const renamed = Trait.Trait.make({ ...updated, name: Trait.TraitName.make("renamed-trait") })
      const missingUpdate = yield* store.update(renamed).pipe(Effect.result)
      expect(Result.isFailure(missingUpdate)).toBe(true)
      if (Result.isFailure(missingUpdate)) expect(missingUpdate.failure).toBeInstanceOf(TraitStore.TraitNotFoundError)
      yield* store.add(renamed)
      yield* store.rm([initial.name])
      const afterRename = yield* store.ls
      expect(afterRename).toEqual([renamed])
      const missing = yield* store.get(initial.name).pipe(Effect.result)
      expect(Result.isFailure(missing)).toBe(true)
      if (Result.isFailure(missing))
        expect(missing.failure).toMatchObject({ _tag: "TraitNotFoundError", name: initial.name })
      yield* store.rm([renamed.name])
      const remaining = yield* store.ls
      expect(remaining).toEqual([])
    }).pipe(Effect.provide(TraitStore.layerFileSystem(dir)))
  }, Effect.provide(NodeServices.layer))
)

it.effect(
  "rejects mismatched filenames on reads, updates, removals, and listing",
  Effect.fn("test.TraitStore.nameMismatch")(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: "traits-mismatch-" })
    const actual = Trait.Trait.make({
      name: Trait.TraitName.make("actual-name"),
      subject: "An artifact.",
      requirement: "Preserve its identity.",
      purpose: "Avoid identity mismatches."
    })
    const wrongName = Trait.TraitName.make("wrong-name")
    const file = path.join(dir, `${wrongName}.md`)
    yield* fs.writeFileString(file, Trait.serialize(actual))
    yield* Effect.gen(function* () {
      const store = yield* TraitStore.TraitStore
      for (const operation of [
        store.get(wrongName),
        store.update(Trait.Trait.make({ ...actual, name: wrongName })),
        store.rm([wrongName]),
        store.ls
      ]) {
        const result = yield* operation.pipe(Effect.result)
        expect(Result.isFailure(result)).toBe(true)
        if (Result.isFailure(result))
          expect(result.failure).toMatchObject({
            _tag: "TraitFilenameMismatchError",
            path: file,
            expectedFilename: `${actual.name}.md`
          })
      }
      const text = yield* fs.readFileString(file)
      expect(text).toBe(Trait.serialize(actual))
      yield* store.add(actual)
      const loaded = yield* store.get(actual.name)
      expect(loaded).toEqual(actual)
    }).pipe(Effect.provide(TraitStore.layerFileSystem(dir)))
  }, Effect.provide(NodeServices.layer))
)

it.effect(
  "reads grouped traits by group/name with titles, paths, and when, and never writes inside a group",
  Effect.fn("test.TraitStore.grouped")(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: "traits-grouped-" })
    const flat = Trait.Trait.make({
      name: Trait.TraitName.make("indentation"),
      subject: "Code indentation.",
      requirement: "Use tabs for indentation.",
      purpose: "Keep indentation consistent."
    })
    const files = {
      "indentation.md": Trait.serialize(flat),
      "style/tabs.md": "\n# Prefer tabs\n\nIndent code with tabs.\n",
      "style/scoped_hooks.md":
        "---\npaths:\n  - src/**/*.tsx\nwhen:\n  - usestate\n  - '(unclosed'\n---\n## Hooks stay at the top\n\nCall hooks before any early return.\n",
      "style/nested/deep.md": "# Not a trait\n\nNested folders are not traits.\n",
      "style/notes.txt": "Not Markdown.\n"
    }
    for (const [file, text] of Object.entries(files)) {
      yield* fs.makeDirectory(path.dirname(path.join(dir, file)), { recursive: true })
      yield* fs.writeFileString(path.join(dir, file), text)
    }
    yield* Effect.gen(function* () {
      const store = yield* TraitStore.TraitStore
      const listed = yield* store.ls
      expect(listed.map((trait) => trait.name)).toEqual(["indentation", "style/scoped_hooks", "style/tabs"])
      const tabs = yield* store.get(Trait.GroupedTraitName.make("style/tabs"))
      expect(tabs).toEqual({
        name: "style/tabs",
        subject: "the code in the change",
        requirement: "# Prefer tabs\n\nIndent code with tabs.",
        purpose: "Prefer tabs"
      })
      const hooks = listed[1]!
      expect(hooks).toMatchObject({
        name: "style/scoped_hooks",
        purpose: "Hooks stay at the top",
        paths: ["src/**/*.tsx"],
        when: ["usestate"]
      })
      expect(Trait.appliesTo(hooks, { path: "src/app/View.tsx", text: "const [a] = useState(0)" })).toBe(true)
      expect(Trait.appliesTo(hooks, { path: "src/app/View.tsx", text: "const a = 0" })).toBe(false)
      expect(Trait.appliesTo(hooks, { path: "lib/View.tsx", text: "const [a] = useState(0)" })).toBe(false)
      expect(Trait.appliesTo(tabs, { path: "any/file.md", text: "" })).toBe(true)
      expect(Trait.appliesTo(flat, { path: "any/file.md", text: "" })).toBe(true)
      const replacement = Trait.Trait.make({ ...tabs, requirement: "Indent with spaces." })
      const failures = [
        yield* Effect.flip(store.add(replacement)),
        yield* Effect.flip(store.update(replacement)),
        yield* Effect.flip(store.rm([tabs.name]))
      ]
      for (const failure of failures)
        expect(failure).toMatchObject({
          _tag: "GroupedTraitReadOnlyError",
          name: "style/tabs",
          message: expect.stringContaining("read-only")
        })
      for (const [file, text] of Object.entries(files))
        expect(yield* fs.readFileString(path.join(dir, file))).toBe(text)
      expect((yield* fs.readDirectory(path.join(dir, "style"))).sort()).toEqual([
        "nested",
        "notes.txt",
        "scoped_hooks.md",
        "tabs.md"
      ])
    }).pipe(Effect.provide(TraitStore.layerFileSystem(dir)))
  }, Effect.provide(NodeServices.layer))
)
