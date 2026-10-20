import {
  Array,
  Cause,
  Context,
  Effect,
  FileSystem,
  flow,
  Layer,
  Path,
  pipe,
  PlatformError,
  Predicate,
  Schema as S,
  String
} from "effect"

import * as Trait from "./Trait.ts"

export class TraitParseError extends S.TaggedError<TraitParseError>()("TraitParseError", {
  path: S.String,
  cause: S.Defect()
}) {
  override get message() {
    const diagnosis = S.isSchemaError(this.cause)
      ? "The document does not match the installed Trait schema. This may be a legacy format or invalid field values; inspect it before deciding migration is appropriate."
      : "The document could not be parsed. Inspect the original diagnostic for malformed YAML or missing/unterminated frontmatter; do not assume this is a schema migration."
    return String.stripMargin(`
    | Unable to parse trait ${this.path}.
    | ${Cause.pretty(Cause.fail(this.cause))}
    |
    | ${diagnosis}
    | Recovery requires developer consent. Ask the developer: "May I automatically resolve the stored-trait parse errors and retry the blocked operation?"
    | Do not change files before approval. Do not merely report the blocker and stop without offering this recovery choice. If declined, leave files unchanged and report the operation as incomplete.
    | After approval, inspect the entire affected trait store, not just the first failing file. Classify each failure and migrate repairable legacy formats to the installed Trait schema; repair malformed documents only where the intended content is clear.
    | Preserve names, authoritative requirements, applicability, exceptions, examples, and all other supporting context. If a repair is ambiguous or unsupported, ask a focused question rather than guessing, inventing intent, or dropping information. Leave already-valid traits unchanged.
    | The current format requires name, subject, requirement, and purpose in YAML frontmatter; applicability and guidance are optional text, and the Markdown body is optional context. Purpose explains intended benefit, not additional obligations. Legacy body requirements belong in requirement; when/mime/skip become applicability prose; diffs and additional information belong in context.
    | Validate all files in the affected store with the installed Trait schema and serialize format before retrying the originally blocked operation with its original arguments. A server restart is not necessary: repaired files are read on retry.
    | No automatic migration has occurred. The original operation failed; do not treat it as successful or claim a completed check until the retry succeeds.
    `)
  }
}

export class TraitNotFoundError extends S.TaggedError<TraitNotFoundError>()("TraitNotFoundError", {
  name: Trait.TraitId
}) {
  override get message() {
    return `Trait ${this.name} was not found`
  }
}

export class TraitAlreadyExistsError extends S.TaggedError<TraitAlreadyExistsError>()("TraitAlreadyExistsError", {
  name: Trait.TraitId
}) {
  override get message() {
    return `Trait ${this.name} already exists`
  }
}

export class TraitFilenameMismatchError extends S.TaggedError<TraitFilenameMismatchError>()(
  "TraitFilenameMismatchError",
  { path: S.String, expectedFilename: S.String }
) {
  override get message() {
    return `Trait filename must be ${this.expectedFilename}, received ${this.path}`
  }
}

export class GroupedTraitReadOnlyError extends S.TaggedError<GroupedTraitReadOnlyError>()("GroupedTraitReadOnlyError", {
  name: Trait.GroupedTraitName
}) {
  override get message() {
    return `Grouped trait ${this.name} is read-only here. Change it in its group folder's own repository.`
  }
}

export const TraitStoreError = S.Union([
  S.Struct({ ...TraitNotFoundError.fields, message: S.String }),
  S.Struct({ ...GroupedTraitReadOnlyError.fields, message: S.String }),
  S.Struct({ ...TraitAlreadyExistsError.fields, message: S.String }),
  S.Struct({ ...TraitFilenameMismatchError.fields, message: S.String }),
  S.Struct({ ...TraitParseError.fields, message: S.String }),
  S.TaggedStruct("PlatformError", { message: S.String })
])

export class TraitStore extends Context.Service<
  TraitStore,
  {
    readonly add: (
      trait: Trait.Trait
    ) => Effect.Effect<Trait.Trait, PlatformError.PlatformError | TraitAlreadyExistsError | GroupedTraitReadOnlyError>
    readonly update: (
      trait: Trait.Trait
    ) => Effect.Effect<
      void,
      | PlatformError.PlatformError
      | TraitParseError
      | TraitNotFoundError
      | TraitFilenameMismatchError
      | GroupedTraitReadOnlyError
    >
    readonly get: (
      name: Trait.TraitId
    ) => Effect.Effect<
      Trait.Trait,
      PlatformError.PlatformError | TraitParseError | TraitNotFoundError | TraitFilenameMismatchError
    >
    readonly ls: Effect.Effect<
      ReadonlyArray<Trait.Trait>,
      PlatformError.PlatformError | TraitParseError | TraitFilenameMismatchError
    >
    readonly rm: (
      names: ReadonlyArray<Trait.TraitId>
    ) => Effect.Effect<
      void,
      | PlatformError.PlatformError
      | TraitParseError
      | TraitNotFoundError
      | TraitFilenameMismatchError
      | GroupedTraitReadOnlyError
    >
  }
