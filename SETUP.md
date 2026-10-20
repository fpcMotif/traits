# Set up Traits

Traits is configured by your coding agent, following your project's conventions.
Follow these instructions inside the consumer's Git checkout.

## Instructions for the agent

### 1. Respect consumer configuration before every package-manager operation

**Every package-manager operation must respect the consumer's specific
configuration—not merely their choice of package manager.** This applies to
dependency checks, installs, updates, approvals, package runners, and skill
installation, including the manual examples below.

Read the project's instructions, `packageManager`, lockfiles, package manifests,
and applicable project/workspace configuration before running commands. Examples
include `pnpm-workspace.yaml`, `bunfig.toml`, `.npmrc`, and `.yarnrc.yml`;
inspect the files relevant to the consumer rather than assuming default
settings. Also review catalogs and existing agent configuration.

Preserve the configured workspace scope, dependency placement, catalogs,
overrides/resolutions, registries, authentication references, linker/hoisting
settings, and install-script/trust policies. Respect configured version and
release-age policies. Run commands from the appropriate workspace directory with
the configured package-manager version; do not bypass policies or rewrite
configuration to make installation succeed. If setup conflicts with those
settings, explain the conflict and ask before changing them. Never expose
registry credentials.

Ensure `traits`, `effect`, and `@effect/platform-node` are available to the
checkout that runs Traits. Reuse compatible dependencies already supplied by the
workspace; install only what is missing. Check resolution from the config's
location, not just whether a dependency appears in a manifest. Do not introduce
another lockfile, duplicate workspace dependencies, or silently upgrade an
existing Effect version. Check the installed Traits package's peer requirements
and ask before any compatibility migration.

### 2. Ask about providers and models

Before installing provider packages or writing `traits.ts`, ask the user which
decision provider and model to use. Offer `@effect/ai-typesafe` as the default.
It needs one key, `TYPESAFE_API_KEY`. The calling agent generates reconciliation
JSON, so no language model is needed. Install only the selected provider
packages, using the project's dependency conventions and compatible versions.

```ts
import { TypeSafeClient, TypeSafeDecisionModel } from "@effect/ai-typesafe"
import { Layer } from "effect"
import type { TraitsConfig } from "traits"

export default {
  layerDecisionModel: ({ model }: { readonly model: string }) =>
    TypeSafeDecisionModel.layer({ model }).pipe(
      Layer.provide(TypeSafeClient.layerConfig())
    )
} satisfies TraitsConfig
```

**Advanced: other providers.** Any Effect provider that supplies the
`DecisionModel` service works, for example OpenRouter's Decisions API. An
optional `layerLanguageModel` makes Traits generate reconciliation JSON itself.
Choose a language model that supports structured output.

### 3. Configure the current checkout

Create `traits.ts` at the current Git worktree root. Import `TraitsConfig` from
`traits` and use `export default { ... } satisfies TraitsConfig`. Build
`layerDecisionModel` and `layerLanguageModel` from the selected providers and
models, checking their installed APIs. `layerLanguageModel` is optional: without
it, the calling agent generates reconciliation JSON when `derive_trait` returns
`GenerationRequired`. Preserve existing configuration and ask before replacing
it. The selected providers determine the config's imports and model layers.

Every field is optional. Without `layerDecisionModel`, Traits uses the TypeSafe
decision model with its key from `TYPESAFE_API_KEY`, and `--model` picks the Jev
model. A checkout that only needs exclusions can use a `traits.ts` with no
imports:

```ts
export default { excludes: ["generated/**"] }
```

Git-ignored files are excluded by default. Explicit `excludes` can omit other
files; use patterns such as `**/dist/**` and `node_modules/**`. Keep the default
Git filter unless the user requests otherwise.

### 4. Keep credentials private

Explain which credentials the selected providers require. The TypeSafe default
uses `TYPESAFE_API_KEY`. Traits reads the process environment only and never
reads `.env` files. Keep the key in the macOS Keychain and resolve it with
Varlock. Declare it in a committed `.env.schema`:

```sh
# @sensitive
TYPESAFE_API_KEY=keychain("typesafe-api-key")
```

Then start Traits with `varlock run -- traits ...`, both in the MCP command and
in hooks. The first Keychain read asks the user to approve it. Never request
secret values in chat, print them, or commit them. Reconnect the server after
changing credentials.

### 5. Install the skill where the current agent discovers it

Identify the coding agent performing setup and default to configuring that
agent. Ask if its identity is unclear or the user wants additional agents
configured. Install the Traits package's bundled skill
(`skills/traits/SKILL.md`) in the project-local skill directory that the current
agent actually discovers—for example, `.agents/skills/traits/SKILL.md` for
OpenCode or `.claude/skills/traits/SKILL.md` for Claude Code. For other agents,
consult their current documentation and project configuration rather than
assuming a shared path. Preserve customizations and avoid duplicate copies.

Prefer native dependency-linked skills when the package manager supports them,
ensuring its targets include the current agent's skill directory. Otherwise use
the skills CLI with the installed package as its source and explicit agent
selection: agent-run subprocesses may skip the TUI. Verify that the skill is
discoverable by the current agent, not merely copied somewhere in the checkout.

