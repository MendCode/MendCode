// Review a change from several angles, then try to disprove every finding before it is reported.
//
//   /workflows run examples/workflows/review-and-verify.js {"target": "the current diff"}
//
// A pipeline: dimensions -> findings per dimension -> an adversarial verifier per finding.
// Only findings that survive verification are returned, so the report is short and trustworthy.
export const meta = {
  name: "review-and-verify",
  description: "Review a change on several dimensions, then adversarially verify each finding",
  phases: [
    { title: "Plan", detail: "pick the review dimensions that matter for this change" },
    { title: "Find", detail: "one reviewer per dimension" },
    { title: "Verify", detail: "one skeptic per finding tries to prove it wrong" },
  ],
  budget: { agents: 60, tokens: 3000000, usd: 10, minutes: 45 },
  maxConcurrent: 8,
}

const target = args.target || "the uncommitted changes in this project"

phase("Plan")
const plan = await agent(
  "List up to 5 review dimensions (for example correctness, security, concurrency, performance, API compatibility) that matter most for " + target + ". Read the change first; return only dimensions that apply.",
  {
    label: "Pick dimensions",
    schema: { type: "object", required: ["dimensions"], properties: { dimensions: { type: "array", minItems: 1, maxItems: 5, items: { type: "string" } } } },
  },
)

phase("Find")
const FINDINGS = {
  type: "object",
  required: ["findings"],
  properties: {
    findings: {
      type: "array",
      maxItems: 8,
      items: {
        type: "object",
        required: ["title", "where", "claim", "severity"],
        properties: {
          title: { type: "string" },
          where: { type: "string" },
          claim: { type: "string" },
          severity: { type: "string", enum: ["low", "medium", "high"] },
        },
      },
    },
  },
}

const verified = await pipeline(
  plan.dimensions,
  // stage 1: a reviewer per dimension returns its findings (read-only)
  (dimension) => agent("Review " + target + " strictly for " + dimension + ". Report concrete defects with a file and line, not style opinions. If there are none, return an empty list.", { label: "Review: " + dimension, schema: FINDINGS }),
  // stage 2: a skeptic per finding; the pipeline lets each dimension move on as soon as its own reviewer is done
  async (result) => {
    const checks = await parallel(
      result.findings.map((finding) => () =>
        agent(
          "Try to PROVE THIS FINDING WRONG. Read the code at " + finding.where + " and the code around it. Claim: " + finding.claim + "\nIf the claim holds, say so and give the evidence; if you can refute it, say why.",
          {
            label: "Verify: " + finding.title,
            phase: "Verify",
            schema: { type: "object", required: ["holds", "evidence"], properties: { holds: { type: "boolean" }, evidence: { type: "string" } } },
          },
        ).then((verdict) => ({ ...finding, holds: verdict.holds, evidence: verdict.evidence })),
      ),
    )
    return checks.filter((finding) => finding.holds)
  },
)

const confirmed = verified.flat()
log("confirmed findings", confirmed.length)
return { target, dimensions: plan.dimensions, confirmed }