>()("traits/TraitStore") {}

export const layerFileSystem = (dir: string) =>
  Layer.effect(
    TraitStore,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const root = path.resolve(dir)
      yield* fs.makeDirectory(root, { recursive: true })

      const traitPath = (name: Trait.TraitId) => path.join(root, `${name}.md`)
      const readFile = Effect.fn("TraitStore.readFile")(function* (file: string) {
        const text = yield* fs.readFileString(file)
        return yield* Trait.parse(text, file).pipe(
          Effect.mapError((cause) => TraitParseError.make({ path: file, cause })),
          Effect.filterOrFail(
            (trait) => traitPath(trait.name) === file,
            (trait) => TraitFilenameMismatchError.make({ path: file, expectedFilename: `${trait.name}.md` })
          )
        )
      })
      const readGrouped = Effect.fn("TraitStore.readGrouped")(function* (file: string) {
        const text = yield* fs.readFileString(file)
        const name = `${path.basename(path.dirname(file))}/${path.basename(file, ".md")}`
        return yield* S.decodeEffect(Trait.GroupedTraitName)(name).pipe(
          Effect.flatMap((name) => Trait.parseGrouped(text, file, name)),
          Effect.mapError((cause) => TraitParseError.make({ path: file, cause }))
        )
      })
      const get = Effect.fn("TraitStore.get")((name: Trait.TraitId) =>
        (Trait.isGrouped(name) ? readGrouped(traitPath(name)) : readFile(traitPath(name))).pipe(
          Effect.catchTags({
            PlatformError: (error) =>
              error.reason._tag === "NotFound" ? TraitNotFoundError.make({ name }) : Effect.fail(error)
          })
        )
      )
      const writable = (name: Trait.TraitId) =>
        Trait.isGrouped(name) ? GroupedTraitReadOnlyError.make({ name }) : Effect.void
      const readEntries = Effect.fn("TraitStore.readEntries")(function* (
        directory: string,
        read: (file: string) => ReturnType<typeof readFile>
      ) {
        const names = yield* fs.readDirectory(directory)
        return yield* pipe(
          names,
          Array.sort(String.Order),
          Array.filter(String.endsWith(".md")),
          Effect.forEach(
            Effect.fn("TraitStore.readEntry")(function* (name) {
              const file = path.join(directory, name)
              const info = yield* fs.stat(file)
              if (info.type !== "File") return undefined
              return yield* read(file)
            }),
            { concurrency: 1 }
          ),
          Effect.map(Array.filter(Predicate.isNotUndefined))
        )
      })

      return TraitStore.of({
        add: Effect.fn("TraitStore.add")(function* (trait) {
          yield* writable(trait.name)
          yield* fs.writeFileString(traitPath(trait.name), Trait.serialize(trait), { flag: "wx" }).pipe(
            Effect.catchTags({
              PlatformError: (error) =>
                error.reason._tag === "AlreadyExists"
                  ? TraitAlreadyExistsError.make({ name: trait.name })
                  : Effect.fail(error)
            })
          )
          return trait
        }),
        get,
        update: Effect.fn("TraitStore.update")(function* (trait) {
          yield* writable(trait.name)
          yield* get(trait.name)
          const file = yield* fs.open(traitPath(trait.name), { flag: "r+" })
          yield* file.truncate(0)
          yield* file.writeAll(new TextEncoder().encode(Trait.serialize(trait)))
        }, Effect.scoped),
        ls: Effect.gen(function* () {
          const flat = yield* readEntries(root, readFile)
          const entries = yield* fs.readDirectory(root)
          const groups = yield* Effect.filter(
            Array.sort(entries, String.Order),
            (entry) => Effect.map(fs.stat(path.join(root, entry)), (info) => info.type === "Directory"),
            { concurrency: 1 }
          )
          const readGroup = (group: string) => readEntries(path.join(root, group), readGrouped)
          const grouped = yield* Effect.forEach(groups, readGroup, { concurrency: 1 })
          return [...flat, ...Array.flatten(grouped)]
        }).pipe(Effect.withSpan("TraitStore.ls")),
        rm: Effect.fn("TraitStore.rm")(function* (names) {
          yield* Effect.forEach(names, writable, { discard: true })
          yield* Effect.forEach(
            names,
            flow(
              get,
              Effect.flatMap((trait) => fs.remove(traitPath(trait.name)))
            ),
            { discard: true }
          )
        })
      })
    }).pipe(Effect.withSpan("TraitStore.open"))
  )
