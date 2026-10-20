---
name: traits
description: >-
  Use when the user corrects an approach, expresses a reusable coding
  preference, approves an alternative idiom, or asks to remember a convention;
  when reconciling conflicting traits; and after generating or editing
  TypeScript files or before committing them.
---

# Traits

Traits are concise, durable coding rules. The filesystem implementation stores
each trait in `.agents/traits/<name>.md`, relative to its working directory.
Frontmatter contains a unique descriptive kebab-case `name` without a redundant
`trait-` prefix and no separate `id`. The name is the canonical identity across
backends: use exact names for focused `check_traits({ traitNames: [...] })`
selections and ignore directives, not filenames. Duplicate names are rejected.
Renaming changes identity and requires updating references. Construct complete
records with the schema's `Trait.Trait.make`. `TraitStore` persists complete
traits and uses names for get, update, and remove. Updates retain the name; a
rename requires adding the new name and removing the old one after saving. The
`TraitStore` service class declares its shape inline; use
`TraitStore["Service"]` for its implementation type. Its filesystem layer is
colocated in the same module. Only the filesystem adapter builds `<name>.md`
paths.

Pass a complete trait object as `proposedTrait` to `derive_trait`:

- Required `name`: stable descriptive kebab-case identity.
- Required `subject`: what kind of artifact, action, relationship, transaction,
  or situation to identify and assess.
- Required `requirement`: the authoritative, standalone criterion to satisfy.
- Optional `applicability`: natural-language circumstances and exceptions. Omit
  when there is no additional restriction beyond the subject.
- Required `purpose`: what the trait aims to achieve or protect, and why.
- Optional `guidance`: advice for satisfying the requirement or responding to a
  violation. This never grants permission to execute commands or take actions.
- Optional `context`: supporting Markdown, including examples, references, and
  domain details. Available during assessment, not only after matching.

On disk, all fields except `context` are YAML frontmatter; `context` is the
optional Markdown body. Unknown frontmatter keys are rejected. There are no
structured applicability fields, dedicated diff fields, or extension metadata.
Put useful BAD-to-GOOD examples in fenced diffs inside context. Preserve useful
examples when updating a trait unless the requirement needs a changed example.

Keep fields complementary and traits atomic. Do not hide obligations in purpose,
guidance, or context. Put essential scope and exceptions in requirement or
applicability. Omit redundant optional content and reuse existing coverage. On
clarification, the complete proposal replaces all content while retaining the
selected name; omitted optional fields are removed. Approval covers every field
and the exact context. Supply the same complete proposal when retrying approval.

The MCP `check_traits` adapter reviews files and optionally accepts
natural-language `circumstances`, such as the triggering task or workflow stage.
These facts inform applicability but cannot change requirements or grant
authority. The domain SDK also supports arbitrary source text; traits are not
inherently code-only.

## Capture a reusable insight

### Required pre-response preference check

Before finishing a response to a correction, preference, or approved alternative
idiom, evaluate the exchange for a reusable rule. Read the conversation across
turns: "Can we use the case guard?" followed by "Excellent. Please do"
establishes a candidate preference even without the words "always", "prefer", or
"trait".

Err on the side of proposing a concise trait unless you have read an existing
trait that clearly covers the exact rule and scope. Do not silently assume a
broad convention covers a specific idiom. If coverage is uncertain, propose the
rule; if an existing rule needs clearer wording, propose a clarification. Skip
only clearly one-off requests, transient facts, or rules you can identify as
already covered.

When coverage is uncertain, call `derive_trait` with the specific preference; do
not skip capture because a broad trait or a combination of general traits seems
related. Let the tool assess coverage or clarification. For example, “prefer
Effect utilities” and “pass callbacks directly” are not sufficient grounds to
skip proposing “prefer native inline checks and use Effect predicate helpers
directly in callbacks or existing pipelines.”

