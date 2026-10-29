// Research a question from several sources in parallel, then synthesize one structured answer.
//
//   /workflows run examples/workflows/research.js {"question": "How does this project handle retries?"}
//
// Parallel read-only agents (one per angle) feed a synthesizer whose answer must match a schema.
// The synthesizer is the only agent that sees everything, so its schema is the contract of the whole run.
export const meta = {
  name: "research",
  description: "Parallel read-only research agents, then a synthesizer with a typed answer",
  phases: [
    { title: "Research", detail: "one reader per angle" },
    { title: "Synthesize", detail: "merge the notes into a typed answer" },
  ],
  budget: { agents: 12, tokens: 1500000, usd: 4, minutes: 30 },
  maxConcurrent: 6,
}

const question = args.question || "Summarize how this project is organized."
const angles = args.angles || ["code and tests", "documentation and configuration", "history (git log) and open work (TODO, FIXME)"]

phase("Research")
const notes = await parallel(
  angles.map((angle) => () =>
    agent("Research this question looking only at " + angle + ". Question: " + question + "\nQuote file paths for every claim. Say plainly what you could not find.", { label: "Read: " + angle }).then((text) => ({ angle, text })),
  ),
  { settled: true },
)
const usable = notes.filter((entry) => entry.ok).map((entry) => entry.value)
log("angles answered", usable.length, "of", angles.length)
if (usable.length === 0) throw new Error("no research angle produced notes")

phase("Synthesize")
return await agent(
  "Answer the question from these notes, resolving contradictions by preferring claims with file paths.\nQuestion: " + question + "\n\n" + usable.map((entry) => "## " + entry.angle + "\n" + entry.text).join("\n\n"),
  {
    label: "Synthesize",
    schema: {
      type: "object",
      required: ["answer", "confidence", "evidence", "gaps"],
      properties: {
        answer: { type: "string" },
        confidence: { type: "string", enum: ["low", "medium", "high"] },
        evidence: { type: "array", items: { type: "object", required: ["claim", "source"], properties: { claim: { type: "string" }, source: { type: "string" } } } },
        gaps: { type: "array", items: { type: "string" } },
      },
    },
  },
)
