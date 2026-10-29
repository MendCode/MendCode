import { describe, expect, test } from "bun:test"
import { createIdFactory } from "@mendcode/protocol"
import { createApp } from "../src/ui/app"
import { parseSlash } from "../src/view/commands"
import { glyphs, type Line } from "../src/ui/theme"

const ids = createIdFactory()
const NOW = 1_800_000_000_000
const report = {
  dbBytes: 1024 ** 3, walBytes: 0, blobBytes: 2 * 1024 ** 3, blobs: 10, orphanBlobs: 0, orphanBytes: 0, sessions: 5, events: 500, eventBytes: 500 * 1024 ** 2, engineBytes: 0, otherBytes: 0, freeBytes: 0, autoVacuum: "incremental", topSessions: [],
}

async function harness(dry = { dryRun: true, olderThanDays: 60, sessionsRemoved: 3, eventsRemoved: 90, blobsRemoved: 1, bytesReclaimed: 1024 ** 3, protectedSessions: 0, vacuumed: false }) {
  const sent: Array<Record<string, unknown>> = []
  const frames: Line[][] = []
  const screen = { size: { width: 100, height: 30 }, draw: (rows: Line[]) => void frames.push(rows) } as unknown as Parameters<typeof createApp>[0]["screen"]
  const app = createApp({
    sessionId: ids("session"),
    screen,
    send: async (command: Record<string, unknown>) => {
      // The history bookkeeping of the typed command is not part of what the page asks for.
      if (command.type !== "prompt.record") sent.push(command)
      if (command.type === "storage.report") return { ok: true, result: report }
      if (command.type === "settings.get") return { ok: true, result: { settings: { retentionDays: 60 } } }
      if (command.type === "storage.clean") return { ok: true, result: command.dryRun ? dry : { ...dry, dryRun: false, bytesReclaimed: 900 * 1024 ** 2 } }
      return { ok: true }
    },
    exit() {},
    schedule: (fn: () => void) => fn(),
    glyphs: glyphs({}),
    now: () => NOW,
  } as never)
  for (const key of "/storage") await app.onKey(key)
  await app.onKey("\r")
  const text = () => frames.at(-1)!.map((row) => row.map((s) => s.text).join(""))
  const tick = () => Bun.sleep(5)
  return { app, sent, text, tick }
}