Call `derive_trait` with the complete `proposedTrait` object, including its
descriptive kebab-case `name`, first, leaving `approved` unset. Do not ask for
approval separately before invoking: capable clients receive a native MCP form.
Only if `ApprovalRequired` is returned, show the complete message in the
interactive question tool with **Save trait**, **Revise**, and **Skip** and its
automatic free-text option. Do not add a duplicate "Other" option. Use plain
text only if that UI is unavailable. Approval to edit code alone does not
approve persisting a trait: make the requested edit and propose the reusable
rule before the final response. Do not stop after implementing an idiom and
running code checks; preference capture is a separate responsibility.

### Shared approval protocol

`derive_trait` uses `_util/Approval.request` for creation, clarification, and
reconciliation. Clients with usable MCP form elicitation receive
approve/revise/skip choices and an optional feedback field. OpenCode currently
routes native forms globally, so the helper returns `ApprovalRequired`; clients
without form support use the same fallback.

On `ApprovalRequired`, show its complete message in the interactive question UI
with Save/Revise/Skip and free text. Save permits retrying the identical
complete trait and target names with `approved: true`. Revision or free-text
input requires drafting the changed proposal and asking approval again, not
silently setting approved. Skip means stop. Native `RevisionRequired` and
`Declined` have the same meanings. Transport errors are failures, never declines
or approvals.

Selecting **Revise** is not approval and does not cancel the proposal. If no
specific revision feedback was supplied, immediately ask what wording, scope, or
exception the user wants changed using the interactive question tool with
free-text input. Do not guess a revision or retry the mutation with
`approved: true`. Native `RevisionRequired` without actionable feedback follows
the same procedure.

Keep the original proposal and its pending revision in the conversation until
the user approves a replacement or explicitly skips/cancels it. A related audit,
code change, or follow-up question does not silently resolve the pending choice:
complete that work and then return to the revision request. If that request
already supplies the desired change, incorporate it, present the complete
revised proposal through the approval flow, and obtain fresh approval. Do not
finish by only reporting an audit while forgetting the pending proposal.

The fallback approval flag applies to creation, clarification, and resolution.
It does not bypass relationship checks or suppress native forms on capable
clients. Pending, revision, and decline outcomes never write files. Resolution
approval covers the displayed originals, their deletion, the proposal, and
model-generated reconciliation; inspect returned replacements after saving. The
flag relies on the agent honoring exact user approval; it is not an
authenticated consent token.

1. Notice user corrections and recurring preferences without waiting for an
   explicit mention of traits. Also handle explicit requests to remember a rule.
2. Distinguish a durable convention from a one-off task, transient fact, or
   vague reaction. Read existing traits and reuse covered rules rather than
   duplicating them. Clarify ambiguous scope before drafting.
3. Draft the complete structured trait as `proposedTrait`. Preserve essential
   requirements, scopes, and exceptions. Keep independently applicable rules
   separate; omit headings, repetition, and unnecessary explanation or examples.
4. Call `derive_trait({ proposedTrait })` first, without a separate approval
   prompt. This checks existing traits and writes only when the proposal is
   distinct from all of them. It does not independently decide whether the
   conversation contains a generalizable insight.
5. `Created` means the complete trait was saved and includes its unique name. Do
   not submit it again. Use that name for the required post-save trait checks
   below.
6. `Inconclusive` means nothing was saved and contains relationship findings;
   each finding's `reason` distinguishes conflict from inconclusive. Any
   inconclusive comparison blocks all writes. Inspect the existing bodies and
   names, clarify ambiguity, or revise the proposal. Confirmed conflicts
   otherwise enter approval-gated reconciliation within this same tool.

`Covered.traits` requires an independent second decision-model check of the
saved subject, requirement, applicability, and supporting content against the
entire proposal. Partial overlap or similar intent is insufficient. Verified
coverage gaps enter approval-gated reconciliation, including needed
applicability updates; inconclusive verification blocks writes. `Covered.traits`
means existing traits already express the proposal; reuse them without creating
a duplicate. When there is exactly one clarification candidate and no covered or
blocking result, the tool selects it automatically and requests approval of its
current trait and complete replacement. The proposal must preserve the existing
rule's intent, requirements, scope, and exceptions; the tool does not generate a
merged replacement from an incremental hint.