For example, after a local installation, targeting Claude Code:

```sh
npx --yes skills add ./node_modules/traits --skill traits --agent claude-code
```

Adapt the package runner, source path, and agent name to the project. Do not
pass the skills CLI's `--yes` flag before reviewing any overwrite plan with the
user. Its installation is a snapshot; rerun after updating Traits.

### 6. Connect and verify

Merge a local Traits MCP server into the selected agents' existing settings,
preserving other servers. Consult the agent's current configuration format. Use
the project's package runner to launch the installed Traits CLI, with this
checkout root as the working directory. For npm, the command is `npx -y traits`.

Verify config imports and provider compatibility. When credentials are
available, connect the server and confirm `derive_trait` and `check_traits` are
exposed, and that the agent discovers the skill. Report manual
credential/reconnection steps and blocked checks without claiming setup passed.
Do not create a trait merely to test installation.

### 7. Optional: call Traits without MCP

Hooks and CI can run `traits check`, `traits derive` (input JSON on stdin), and
`traits ls` from the checkout root. `check` defaults to the changed files
(staged, unstaged, and untracked). It exits 0 when no finding reaches
`--fail-on` (default `fix`), 1 when one does, and 2 on an operational failure.
When nothing is selected, it prints a note on stderr and exits 0. `derive`
prints the tagged outcome as JSON and exits 2 on failure. Traits never installs
dependencies, so install them first. `check` skips a file and trait pair over
the Jev request budget, reports it as `skipped: too-large`, and counts it as
`unsure` for `--fail-on`. An operational failure prints one line on stderr. Add
`--verbose` for the full cause.

For an editor hook,
`traits check --stdin --stdin-filepath <repo-relative path> --kind edit|write`
checks code from stdin. Grouped traits under `.agents/traits/<group>/` are
read-only and use their `paths` and `when` filters.

To let `--model` choose the Jev model, export `layerDecisionModel` as a function
`({ model }) => Layer`. It receives `jev-latest` by default. A `Layer` export
keeps its own model, and `--model` then fails with exit 2.

To verify without a key, run `traits check --include 'traits.ts' --dry-run` and
confirm that it prints the plan and exits 0. With the key set, run
`traits check --include 'traits.ts' --json` and confirm that it prints JSON and
exits 0 or 1.

## Troubleshooting

### Dependency-linked skills

With pnpm 12.11+, install Traits using the project's conventions, then use
`pnpm approve` to review and approve its skills. pnpm links skills from the
installed package, keeping them aligned with updates and removing links when
approval or the dependency is removed. It targets existing agent skill
directories or the running agent's directory. If needed, configure targets
explicitly:

```yaml
# pnpm-workspace.yaml
skills:
  dirs:
    - .agents/skills
    - .claude/skills
```

An approved skill without a target makes installation fail. `pnpm dlx` and
global installs do not natively link skills. Other package managers can use the
skills CLI as described above. Older Traits versions copied the skill into
`.agents/skills/traits`; back up customizations and avoid loading that copy
alongside a package-managed skill.

### File filtering

Ignore rules refresh on every check. Untracked files do not need to be added to
Git to be evaluated; tracked files remain eligible even if an ignore pattern
matches them. Set `excludeGitignored: false` in `traits.ts` to disable the
filter, including for files outside the checkout. Explicit `excludes` still
apply. Git failures fail the check rather than bypass filtering.

### Startup failures

Configuration and providers initialize when the MCP server starts. If setup
fails, the connection stays alive with fallback `derive_trait` and
`check_traits` tools using the normal descriptions and parameters. Either tool
returns the original error diagnostics. Surface the failure, fix the reported
error, and restart the Traits MCP server to load the corrected setup. Then retry
the same operation; keep any trait proposal pending and retry its derivation
with identical arguments. Diagnostics include the full Effect cause and may
contain sensitive values embedded in errors; do not paste credentials into chat.
Expected tool failures use MCP error results; unexpected runtime defects receive
a generic internal error response.

### Stored trait parsing fails

If a stored trait cannot be parsed, tools return `TraitParseError` with the file
path and original diagnostic instead of stopping the server. Update all stored
traits to the format/schema of the currently installed `traits` package: inspect
its `Trait` schema and `serialize` format, preserving the rules and metadata.
Retry after fixing the files; no server restart is needed. A failed check is not
a clean review, and no automatic migration is performed.

### Reconciliation fails after approval

Conflict reconciliation and trait decomposition need schema-validated JSON. The
calling agent supplies it after `GenerationRequired`, or the optional
`LanguageModel` generates it. A `GeneratedOutputError` names the output that
does not match its schema. A `LanguageModel.generateObject` /
`StructuredOutputError` can mean the provider returned plain text instead of
JSON. Enable strict structured output in the language-model configuration.
Generation completes before replacements are written or originals are removed.

Use a model and route that support structured output. Traits also explicitly
describes the required JSON shape in its generation prompts, but provider-side
enforcement remains preferable. No changes to the decision-model configuration
are required for this setting.
