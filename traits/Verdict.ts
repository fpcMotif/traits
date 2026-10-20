import { Schema as S } from "effect"
import { dual } from "effect/Function"

import type { Assessment } from "./Assessment.ts"

export type Verdict = typeof Verdict.Type
export const Verdict = S.Literals(["fix", "check", "unsure", "pass"])

export type FailOn = typeof FailOn.Type
export const FailOn = S.Literals(["fix", "check", "unsure", "never"])

export interface Thresholds {
  readonly fix: number
  readonly check: number
  readonly pass: number
}

export const defaultThresholds: Thresholds = { fix: 0.8, check: 0.5, pass: 0.9 }

export const verdictFor: {
  (thresholds: Thresholds): (probabilities: Assessment["probabilities"]) => Verdict
  (probabilities: Assessment["probabilities"], thresholds: Thresholds): Verdict
} = dual(2, (probabilities: Assessment["probabilities"], thresholds: Thresholds): Verdict => {
  if (probabilities.violation >= thresholds.fix) return "fix"
  if (probabilities.violation >= thresholds.check) return "check"
  if (probabilities.compliant + probabilities["not-applicable"] < thresholds.pass) return "unsure"
  return "pass"
})

const severity: Record<Verdict, number> = { fix: 3, check: 2, unsure: 1, pass: 0 }
const minimum: Record<FailOn, number> = { fix: 3, check: 2, unsure: 1, never: Number.POSITIVE_INFINITY }

export const fails: {
  (failOn: FailOn): (verdict: Verdict) => boolean
  (verdict: Verdict, failOn: FailOn): boolean
} = dual(2, (verdict: Verdict, failOn: FailOn): boolean => severity[verdict] >= minimum[failOn])
