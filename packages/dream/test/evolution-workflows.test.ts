import { describe, expect, test } from "bun:test"
import { parseEvolutionWorkflow, type EvolutionSuggestion } from "@mendcode/protocol"
import { evolutionPrompt, parseCandidates, runEvolution, type EvolutionPort } from "../src/evolution"
import { createMeter } from "../src/meter"

const plan = {
  name: "Review checks", objective: "Report test gaps before changes",
  permission: "ask", tasks: [{ kind: "agent", id: "survey", title: "Survey", prompt: "Read the tests and report coverage gaps", mode: "read", needs: [] }],
  contract: { criteria: [{ id: "report", text: "Findings cite inspected files", owners: ["survey"] }], checks: [], audit: "independent" },
}
const candidate = { kind: "workflow", name: "review-checks", description: "Report coverage before editing", content: JSON.stringify(plan), evidence: ["e1"] }
const parse = (value: unknown, enabled = true) => parseCandidates(JSON.stringify({ candidates: [value] }), new Set(["e1"]), enabled)

describe("Evolution workflow candidates", () => {
  test("workflow output is opt-in, validated and backed only by shown evidence", () => {
    expect(parse(candidate)).toMatchObject({ candidates: [{ kind: "workflow" }], refused: [] })
    expect(parse(candidate, false)).toMatchObject({ candidates: [], refused: [{ reason: "workflow candidates are disabled" }] })
    expect(parse({ ...candidate, evidence: ["e1", "invented"] })).toMatchObject({ candidates: [], refused: [expect.anything()] })
    expect(parse({ ...candidate, content: "not JSON" })).toMatchObject({ candidates: [], refused: [expect.anything()] })
    expect(evolutionPrompt({ directory: "/project", evidence: [], memories: [] })).not.toContain("|workflow")
    expect(evolutionPrompt({ directory: "/project", evidence: [], memories: [], workflows: true })).toContain("mode: read")
  })

  test("rejects work tasks, commands, unsafe permissions, weak audits, cycles and bad owners", () => {
    for (const changed of [
      { ...plan, permission: "edits" },
      { ...plan, tasks: [{ ...plan.tasks[0], mode: "work" }] },
      { ...plan, tasks: [{ kind: "check", id: "survey", title: "Check", command: "git status" }] },
      { ...plan, contract: { ...plan.contract, checks: [{ id: "test", command: "bun test" }] } },
      { ...plan, contract: { ...plan.contract, audit: "none" } },
      { ...plan, contract: "trusted-contract" },
      { ...plan, tasks: [{ ...plan.tasks[0], needs: ["survey"] }] },
      { ...plan, tasks: [{ ...plan.tasks[0], needs: ["unknown"] }] },
      { ...plan, tasks: [plan.tasks[0], plan.tasks[0]] },
      { ...plan, contract: { ...plan.contract, criteria: [{ id: "result", text: "Read evidence", owners: ["unknown"] }] } },
    ]) expect(() => parseEvolutionWorkflow(JSON.stringify(changed))).toThrow()
    expect(parse({ ...candidate, content: JSON.stringify({ ...plan, objective: "Read the api_key from settings" }) })).toMatchObject({ candidates: [], refused: [{ reason: "may contain a secret or credential" }] })
  })

  test("auto-safe queues workflows for approval and counts them; observe never calls the fake model", async () => {
    let calls = 0
    const suggestions: EvolutionSuggestion[] = []
    const port: EvolutionPort = {
      record() {}, recurring: () => [{ fingerprint: "repeat", source: "correction", sessions: 2, text: "Read tests before editing", evidenceId: "evidence" }],
      suggest: (input) => { const suggestion: EvolutionSuggestion = { ...input, suggestionId: 1, status: "pending", createdAt: 0 }; suggestions.push(suggestion); return suggestion },
    }
    const run = (mode: "auto-safe" | "observe", workflows: boolean) => runEvolution({ mode, workflows, directory: "/project", evidence: [], memories: [], port, meter: createMeter({ limit: 60_000, signal: new AbortController().signal, complete: async () => { calls++; return JSON.stringify({ candidates: [candidate] }) } }), propose: () => { throw new Error("No automatic memory or file write") } })
    const result = await run("auto-safe", true)
    expect(result.report).toMatchObject({ suggested: { workflows: 1 }, applied: 0 })
    expect(suggestions).toHaveLength(1)
    expect(suggestions[0]?.status).toBe("pending")
    await run("observe", true)
    expect(calls).toBe(1)
    const disabled = await run("auto-safe", false)
    expect(disabled.report.suggested.workflows).toBeUndefined()
    expect(suggestions).toHaveLength(1)
  })
})