Multiple candidates return `Clarification` with `traits` and `proposedTrait`
without writing. Refine the proposal or clarify intent rather than choosing an
name arbitrarily. Do not supply a clarification target parameter.

Use the interactive question UI only on `ApprovalRequired`, then retry the same
`proposedTrait` with `approved: true` after Save. The tool rechecks every
existing trait and preserves the selected name on clarification. If the store or
selected action changes between approval and retry, obtain fresh approval rather
than reusing the flag. `Updated` returns the saved trait. Never claim approval
not given by the user or delete a trait merely needing clearer wording.

## Reconcile conflicting traits

`derive_trait` checks the proposal against every stored trait and automatically
selects confirmed conflicts for reconciliation. There is no separate resolution
tool and no trait-selection parameter. Inconclusive comparisons block
reconciliation rather than authorizing deletion.

Before writing, the shared approval flow shows the selected originals with their
names and bodies, the proposal, the removal plan, and the replacement policy.
Approval authorizes model-generated reconciliation, not silent deletion. On
`ApprovalRequired`, ask through the interactive UI and retry the same proposal
with `approved: true` only after Save. If relationships or originals change,
obtain fresh approval.

After approval, the tool evaluates each body and the proposal for decomposition,
then generates standalone replacements. The proposal takes precedence in direct
conflicts; unrelated requirements, scopes, and exceptions should be preserved.
It validates replacement names against each other and unaffected traits before
writing. It updates selected names reused by replacements, adds new names, then
deletes only selected originals whose names were not reused. It returns
`Resolved` with the saved traits and their unique names.

When the config has no `layerLanguageModel`, you do the generation.
Reconciliation returns `GenerationRequired` with `requests`, each holding `id`,
`stage`, `instructions`, `input`, and `jsonSchema`. Follow each request's
instructions on its input and produce a JSON object that matches its schema.
Retry with the identical proposal and `generated` set to every output so far as
`{ id, output }`. More requests can follow. The approval then shows your
replacements; after Save on `ApprovalRequired`, retry with the same `generated`
and `approved: true`. Output that fails the schema returns
`GeneratedOutputError` and writes nothing.

Inspect those replacements. Do not call `derive_trait` again for the same
proposal: resolution has already saved its content. The initial comparison
covers all stored traits, but generated replacements are not automatically
revalidated against unaffected traits; review the replacements and check the
eligible project-owned files as required below.

Writes and removals are not transactional. If resolution fails, inspect the
store before retrying; some changes may already be present.

## Check the implementation

### Required post-save trait checks

After `Created`, `Updated`, or `Resolved`, this task is incomplete until you run
`check_traits` against all eligible project-owned files, using `traitNames` set
to the saved trait names. Checking only changed files or the file that prompted
the trait does not satisfy this requirement.

Enumerate project-owned source, authored configuration, and documentation.
Respect trait applicability and configured exclusions. Exclude dependencies,
reference repositories, generated output, lockfiles, Git metadata, secrets,
`.env` files, credentials, and binary assets.

Review findings against the trait and surrounding code. Fix confirmed applicable
violations with minimal behavior-preserving changes, recheck corrected files,
and run relevant verification. Ask before behavior-changing fixes or ambiguous
interpretations. Do not stop at a findings summary.

If blocked, explicitly report the blocker and state that the required post-save
trait checks remain incomplete. Saving a trait does not itself check or update
project files.

### Required review procedure

1. Before editing, read the stored trait bodies and identify which apply to the
   planned work. Do not rely on filenames, remembered summaries, or examples
   alone; preserve each rule's scope and exceptions.
2. Track every TypeScript file you generate or modify, including files changed
   while fixing findings. Review the final on-disk contents, not an earlier
   version or only the initial set of files.
