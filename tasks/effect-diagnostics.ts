import { presets, recommended } from "@effect/tsgo/oxlint-presets"
import { Data, Effect, Path, pipe, Record, String } from "effect"
import { Command } from "effect/cli"
import { ChildProcess, ChildProcessSpawner } from "effect/process"

interface PresetRules {
  readonly rules?: Readonly<Record<string, unknown>> | undefined
}

const projects = ["traits/tsconfig.json", "traits.sh/tsconfig.json", "tsconfig.node.json"]

const errorPresets = [presets.correctness, presets.antipattern, presets.effectNative, presets.style]

const ruleOverrides: Record<string, string> = {
  "effecttsgo/effect-succeed-with-void": "off",
  "effecttsgo/experimental-api-usage": "error",
  "effecttsgo/layer-merge-all-with-dependencies": "off",
  "effecttsgo/lazy-effect": "off",
  "effecttsgo/node-builtin-import": "off",
  "effecttsgo/prefer-schema-over-json": "off",
  "effecttsgo/return-effect-in-gen": "off",
  "effecttsgo/strict-effect-provide": "off",
  "effecttsgo/unstable-api-usage": "off"
}

const rulesOffByFile = [
  { file: "traits/TraitsConfig.ts", rule: "anyUnknownInErrorContext" },
  { file: "traits.sh/vite.config.ts", rule: "asyncFunction" }
]

class EffectDiagnosticsError extends Data.TaggedError("EffectDiagnosticsError")<{ readonly project: string }> {
  override get message() {
    return `Effect diagnostics failed for "${this.project}"`
  }
}

const ruleSeverities = (configs: ReadonlyArray<PresetRules>, severity: (configured: unknown) => string) =>
  Object.fromEntries(
    configs.flatMap((config) => Object.entries(config.rules ?? {}).map(([name, value]) => [name, severity(value)]))
  )

const configuredSeverity = (value: unknown) => {
  const level = globalThis.Array.isArray(value) ? value[0] : value
  return level === "warn" ? "warning" : globalThis.String(level)
}

const languageServiceRuleName = (oxlintName: string) =>
  pipe(oxlintName, String.replace("effecttsgo/", ""), String.kebabToSnake, String.snakeToCamel)

const diagnosticSeverity = () =>
  Record.mapEntries(
    {
      ...ruleSeverities(Object.values(presets), () => "off"),
      ...ruleSeverities([recommended], configuredSeverity),
      ...ruleSeverities(errorPresets, () => "error"),
      ...ruleSeverities([{ rules: ruleOverrides }], configuredSeverity)
    },
    (severity, name) => [languageServiceRuleName(name), severity]
  )

export const effectDiagnostics = Command.make("effect-diagnostics").pipe(
  Command.withHandler(
    Effect.fn("tasks.effectDiagnostics")(function* () {
      const path = yield* Path.Path
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const lspconfig = JSON.stringify({
        diagnostics: true,
        diagnosticSeverity: diagnosticSeverity(),
        overrides: rulesOffByFile.map(({ file, rule }) => ({
          include: [path.resolve(file)],
          options: { diagnosticSeverity: { [rule]: "off" } }
        }))
      })

      yield* Effect.forEach(
        projects,
        (project) =>
          ChildProcess.make(
            "effect-tsgo",
            ["diagnostics", "--project", path.resolve(project), "--format", "pretty", "--lspconfig", lspconfig],
            { stdout: "inherit", stderr: "inherit" }
          ).pipe(
            (command) => spawner.exitCode(command),
            Effect.filterOrFail(
              (exitCode) => exitCode === 0,
              () => new EffectDiagnosticsError({ project })
            )
          ),
        { discard: true }
      )
    })
  )
)
