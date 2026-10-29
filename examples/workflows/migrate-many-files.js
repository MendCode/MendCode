// Apply one mechanical migration across a project, a directory at a time, in isolated worktrees.
//
//   /workflows run examples/workflows/migrate-many-files.js {"change": "replace moment with date-fns", "check": "bun test"}
//
// Fan out per directory (each agent edits its own worktree, so they run in parallel), run the check inside every worktree,
// then merge(): the passing worktrees are combined on a reviewed integration branch (your checkout is untouched), you are
// asked, and only on your approval is that branch merged into your checkout. A conflict pauses the run with the files
// listed; resolve them in the integration worktree and resume.
export const meta = {
  name: "migrate-many-files",
  description: "Fan out a migration per directory in worktrees, check each, then merge on a reviewed branch",
  phases: [
    { title: "Survey", detail: "find the directories that need the change" },
    { title: "Migrate", detail: "one worktree agent per directory" },
    { title: "Check", detail: "run the check in each worktree" },
    { title: "Merge", detail: "integration branch, your approval, then the merge" },
  ],
  budget: { agents: 40, tokens: 4000000, usd: 12, minutes: 90 },
  maxConcurrent: 6,
  permission: "edits",
}

const change = args.change || "apply the migration the user described"
const command = args.check || "bun test"

phase("Survey")
const survey = await agent(
  "Find the top-level directories (at most 12) that contain code needing this change: " + change + ". Return directories only, relative to the project root.",
  {
    label: "Survey",
    schema: { type: "object", required: ["directories"], properties: { directories: { type: "array", maxItems: 12, items: { type: "string" } } } },
  },
)
if (survey.directories.length === 0) return { migrated: [], note: "nothing to migrate" }

phase("Migrate")
const migrated = await parallel(
  survey.directories.map((directory) => () =>
    agent(
      "Work only inside " + directory + ". Apply this change to every file there: " + change + ". Keep behavior identical. Finish with one line saying what you changed.",
      { label: "Migrate " + directory, mode: "work", worktree: true, detail: true },
    ).then((result) => ({ directory, result })),
  ),
)

phase("Check")
const checked = await parallel(
  migrated.map(({ directory, result }) => async () => {
    const outcome = await check(command, { label: "Check " + directory, in: result })
    return { directory, ok: outcome.ok, detail: outcome.detail, result }
  }),
)
const passing = checked.filter((entry) => entry.ok)
const failing = checked.filter((entry) => !entry.ok)
log("passing", passing.length, "failing", failing.length)
if (passing.length === 0) return { merged: [], failing: failing.map((entry) => ({ directory: entry.directory, detail: entry.detail })) }

phase("Merge")
// Each passing result carries its branch and diff summary (result.branch, result.diff). merge() combines them on one branch;
// with strategy "apply" it then asks you (files, insertions, deletions) before merging that branch into your checkout.
const merged = await merge(passing.map((entry) => entry.result), { strategy: "apply", message: "migrate: " + change })
return {
  merged: merged.applied ? passing.map((entry) => entry.directory) : [],
  branch: merged.branch,
  files: merged.files,
  applied: merged.applied,
  failing: failing.map((entry) => entry.directory),
}