3. Independently inspect each changed section against every applicable trait. An
   empty tool result does not replace direct inspection against the trait text.
   Formatting, lint, and type checks do not establish trait compliance.
4. For recognizable patterns, search explicitly and inspect matches. For the
   curried-call rule, look for nested calls such as `fn(args)(value)`, including
   multiline forms and `yield* S.decodeUnknownEffect(schema)(input)`. Check the
   actual signature before deciding whether a match is a violation. Also inspect
   parameter destructuring, manually constructed tagged-union members, wrapped
   schema modifiers, and misplaced imports when their traits apply. Searches
   support review; a lack of matches is not proof that every trait is satisfied.
5. Call `check_traits` on all changed TypeScript files after the latest edits.
   Before a commit or PR, omit `traitNames` so every stored trait is checked;
   focused checks supplement rather than replace that final review.
6. Inspect findings, fix confirmed violations, and repeat direct inspection,
   tool checks, and relevant project verification after fixes. If any reviewed
   file changes again, its earlier result is stale and it must be rechecked.
7. Keep automated results and manual triage distinct. Routine summaries should
   report confirmed issues, meaningful unresolved uncertainty, operational
   failures, and blockers requiring a user decision—not every raw finding.
   Preserve the reviewed scope and raw results for audit without repeating
   rejected false positives as caveats. Never claim an automated clean pass when
   raw findings remain, or turn an empty result into unconditional compliance.

### Targeted trait exceptions

For a justified file-scoped exception, add a line comment in the leading header,
before any code:

```ts
// traits-ignore-file <trait-name>: Explain why this trait cannot apply here.
```

Each directive requires a nonempty reason and exactly one unique trait name.
Names are case-sensitive; update directives after renaming a trait. Filenames
and partial names are not selectors. Repeat the comment for additional
exceptions. Only the referenced traits are skipped; other traits remain checked.
Exceptions apply to all file chunks and focused checks. Comments after code are
ignored.

Read the referenced trait and verify the reason before adding or retaining an
exception. Do not add directives merely to silence findings: fix applicable
violations, and ask the user before introducing an exception that overrides
their preference. Respect existing justified exceptions during manual review.

### Tool behavior and remediation

- After generating or editing TypeScript files, select those files and call
  `check_traits({ include: files })`.
- After creating, updating, or resolving traits, run the required post-save
  trait checks across all eligible project-owned files with the saved trait
  names.
- Omit `traitNames` for the full trait set. Supply names for focused follow-ups,
  especially the replacements returned by resolution. An empty array selects no
  traits; unknown names fail the call.
- `include` accepts file paths or glob patterns, absolute or relative to the MCP
  working directory. Overlapping matches are deduplicated; unmatched patterns
  select no files. Use `traits/**/*.ts` rather than a bare directory. Glob
  traversal always excludes dependencies, Git metadata, and nested worktrees.
  `TraitsConfig.excludes` adds filenames or native filesystem glob patterns,
  relative to the directory containing `traits.ts` or absolute. Use
  `directory/**` to exclude a subtree; bare directories are not expanded
  automatically. Escape glob characters in literal filenames using native glob
  syntax. This repository configures `repos/**` and `**/dist/**` in `traits.ts`.
  No custom path classification or glob expansion semantics are imposed.
- Assess only project-owned source and relevant authored configuration or
  documentation. For whole-project trait checks, prefer an explicit project-file
  manifest. Never submit third-party/reference code, generated output or
  lockfiles, secrets, `.env` files, credentials, or binary assets. Reading a
  dependency's source to verify an API does not make it part of the trait check
  scope.
- The tool checks current full files in 200-line chunks, including unstaged
  content. It does not inspect the Git index or compute a diff.
- Each expression finding contains the trait and source excerpt with a file path
  and 1-based chunk starting line. That line is not an exact violation location.
  Its `assessment` includes classification and probabilities. `inconclusive` is
  not a confirmed violation. Inspect the full distribution; probabilities are
  not calibrated guarantees.
- Inspect the code and trait before fixing a finding. Respect scope and
  exceptions; missing context is not proof of a violation.
