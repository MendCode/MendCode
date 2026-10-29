import type { StorageReport } from "@mendcode/protocol"
import { sgr } from "../../apps/cli/src/ui/theme"
import { createStoragePageState, renderStoragePage } from "../../apps/cli/src/view/storage-page"

const NOW = Date.UTC(2026, 8, 26, 14, 32)
const MB = 1024 * 1024
const GB = 1024 * MB

const report: StorageReport = {
  dbBytes: 1.2 * GB,
  walBytes: 12 * MB,
  blobBytes: 5.6 * GB,
  blobs: 312,
  orphanBlobs: 4,
  orphanBytes: 120 * MB,
  sessions: 87,
  events: 84_120,
  eventBytes: 0.9 * GB,
  engineBytes: 0.2 * GB,
  otherBytes: 0.1 * GB,
  freeBytes: 20 * MB,
  autoVacuum: "incremental",
  topSessions: Array.from({ length: 10 }, (_, i) => ({
    sessionId: `ses_${i}` as never,
    title: i === 3 ? "" : `session number ${i} with a fairly long descriptive title`,
    directory: `/Users/dev/Code/project-${i}/packages/app`,
    updatedAt: NOW - i * 86_400_000,
    bytes: (4.1 - i * 0.3) * GB,
  })),
}

const width = Number(process.argv[2] ?? 120)
const height = Number(process.argv[3] ?? 35)
const state = { ...createStoragePageState(), ...(process.argv[4] ? { tab: Number(process.argv[4]) - 1 } : {}) }

for (const line of renderStoragePage({ report, state, retentionDays: 90, width, height, now: NOW })) {
  console.log(line.map((span) => `${sgr(span, "truecolor")}${span.text}\x1b[0m`).join(""))
}
