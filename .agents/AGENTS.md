# Project Guidelines

All paths below are relative to the repository root.

## Workspace

- `traits/`: Effect-based MCP server and trait SDK.
- `traits.sh/`: static Vite + React site. This fork does not deploy it.
- Use bun to install packages and run scripts. Keep Node-compatible tooling; do not introduce Bun runtime APIs.
- Use `bun run --filter traits.sh dev` for the local Vite server and `bun run --filter traits.sh build` to build static assets.

## Verification

- Run checks from the root: `bunx vp check` for formatting/lint/types; `bun run check` (`bun check -b`) after TypeScript changes. Nothing is built or published: the `traits` bin runs `traits/main.ts` from source.
- Run affected suites: `bun run test:rules` and `bun run test:traits`. The traits suite may be empty; do not call an empty suite a behavior-test pass. The static site has no test project. `bun run test` runs checks and suites; docs-only edits need no tests.
- After dependency changes, run `bun install`.
- After frontend changes, run `bun run --filter traits.sh build`.
- Report failures, blocked checks, and empty/skipped suites accurately.

## Reference Repositories

- Treat submodules under `repos/` as read-only unless explicitly asked to modify them.
- Prefer relevant source, tests, and examples over guesses or web searches.
- Import normal package dependencies, never vendored source.
- For Effect patterns and API design, consult `repos/Effect-TS/effect/`.

## Effect

- Use `Effect.fn` with a concise span name for reusable Effect operations: `Effect.fn("<name>")(function* () { ... })` rather than `Effect.fn(function* () { ... })`. Retain `Effect.gen` for inline effect values and initialization.
- Prefer `Effect.fn` / `Effect.fnUntraced` over functions that only return `Effect.gen`, including callbacks such as `items.map(Effect.fn("processItem")(function* (item) { ... }))`.
- Apply transformations through additional function arguments to the wrapper. These receive the effect and the original arguments, so argument-dependent services do not require an outer arrow function:

  ```ts
  const process = Effect.fn("process")(
    function* (item: Item) {
      /* ... */
    },
    (effect, item) => Effect.provideService(effect, TheService, item)
  )
  ```

  Use the same form with `Effect.fnUntraced` in library code, without a span name.

- An outer callback returning `Effect.gen(...).pipe(...)` is appropriate when it needs to capture callback-local values for the pipeline, e.g. `(item) => Effect.gen(function* () { ... }).pipe(Effect.provide(outerThing))`. Merely referencing an outer value does not require this exception: prefer a wrapper transformation when it can capture that value directly.

## Layer Naming

- When a module's primary layer represents its core service, export it as `layer`.
- Include the service or role only when the module exports multiple layers and `layer` alone would not identify what each provides.
- Add implementation or backend qualifiers after the service or role.
- When a layer is constructed from a particular input source, append `From<InputSource>`.

```ts
// Module's core service
layer
layerFromConfig
layerFromEnv

// Multiple services or roles in one module
layerFoo
layerFooFromConfig
layerFooFromEnv

layerStoreRedis
layerStoreRedisFromConfig
```

General forms:

```text
layer[FromInputSource]
layer<ServiceOrRole>[Implementation][FromInputSource]
```

Avoid `XLive`, `XLayer`, `layerFooConfig`, and `layerFooEnv`.

## Configuration

Keep configuration minimal and deliberate: verify defaults, remove duplication, and avoid speculative abstractions.
