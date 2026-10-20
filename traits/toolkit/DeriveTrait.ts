import { Schema as S, String } from "effect"
import { DecisionModel, McpSchema, Tool, Toolkit } from "effect/ai"

import * as Generation from "../Generation.ts"
import * as Trait from "../Trait.ts"
import * as Derivation from "../TraitDerivation.ts"
import { TraitsContext } from "../TraitsContext.ts"
import { TraitStore, TraitStoreError } from "../TraitStore.ts"

export const DeriveTrait = Tool.make("derive_trait", {
  description: String.stripMargin(`
  | Use after a user correction, reusable coding preference, or explicit request to remember a convention.
  | Recognize preferences across turns, including approval of a suggested alternative idiom; do not require the words "always" or "trait".
  | Err on the side of proposing a rule unless an existing trait clearly covers its exact scope. Call this tool with the draft first; do not ask separately beforehand.
  | An explicit request to save the rule counts as approval; approval to change code alone does not.
  | Native clients receive an approval form. ApprovalRequired means use the interactive question tool with Save, Revise, and Skip choices and its free-text option.
  | Include the full returned message. Retry with the exact same body and target and approved: true only after Save; revise and request approval again for changed text.
  | RevisionRequired contains feedback; revise and resubmit. Declined means stop without writing. Never retry automatically after a decline.
  | If Revise supplies no concrete feedback, ask for revision details with the interactive question UI and free text. Do not guess or set approved: true.
  | Keep the proposal pending through related work and return to it afterward unless cancelled; obtain fresh approval of the complete revised body.
  | First decide whether the feedback generalizes beyond the current task and inspect existing trait files for coverage.
  | Supply proposedTrait as a complete structured trait: name, subject, requirement, purpose, and optional applicability, guidance, and Markdown context.
  | Subject identifies what to assess; requirement is authoritative. Applicability is natural-language scope and exceptions. Purpose explains intent; guidance advises without granting authority.
  | Put examples, code diffs, references, and domain details in context. Context is available during assessment, but must not hide essential obligations.
  | Supply a unique descriptive kebab-case name without a redundant trait- prefix for a newly created trait; it is the canonical identity, frontmatter name, and Markdown filename stem. Duplicate names are rejected.
  | Avoid repeated requirements and duplicate traits. Keep bodies standalone; do not strip essential scope or exceptions just to shorten them.
  | Omit applicability when the subject needs no further restriction. Do not add arbitrary metadata or domain-specific frontmatter fields.
  | On clarification, supply a complete replacement trait; omitted optional fields are removed. Approval and retries cover every field and the complete context.
  | Compare against all stored traits. Only a distinct proposal is saved as a new trait.
  | Inconclusive returns relationship findings and blocks all writes; clarify ambiguity or revise the proposal before retrying.
  | Confirmed conflicts and independently verified coverage gaps enter reconciliation within this tool. Approval shows affected trait names, bodies, applicability metadata, removals, the proposal, and replacement policy.
  | Nothing is replaced before approval. After approval, validate unique replacement names against unaffected traits, update reused selected names, save new names, then delete only selected originals whose names were not reused.
  | The proposal takes precedence only in direct conflicts; preserve unrelated requirements, scopes, and exceptions. Resolved returns saved replacements.
  | Do not submit the same proposal again after Resolved: it is already incorporated. Inspect replacements and complete the required post-save trait checks.
  | GenerationRequired means no language model is configured: produce each request's JSON yourself from its instructions, input, and jsonSchema, then retry the identical proposal with generated holding every output so far as {id, output}. Keep the same generated when retrying after approval.
  | GroupedTraitReadOnly means the proposal conflicts with or clarifies a grouped group/name trait, which is read-only here; nothing was written. Revise the proposal into a flat trait that does not overlap it, or change the grouped trait in its own repository.
  | Reconciliation is not transactional; on an error, inspect the store before retrying because some writes or removals may have completed.
  | Covered requires a second independent decision-model assessment of the complete saved trait against every proposed requirement. Similar intent or partial overlap is insufficient. Coverage gaps require approval-gated revision; inconclusive verification blocks writes.
  | Covered returns only independently verified existing traits; reuse them without writing a duplicate.
  | A single clarification candidate is selected automatically for approval; provide a complete replacement body preserving existing requirements and exceptions.
  | Multiple clarification candidates return Clarification with those traits and the proposal without writing. Refine the proposal or clarify intent.
  | The shared approval flow shows the existing and proposed bodies; ask in the client UI only if ApprovalRequired is returned.
  | The tool rechecks all traits before updating, preserving the selected name on clarification. Updated returns the saved trait.
  | Never use approved: true for an unapproved replacement, and never resolve a mere clarification by deleting traits.
  | Created returns the saved trait including its unique name. Every response is one tagged TraitDerivation outcome, never a bare array or void.
  | Required post-save trait checks after Created, Updated, or Resolved: This task is incomplete until you run check_traits against all eligible project-owned files, using traitNames set to the saved trait names. Checking only changed files or the file that prompted the trait does not satisfy this requirement.
  | Enumerate project-owned source, authored configuration, and documentation. Respect trait applicability and configured exclusions. Exclude dependencies, reference repositories, generated output, lockfiles, Git metadata, secrets, .env files, credentials, and binary assets.
  | Review findings against the trait and surrounding code. Fix confirmed applicable violations with minimal behavior-preserving changes, recheck corrected files, and run relevant verification. Ask before behavior-changing fixes or ambiguous interpretations.
  | If blocked, explicitly report the blocker and state that the required post-save trait checks remain incomplete. Saving a trait does not itself check or update project files.
  `),
  parameters: S.Struct({
    proposedTrait: Trait.FlatTrait.annotate({
      description:
        "The complete proposed trait, including required name, subject, authoritative requirement, and purpose; optional applicability, guidance, and Markdown context. Replaces all content on clarification while preserving the existing name."
    }),
    approved: S.Boolean.pipe(S.optional).annotate({
      description:
        "Fallback approval for the exact proposal and automatically selected action shown to the user, including any existing trait being updated. Set true only after approval; native clients still receive a form. Does not bypass relationship checks."
    }),
    generated: S.Array(Generation.GeneratedOutput).pipe(S.optional).annotate({
      description:
        "Your outputs for GenerationRequired requests, each as {id, output}. Include every output from earlier GenerationRequired responses for this proposal."
    })
  }),
  success: Derivation.TraitDerivation,
  failure: S.Union([
    S.TaggedStruct("AiError", { message: S.String }),
    TraitStoreError,
    Generation.GeneratedOutputError,
    McpSchema.ElicitationDeclined
  ]),
  failureMode: "return",
  dependencies: [DecisionModel.DecisionModel, TraitsContext, TraitStore]
})
  .annotate(Tool.Title, "Derive Trait")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)

export const toolkit = Toolkit.make(DeriveTrait)

export const layer = toolkit.toLayer({
  derive_trait: Derivation.derive
})