describe("storage page in the app", () => {
  test("/storage is a command and /disk is not", () => {
    expect(parseSlash("/storage")?.command.name).toBe("storage")
    expect(parseSlash("/disk")).toBeUndefined()
  })

  test("opening shows the report and the retention setting", async () => {
    const { text, sent } = await harness()
    expect(sent.map((c) => c.type).sort()).toEqual(["settings.get", "storage.report"])
    expect(text().some((line) => line.includes("3.0 GB on disk"))).toBe(true)
    expect(text().some((line) => line.includes("auto-clean") && line.includes("sessions idle > 60 days"))).toBe(true)
  })

  test("c previews with a dry run, asks, and y runs the real clean then reloads", async () => {
    const { app, sent, text, tick } = await harness()
    await app.onKey("c")
    await tick()
    expect(sent.find((c) => c.type === "storage.clean")).toEqual({ type: "storage.clean", olderThanDays: 60, dryRun: true })
    expect(text().some((line) => line.includes("remove 3 sessions older than 60 days (≈1.0 GB)? y/n"))).toBe(true)
    await app.onKey("y")
    await tick()
    const clean = sent.filter((c) => c.type === "storage.clean")
    expect(clean[1]).toEqual({ type: "storage.clean", olderThanDays: 60 })
    expect(sent.filter((c) => c.type === "storage.report").length).toBe(2)
    expect(text().some((line) => line.includes("removed 3 sessions · freed 900.0 MB"))).toBe(true)
  })

  test("any other key at the prompt cancels without cleaning", async () => {
    const { app, sent, text, tick } = await harness()
    await app.onKey("c")
    await tick()
    await app.onKey("n")
    await tick()
    expect(sent.filter((c) => c.type === "storage.clean").length).toBe(1)
    expect(text().some((line) => line.startsWith("remove "))).toBe(false)
  })

  test("nothing to remove shows a note instead of a prompt", async () => {
    const { app, text, tick } = await harness({ dryRun: true, olderThanDays: 60, sessionsRemoved: 0, eventsRemoved: 0, blobsRemoved: 0, bytesReclaimed: 0, protectedSessions: 0, vacuumed: false })
    await app.onKey("c")
    await tick()
    expect(text().some((line) => line.includes("nothing older than 60 days to remove"))).toBe(true)
  })

  test("v asks before vacuuming and y sends a vacuum-only clean", async () => {
    const { app, sent, text, tick } = await harness()
    await app.onKey("v")
    expect(text().some((line) => line.includes("full vacuum rewrites the 1.0 GB database"))).toBe(true)
    await app.onKey("y")
    await tick()
    expect(sent.filter((c) => c.type === "storage.clean").at(-1)).toEqual({ type: "storage.clean", olderThanDays: 0, vacuum: true })
  })

  test("z previews the compaction, asks, and y runs it; nothing to pack shows a note", async () => {
    const compact = { dryRun: true, olderThanDays: 0, sessionsRemoved: 0, eventsRemoved: 0, blobsRemoved: 0, bytesReclaimed: 0, protectedSessions: 0, vacuumed: false, compactedRows: 800, deltaEventsRemoved: 5000, compactComplete: true }
    const { app, sent, text, tick } = await harness(compact)
    await app.onKey("z")
    await tick()
    expect(sent.find((c) => c.type === "storage.clean")).toEqual({ type: "storage.clean", olderThanDays: 0, dryRun: true, compact: true })
    expect(text().some((line) => line.includes("pack old data and drop 5,000 finished streaming deltas (800 rows)? nothing is lost. y/n"))).toBe(true)
    await app.onKey("y")
    await tick()
    expect(sent.filter((c) => c.type === "storage.clean").at(-1)).toEqual({ type: "storage.clean", olderThanDays: 0, compact: true })
    expect(text().some((line) => line.includes("packed 900.0 MB freed"))).toBe(true)
    const none = await harness({ ...compact, compactedRows: 0, deltaEventsRemoved: 0 })
    await none.app.onKey("z")
    await none.tick()
    expect(none.text().some((line) => line.includes("nothing to pack"))).toBe(true)
  })

  test("w previews the worktree cleanup with the idle days of the setting, and y removes", async () => {
    const trees = { dryRun: true, olderThanDays: 0, sessionsRemoved: 0, eventsRemoved: 0, blobsRemoved: 0, bytesReclaimed: 0, protectedSessions: 0, vacuumed: false, worktreesRemoved: 2, worktreeBytes: 3 * 1024 ** 3 }
    const { app, sent, text, tick } = await harness(trees)
    await app.onKey("w")
    await tick()
    expect(sent.find((c) => c.type === "storage.clean")).toEqual({ type: "storage.clean", olderThanDays: 0, dryRun: true, worktrees: true })
    expect(text().some((line) => line.includes("remove 2 merged, clean, unused worktrees or trash entries (≈3.0 GB)? y/n"))).toBe(true)
    await app.onKey("y")
    await tick()
    expect(sent.filter((c) => c.type === "storage.clean").at(-1)).toEqual({ type: "storage.clean", olderThanDays: 0, worktrees: true })
  })

  test("esc leaves the page", async () => {
    const { app, text } = await harness()
    await app.onKey("\x1b")
    expect(text().some((line) => line.includes("on disk"))).toBe(false)
  })
})

test("orphan-only goal cleanup asks for confirmation instead of claiming there is nothing to remove", async () => {
  const { app, text, tick } = await harness({ dryRun: true, olderThanDays: 60, sessionsRemoved: 0, eventsRemoved: 0, blobsRemoved: 0, goalFilesRemoved: 2, bytesReclaimed: 4000, protectedSessions: 0, vacuumed: false })
  await app.onKey("c")
  await tick()
  expect(text().some((line) => line.includes("+ 2 goal files"))).toBe(true)
  expect(text().some((line) => line.includes("nothing older"))).toBe(false)
})
