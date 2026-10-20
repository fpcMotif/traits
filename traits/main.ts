#!/usr/bin/env node
import { NodeRuntime, NodeServices } from "@effect/platform-node"
import { Effect, Layer, Logger, Option, Schema as S, String } from "effect"
import { McpProtocol, McpServer } from "effect/ai"
import { Command, Flag } from "effect/cli"
import { FetchHttpClient } from "effect/http"

import * as TraitsConfigProvider from "./_util/TraitsConfigProvider.ts"
import * as TraitsTelemetry from "./_util/TraitsTelemetry.ts"
import * as Cli from "./Cli.ts"
import PackageJson from "./package.json" with { type: "json" }
import * as ConfigurationError from "./toolkit/ConfigurationError.ts"
import { toolkit } from "./toolkit/toolkit.ts"
import * as TraitsConfig from "./TraitsConfig.ts"
import * as TraitStore from "./TraitStore.ts"

const layerTelemetry = (otlpEndpoint: Option.Option<URL>) =>
  TraitsTelemetry.layer(Option.getOrUndefined(otlpEndpoint)).pipe(Layer.provideMerge(FetchHttpClient.layer))

const serve = (otlpEndpoint: Option.Option<URL>) =>
  McpServer.layerStdio({
    name: "traits",
    version: PackageJson.version,
    protocols: [McpProtocol.v2025_11_25],
    instructions: String.stripMargin(`
      | Traits are durable, domain-neutral requirements with optional supporting context. The filesystem adapter stores each as .agents/traits/<name>.md, with a unique descriptive kebab-case name (no redundant trait- prefix) in frontmatter and no separate id.
      | The unique name is the canonical identity across storage backends. Use exact names for focused traitNames selections and ignore directives, not filenames. Update references after renaming. Duplicate names are rejected.
      | Before completing a response to a user correction, coding preference, or approved alternative idiom, check whether it expresses a reusable rule.
      | Treat multi-turn exchanges as a whole: asking about a better idiom and then approving it can establish a preference without saying "always" or "trait".
      | Err on the side of proposing a concise trait unless you have read an existing trait that clearly covers the exact rule and its scope.
      | If coverage is uncertain, propose the rule rather than silently assuming a broad trait covers it. If clearer wording is needed, propose a clarification.
      | Call the mutation tool with the drafted proposal first, leaving approved unset. Do not ask separately beforehand: native clients get an approval form.
      | derive_trait uses native MCP forms when usable, or returns ApprovalRequired with the complete proposal for that same interactive question flow.
      | Only on ApprovalRequired, show the full message using the interactive question tool: Save, Revise, Skip, plus its automatic free-text option. Use plain text only if that UI is unavailable.
      | Retry an identical approved proposal with approved: true; do not assert approval for changed wording or targets. Native forms still apply on supported clients.
      | RevisionRequired contains feedback to incorporate before requesting approval again; Declined means stop without writing.
      | Revise without actionable feedback requires an immediate interactive question asking what to change; never guess or treat it as Save.
      | Keep a revision pending across related audits or follow-up tasks. Complete that work, then return to the proposal unless explicitly cancelled.
      | Show the complete revised proposal and obtain fresh approval before saving; a findings summary does not resolve a pending revision.
      | Approval to edit code alone is not approval to persist a trait. Make the requested edit, but also propose the reusable rule before your final response.
      | Also act on explicit requests to remember a convention. Skip one-off requirements, transient facts, and preferences already covered.
      | Read existing trait files before drafting. Keep each trait concise and independently applicable, preserving scope and exceptions.
      | Frontmatter has required name, subject, requirement, and purpose; optional applicability and guidance are natural-language text. The optional Markdown body is context. No arbitrary frontmatter keys or domain-specific metadata profiles are supported.
      | Subject identifies what to assess; requirement is authoritative. Applicability adds circumstances and exceptions; omission adds no restriction beyond the subject. Purpose explains intent, guidance advises without granting authority, and context supports interpretation without hiding obligations.
      | Call derive_trait with proposedTrait containing the complete trait object, including name and optional context. Put useful examples, fenced code diffs, references, and domain facts in context. It saves only distinct requirements; Covered means reuse an existing trait.
      | Supply a complete replacement on clarification; omitted optional fields are removed. Approval and retries cover every field and the exact context.
      | A single clarification candidate is selected automatically and shown for approval; supply a complete replacement preserving the existing rule.
      | Multiple candidates return Clarification entries without writing: refine the proposal or clarify intent. Do not supply a clarification target.
      | After fallback approval, retry with the identical proposedTrait and approved: true; Updated preserves the selected existing name.
      | Every derive_trait response is one tagged TraitDerivation outcome. Created returns the saved trait with its unique name; Updated and Resolved return saved replacements.
      | Covered and Clarification return existing traits without writing. Inconclusive returns relationship findings and blocks all writes.
      | Inconclusive outcome findings use reason to distinguish conflict, coverage_gap, and inconclusive; clarify ambiguity before retrying.
      | Covered requires independent second-pass verification of the saved body and applicability metadata against the complete proposal. Similar intent is insufficient; coverage gaps enter approval-gated reconciliation and inconclusive verification blocks writes.
      | Confirmed conflicts and verified coverage gaps enter reconciliation inside derive_trait, selecting only the affected originals for an explicit replacement approval.
      | Approval must cover affected names, bodies, removals, the proposal, and generated reconciliation. Nothing is replaced silently.
      | After approval, reconciliation gives the proposal precedence in direct conflicts, updates selected names reused by replacements, saves new names, then removes only originals whose names were not reused. Unaffected names and duplicate generated names cannot be overwritten.
      | Resolved returns saved replacement bodies and unique names. Review them and check relevant code; do not derive the same proposal again.
      | Without a configured language model, reconciliation returns GenerationRequired. For each request, follow its instructions on its input and produce a JSON object matching its jsonSchema yourself.
      | Retry with the identical proposedTrait and generated set to every output so far as {id, output}. Repeat until another outcome. Approval then shows the generated replacements; retry with the same generated after fallback approval.
      | After generating or changing TypeScript files, call check_traits on those files.
      | check_traits accepts include as file paths or glob strings, for example include: ["traits/**/*.ts"]. Overlapping matches are deduplicated.
      | check_traits is a file-based adapter. Optional circumstances text supplies the triggering task, workflow stage, or surrounding facts. These inform assessment but do not authorize actions. Identify subjects, determine applicability, then assess requirements; missing evidence may be inconclusive rather than a violation.
       | Restrict assessments to project-owned source and relevant authored configuration/docs. Prefer an explicit project-file manifest for whole-project trait checks.
      | Never submit dependency/reference code, generated build output or lockfiles, Git metadata, secrets, .env files, credentials, or binary assets for assessment.
      | Unmatched patterns select nothing. Built-in exclusions cover dependencies, Git metadata, and nested worktrees; configure project-specific filenames or native glob patterns through TraitsConfig.excludes.
       | Required post-save trait checks after Created, Updated, or Resolved: This task is incomplete until you run check_traits against all eligible project-owned files, using traitNames set to the saved trait names. Checking only changed files or the file that prompted the trait does not satisfy this requirement.
       | Enumerate project-owned source, authored configuration, and documentation. Respect trait applicability and configured exclusions, including the exclusions above.
       | If blocked, explicitly report the blocker and state that the required post-save trait checks remain incomplete. Saving a trait does not itself check or update project files.
      | Omit traitNames for all traits; use specific names for focused follow-ups. Before committing or opening a PR, review the changed TypeScript files.
      | Checks read current full files in 200-line chunks, not Git diffs. A finding's startLine locates a chunk, not an exact violation.
      | Each finding includes assessment.classification and probabilities: inconclusive is unresolved context, not a confirmed violation. Probabilities are not calibrated guarantees.
      | Take responsibility for trait compliance whenever a violation is discovered, through tool findings or your own inspection.
      | Inspect each finding against its trait, scope, exceptions, and surrounding source; confirmed violations must be fixed without waiting for another user request.
      | Make minimal behavior-preserving edits to the implementation, not to the trait merely to silence a finding. Do not stop at a findings summary.
      | Rerun check_traits on every corrected file, then run relevant formatting, type, and behavior checks; repeat for remaining confirmed violations.
      | Triage raw findings against the exact rule, scope, exceptions, and source before reporting or editing. Do not blindly change correct code.
      | Routine user summaries should report confirmed issues, meaningful unresolved uncertainty, operational failures, and blockers requiring a decision.
      | Do not repeat rejected, irrelevant false positives as caveats or make them sound actionable. Keep raw results available in tool output and telemetry.
      | Discuss a rejected finding when the user requests audit details or it reveals a new material reliability problem; explain why it was rejected.
      | Never suppress actionable findings based only on confidence, assume a finding is false because similar ones were wrong, or claim an automated clean pass when raw findings remain.
      | If a fix requires a behavior change, broader authorization, or an ambiguous interpretation, ask a focused question and report the blocker.
      | Do not claim compliance while confirmed violations remain. Report model errors as incomplete reviews, not passes.
      | An empty result only means no failures for the selected files and traits; empty selections or an empty store perform no assessments.
      | On mutation errors, inspect the store before retrying: writes and removals are not transactional, and retries may duplicate saved traits.
      | On TraitParseError from loading stored traits, ask the developer whether to automatically resolve the parse errors and retry the blocked operation. Do not silently repair files or simply report a blocker without offering recovery. If declined, leave files unchanged and report the operation as incomplete.
      | After approval, inspect the entire affected store. Distinguish installed-schema mismatches and repairable legacy formats from malformed YAML or missing/unterminated frontmatter; not every parse error is a migration. Preserve names, authoritative requirements, applicability, exceptions, examples, and all supporting context; leave valid traits unchanged. Ask focused questions for ambiguous or unsupported repairs instead of guessing or dropping information.
      | Validate every affected-store file against the installed Trait schema and serialization format, then retry the originally blocked operation with its original arguments. No server restart is needed. The original failure is not a successful check; report success only after a successful retry. This recovery protocol is core MCP behavior, not a trait to save.
      `)
  }).pipe(
    Layer.provide(
      toolkit.pipe(
        Layer.provide(TraitStore.layerFileSystem(".agents/traits")),
        Layer.provide(TraitsConfig.layer),
        Layer.provide(TraitsConfigProvider.layer),
        Layer.catchCause(ConfigurationError.layer),
        Layer.provideMerge(McpServer.McpServer.layer)
      )
    ),
    Layer.launch,
    Effect.withSpan("traits.server"),
    Effect.provide(layerTelemetry(otlpEndpoint))
  )