- Own the remediation loop whenever you discover an applicable violation,
  whether from this tool or your own inspection. Automatically make minimal,
  behavior-preserving fixes without waiting for another user request; a findings
  summary alone is not completion. This tool diagnoses; the agent makes edits.
- Recheck every corrected file and run relevant formatting, type, and behavior
  checks. Repeat for remaining confirmed violations. Do not weaken or rewrite
  traits merely to silence findings, and do not change correct code for false
  positives or inapplicable rules.
- Do not repeat rejected, irrelevant false positives or already-justified
  exceptions in routine user summaries. Explain them when the user requests an
  audit, needs a decision, or a new material reliability problem is discovered.
  If a fix requires changed behavior, broader authorization, or resolving
  ambiguity, ask a focused question and report the blocker rather than silently
  expanding scope. Do not claim compliance while confirmed violations remain;
  model errors make the review incomplete, not passing.

### Reporting triage

Before presenting a finding, establish that the rule applies and identify the
actual offending code. A helper parameter is not a model-visible tool parameter;
local destructuring is not parameter destructuring. Check the exact scope and
exceptions rather than treating a matching topic as a violation.

Fix confirmed applicable violations within scope and verify the fix. Surface
remaining actionable issues, material uncertainty, failed/incomplete checks, and
decisions the user must make. Routine completion messages can state which build,
lint, and type checks passed without adding distracting checker false positives.
Do not imply that a rejected finding requires work or that the automated trait
review returned no findings when it did.

Keep unmodified raw assessments available in tool output or configured
telemetry; do not change tool filtering or introduce probability cutoffs to hide
inconvenient results. Low confidence alone is not grounds for dismissal, and
earlier false positives do not justify rejecting a new finding without
inspecting it. A newly discovered systemic reliability issue remains worth
reporting. When asked for audit details, distinguish confirmed, unresolved, and
rejected findings and give the rejection rationale. Quiet reporting is not
skipped remediation or lost signal.

- Before committing or opening a PR, review the changed TypeScript files against
  all traits. An empty result means no failures for the selection; empty
  selections, unmatched patterns, or an empty trait store perform no
  assessments.

## Operation

The CLI launcher installs project dependencies in its current directory before
importing the MCP server. Run it from the checkout/workspace root. It selects
the package manager from `package.json#packageManager` or an unambiguous
lockfile; the selected executable must be on PATH. Installation preserves
lockfiles but can execute lifecycle scripts, so only launch in trusted
checkouts. Allow enough MCP startup time for a cold install and avoid
simultaneous installations in the same worktree. During development, use
`node traits/bin.ts` with a Node version supporting native TypeScript execution;
pass server flags after the filename.

### CLI without MCP

`traits` with no subcommand, or `traits mcp`, runs the MCP server. Hooks, CI,
and shell scripts can call the same logic directly. The `check` and `derive`
subcommands skip the dependency install, so run them in an installed checkout.

- `traits check --include <path or glob> [--trait <name>] [--circumstances <text>] [--json]`
  runs `check_traits`. Repeat `--include` and `--trait` for more. Omitting
  `--trait` checks every stored trait. With `--json`, stdout is the
  `check_traits` result. The exit code is 0 for no findings, 1 for findings, 2
  for an operational failure (config, model, or I/O), and 3 when nothing was
  selected.
- `traits derive` reads one `derive_trait` input object as JSON on stdin and
  prints the tagged outcome as JSON, including `GenerationRequired` and
  `ApprovalRequired`. The CLI has no approval form: ask the user, then send
  `approved: true` only after Save. The exit code is 0 for any outcome and 2 for
  a failure.

Surface tool failures; never treat a failed operation as a successful save or
review. Error diagnostics may contain sensitive information. Never ask for
credentials in chat.

### Recover from stored-trait parse errors

