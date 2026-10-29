import type { ChangedFile, ChangesReport } from "@mendcode/protocol"
import { sgr } from "../../apps/cli/src/ui/theme"
import { changesPageKey, createChangesPageState, renderChangesPage } from "../../apps/cli/src/view/changes-page"

const modified = `@@ -12,9 +12,11 @@ export function render(input: RenderInput) {
   const { report, state, width } = input
-  const rows = height - 1
+  const rows = Math.max(0, height - 1)
+  const listWidth = Math.min(40, Math.floor(width * 0.35))
   for (const file of report.files) {
     lines.push(fileRow(file))
   }
+\tconst veryLongLine = "this line is intentionally long so that it wraps at narrow widths and shows the continuation marker in the sign column"
   return lines
 }
@@ -60,4 +62,5 @@ function clamp(value: number, length: number) {
   return Math.max(0, Math.min(value, length - 1))
+  // guard
 }`

const file = (input: Partial<ChangedFile> & { path: string }): ChangedFile => ({
  status: "modified",
  additions: 0,
  deletions: 0,
  binary: false,
  diff: "",
  truncated: false,
  ...input,
})

const report: ChangesReport = {
  root: "/Users/dev/Code/MendCodeV2",
  branch: "feat/changes-page",
  omittedFiles: 3,
  files: [
    file({ path: "apps/cli/src/view/changes-page.ts", status: "added", additions: 3, diff: "@@ -0,0 +1,3 @@\n+export const a = 1\n+export const b = 2\n+export const c = 3" }),
    file({ path: "apps/cli/src/view/transcript.ts", additions: 4, deletions: 1, diff: modified, truncated: true }),
    file({ path: "packages/protocol/src/queries.ts", additions: 1, deletions: 1, diff: "@@ -70,2 +70,2 @@\n-  files: z.array(ChangedFile),\n+  files: z.array(ChangedFile).max(200),\n   omittedFiles: z.number(),\n" }),
    file({ path: "docs/old-name.md", oldPath: "docs/previous-directory/older-name.md", status: "renamed" }),
    file({ path: "assets/logo.png", status: "modified", binary: true }),
    file({ path: "scratch/notes.txt", status: "untracked", additions: 1, diff: "@@ -0,0 +1 @@\n+todo" }),
    file({ path: "apps/cli/src/legacy/removed.ts", status: "deleted", deletions: 2, diff: "@@ -1,2 +0,0 @@\n-export const gone = true\n-export const alsoGone = true" }),
  ],
}

const width = Number(process.argv[2] ?? 160)
const height = Number(process.argv[3] ?? 40)
let state = { ...createChangesPageState(), selected: 1 }
if (process.argv[4] === "diff") state = changesPageKey(state, "\t", report).state

for (const line of renderChangesPage({ report, state, width, height })) {
  console.log(line.map((span) => `${sgr(span, "truecolor")}${span.text}\x1b[0m`).join(""))
}
