// retro-review: review the working tree in the Retro register. Run it with:  /workflows run retro-review
//
// The first statement is a pure literal: MendCode reads it without running anything, to show the caps before it asks to start.
export const meta = {
  name: "retro-review",
  description: "Read the working tree changes and report them as short log lines",
  phases: [{ title: "Review" }],
  budget: { agents: 2, usd: 1, minutes: 10 },
}

const scope = args.scope || "the uncommitted changes"

phase("Review")
// One read-only agent. Its answer is the result of the run.
return await agent("Review " + scope + ". Report each finding as one line: file, then what is wrong. Say 'clean' if there is nothing.", { label: "Review" })
