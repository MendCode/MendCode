import type { DreamReport, DreamRun } from "@mendcode/protocol"

export const NOW = 1_800_000_000_000

/** A run's safety report with something in every part, shared by the Dream tab tests. */
export const REPORT: DreamReport = {
  read: {
    sessions: [
      { sessionId: "ses_1", title: "Fix the login redirect", digest: "built", messages: 12, redactions: 0 },
      { sessionId: "ses_2", title: "Move the store to sqlite", digest: "reused", messages: 40, redactions: 2 },
    ],
    memories: 14,
    promptChars: 18_240,
  },
  proposed: [
    { kind: "new", category: "preferences", scope: "user", text: "Answers are terse, in Spanish when I write Spanish", outcome: "pending" },
    { kind: "update", category: "stack", text: "Package manager is pnpm, never npm", outcome: "saved" },
    { kind: "archive", category: "volatile", text: "Temporary staging URL", outcome: "dropped" },
    { kind: "new", category: "commands", text: "Run bun test apps/cli before a commit", outcome: "pending" },
  ],
  refused: [
    { item: "Use tabs", reason: "duplicate of a saved memory" },
    { item: "token sk-…", reason: "unsafe text" },
    { item: "Always deploy on Friday", reason: "unknown memory id" },
  ],
  redactions: { evidence: 2, proposals: 1 },
  model: { calls: 2, inputTokens: 4_120, outputTokens: 830, estimated: true },
  budget: { limit: 60_000, used: 4_950, stopped: false },
  evolution: { mode: "suggest", observed: { corrections: 3, preferences: 1, recurring: 2 }, suggested: { memories: 1, skills: 1, instructions: 0 }, applied: 0, note: "nothing recurred in 2 sessions yet" },
  failures: [],
}

export function run(patch: Partial<DreamRun> = {}): DreamRun {
  return { runId: 7, directory: "/work/app", status: "done", trigger: "manual", startedAt: NOW - 3_600_000, endedAt: NOW - 3_600_000 + 12_000, proposed: 2, report: REPORT, ...patch }
}