`TraitParseError` includes the affected path, original diagnostic, and recovery
instructions. Ask the developer whether you should automatically resolve the
stored-trait parse errors and retry the blocked operation. Use the client's
interactive question UI when available. Do not silently edit files or merely
report the blocker without offering recovery. This is a repair-consent question,
not approval to derive a new trait; do not call `derive_trait` or persist this
recovery protocol as a trait.

If declined, leave files unchanged and report the operation as incomplete. After
approval:

1. Inspect the entire affected trait store, not just the first failing file.
   Distinguish schema mismatches (which may be legacy formats or invalid values)
   from malformed YAML and missing or unterminated frontmatter. Offer repair
   without assuming every parse error has the same cause.
2. Migrate repairable legacy formats to the installed package's `Trait` schema.
   Preserve names, authoritative requirements, applicability, exceptions,
   examples, and all supporting context. Move legacy requirements into
   `requirement`, scope and exceptions into applicability prose, and examples or
   additional information into Markdown context. Purpose explains existing
   intent, not new obligations. Leave already-valid traits unchanged.
3. For malformed documents, repair only where the intended content is clear. If
   any migration or repair is ambiguous or unsupported, ask a focused question
   before changing that content. Never guess intent or discard information.
4. Validate every file in the affected store with the installed `Trait` schema
   and `serialize` format. Then retry the originally blocked operation with its
   original arguments. The server reads repaired files on retry; no restart is
   necessary.

The original operation failed and must never be reported as a successful check.
Only a successful retry establishes completion. No automatic migration is
performed by the server.

Git-ignored files are excluded by default, with ignore rules refreshed on every
check. Untracked files do not need to be added to Git to be evaluated. Tracked
files stay eligible even if ignore rules match them. Set
`excludeGitignored: false` in `traits.ts` to disable this filter; explicit
excludes still apply. Git failures fail checks.

For setup, follow the canonical guide at
https://github.com/crosshatch/traits/blob/main/SETUP.md. Respect the consumer's
package manager and workspace dependency conventions, ask about providers and
models before writing configuration, and preserve existing settings. The guide
covers dependencies, credentials, skill installation, MCP connection, and
troubleshooting. The agent creates traits.ts using the selected providers; there
is no init command. Discover the connected server's `derive_trait` and
`check_traits` tools through the client's tool catalog.

The CLI's configuration layer loads and validates the default-exported object
from repository-root `traits.ts`. Import the `TraitsConfig` type from `traits`
and use `export default { ... } satisfies TraitsConfig`. Specify
`layerDecisionModel` and `layerLanguageModel`; `excludes` is optional. The CLI
supplies platform/HTTP services. Storage remains local and has no source
configuration. The recommended configuration uses OpenRouter for both decisions
and generation, requiring only `OPENROUTER_API_KEY`; separate TypeSafe and
OpenAI providers use `TYPESAFE_API_KEY` and `OPENAI_API_KEY`. Configuration
precedence is process environment, worktree-root `.env`, then main-checkout
`.env`. Reconnect the MCP server after changing credentials. A failed model
request is an incomplete review, not a pass.

The project MCP command leaves telemetry disabled. For optional OTLP telemetry,
launch with `npx traits --otlp-endpoint http://127.0.0.1:4318`. The flag is an
OTLP/HTTP collector base URL; traces and logs go to `/v1/traces` and `/v1/logs`
beneath it using JSON, with service name `traits` and the package version.
Metrics are not exported. Omit the flag to disable exports. URLs must use
HTTP(S). Base paths and query parameters are preserved; fragments are ignored.
Avoid credentials in command-line URLs. Stderr logging remains enabled; stdout
stays reserved for MCP.

The CLI does not start a collector or persist telemetry locally. Configure the
collector's storage, rotation, retention, and access controls separately. Use a
loopback collector for local debugging and read its configured output files; do
not assume an output directory exists. Treat telemetry as potentially sensitive:
spans and logs can include file paths and error text. No full trait bodies,
source bodies, or authorization headers are intentionally attached by this
integration, but that is not a blanket redaction guarantee. Do not publish
collector output without inspection and redaction.
