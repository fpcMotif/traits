import { expect, it } from "@effect/vitest"

import * as Verdict from "../Verdict.ts"

const probabilities = (violation: number, compliant: number, notApplicable = 0) => ({
  violation,
  compliant,
  "not-applicable": notApplicable,
  inconclusive: Math.max(0, 1 - violation - compliant - notApplicable)
})

it("maps probabilities to verdicts with the default thresholds", () => {
  const thresholds = Verdict.defaultThresholds
  expect(Verdict.verdictFor(probabilities(0.8, 0.2), thresholds)).toBe("fix")
  expect(Verdict.verdictFor(probabilities(0.79, 0.21), thresholds)).toBe("check")
  expect(Verdict.verdictFor(probabilities(0.5, 0.5), thresholds)).toBe("check")
  expect(Verdict.verdictFor(probabilities(0.49, 0.4), thresholds)).toBe("unsure")
  expect(Verdict.verdictFor(probabilities(0.05, 0.5, 0.39), thresholds)).toBe("unsure")
  expect(Verdict.verdictFor(probabilities(0.05, 0.5, 0.4), thresholds)).toBe("pass")
  expect(Verdict.verdictFor(probabilities(0, 0, 1), thresholds)).toBe("pass")
})

it("honors custom thresholds", () => {
  const thresholds = { fix: 0.95, check: 0.3, pass: 0.5 }
  expect(Verdict.verdictFor(probabilities(0.9, 0.1), thresholds)).toBe("check")
  expect(Verdict.verdictFor(probabilities(0.2, 0.5), thresholds)).toBe("pass")
  expect(Verdict.verdictFor(probabilities(0.2, 0.4), thresholds)).toBe("unsure")
})

it("fails at or above the --fail-on verdict", () => {
  const table = {
    fix: ["fix"],
    check: ["fix", "check"],
    unsure: ["fix", "check", "unsure"],
    never: []
  } as const
  for (const failOn of Verdict.FailOn.literals) {
    for (const verdict of Verdict.Verdict.literals) {
      expect(Verdict.fails(verdict, failOn)).toBe((table[failOn] as ReadonlyArray<string>).includes(verdict))
    }
  }
})