const traits = Command.make("traits").pipe(
  Command.withSharedFlags({
    otlpEndpoint: Flag.String("otlp-endpoint").pipe(
      Flag.withSchema(
        S.URLFromString.check(
          S.makeFilter(
            (url) => url.protocol === "http:" || url.protocol === "https:" || "Use an HTTP(S) collector base URL."
          )
        )
      ),
      Flag.withDescription(
        "Export traces and logs as OTLP/HTTP JSON to this collector base URL (for example, http://127.0.0.1:4318). Disabled when omitted."
      ),
      Flag.optional
    )
  }),
  Command.withDescription("Run the traits MCP server over stdio, or a check or derive subcommand"),
  Command.withHandler((params) => serve(params.otlpEndpoint))
)

const mcp = Command.make("mcp", {}, () => Effect.flatMap(traits, (root) => serve(root.otlpEndpoint))).pipe(
  Command.withDescription("Run the traits MCP server over stdio")
)

const check = Command.make("check", Cli.checkFlags, (flags) =>
  Effect.flatMap(traits, (root) => Cli.runCheck(flags).pipe(Effect.provide(layerTelemetry(root.otlpEndpoint))))
).pipe(
  Command.withDescription(
    "Check files against traits with Jev. Exit 0 when nothing reaches --fail-on, 1 when something does, 2 on failure."
  )
)

const derive = Command.make("derive", Cli.deriveFlags, (flags) =>
  Effect.flatMap(traits, (root) => Cli.runDerive(flags).pipe(Effect.provide(layerTelemetry(root.otlpEndpoint))))
).pipe(
  Command.withDescription(
    "Read derive_trait input JSON from stdin and print the TraitDerivation outcome JSON. Exit 2 on failure."
  )
)

const ls = Command.make("ls", Cli.lsFlags, Cli.runLs).pipe(
  Command.withDescription("List stored traits with their names and source files.")
)

traits.pipe(
  Command.withSubcommands([mcp, check, derive, ls]),
  Command.run({ version: PackageJson.version }),
  Effect.provide(NodeServices.layer),
  Effect.tapCause(Cli.reportExit),
  Effect.provideService(Logger.LogToStderr, true),
  NodeRuntime.runMain({ disableErrorReporting: true })
)
