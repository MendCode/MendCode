/** The file `/workflows new <name>` writes: a runnable, commented starting point for every part of the API. */
export function workflowStarter(name: string): string {
  return `// ${name}: a script workflow. Run it with:  /workflows run ${name} topic="what to look into"
//
// The first statement must be a pure literal (no calls, no template substitutions): MendCode reads it WITHOUT running
// anything, to show you the name, the phases and the caps before it asks to start.
export const meta = {
  name: ${JSON.stringify(name)},
  description: "What this workflow does, in one sentence",
  phases: [{ title: "Explore" }, { title: "Summarize" }],
  // Hard caps the engine enforces. A script that declares none may make 10 agent calls; above that it must declare agents.
  // Reaching a cap pauses the run so you can raise it (/workflows budget <id> agents=60) and resume.
  budget: { agents: 8, usd: 2, minutes: 30 },
}

// Everything below runs in an isolated process: no files, network, environment or imports. It can only call the functions
// below, which start agents (sub-sessions with the usual permissions), run checks and ask you questions.
// \`args\` holds what you passed to /workflows run. \`return\` the result of the run.
const topic = args.topic || "this project"

phase("Explore")
// agent(prompt, options) -> the agent's final text (or a validated object when you pass a JSON schema).
const angles = await agent("List three distinct angles to investigate about " + topic + ".", {
  label: "Plan angles",
  schema: { type: "object", required: ["angles"], properties: { angles: { type: "array", minItems: 1, maxItems: 5, items: { type: "string" } } } },
})

// parallel([thunks]) runs agents together. The number of agents depends on the result above: that is the point of a script.
const notes = await parallel(angles.angles.map((angle) => () => agent("Investigate " + topic + " from this angle, read-only: " + angle, { label: angle })))

phase("Summarize")
// mode: "work" lets an agent edit files (one at a time, or add worktree: true to isolate it). The default is read-only.
const summary = await agent("Combine these notes into one short summary:\\n\\n" + notes.join("\\n\\n"), { label: "Summarize" })

// check(command) runs a command on this machine and returns { ok, detail } without failing the run.
// ask(question, ["a", "b"]) waits for your answer. memo(key, fn) runs fn once per run. log(...) writes to the run's log.
log("angles", angles.angles.length)
return summary
`
}
