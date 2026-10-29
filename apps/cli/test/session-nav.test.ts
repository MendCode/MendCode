import { afterEach, expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import path from "node:path"
import type { CommandInput, CommandReply } from "@mendcode/client"
import type { SessionTreeNode, TimelineEntry } from "@mendcode/protocol"
import { entriesSince, CHANGELOG } from "../src/changelog"
import { appHarness, cleanTemps, conversation, ids, NOW, tempDir } from "./session-ui-harness"

afterEach(cleanTemps)

const node = (input: Partial<SessionTreeNode> & { sessionId: SessionTreeNode["sessionId"] }): SessionTreeNode => ({ title: "untitled", directory: "/project", createdAt: NOW - 60_000, updatedAt: NOW - 30_000, archived: false, current: false, labels: [], ...input })

test("/fork merge merges the open fork into its parent, or a fork of the tree named by the end of its id", async () => {
  const root = ids("session"), fork = ids("session")
  const h = appHarness({ sessionId: fork, dataDir: tempDir(), directory: "/project", reply: (command): CommandReply | undefined => {
    if (command.type === "session.tree") return { ok: true, result: { current: fork, nodes: [node({ sessionId: root, title: "root" }), node({ sessionId: fork, parentId: root, title: "fork", current: true, kind: "fork" })] } }
    if (command.type === "session.merge") return command.sessionId === fork ? { ok: true, result: { fromSessionId: fork, intoSessionId: root, turns: 1, omitted: 3, tokens: 900, pending: 1 } } : { ok: false, error: { code: "target_mismatch", message: "[DAEMON]: that session is not a fork of another one" } }
  } })
  h.app.applySettings({ onboarded: true })
  await h.type("/fork merge\r")
  expect(h.sentOf("session.merge").at(-1)).toEqual({ type: "session.merge", sessionId: fork })
  expect(h.text().join("\n")).toContain("merged 1 turn (~900 tokens, 3 older left out)")
  await h.type(`/fork merge ${fork.slice(-8)}\r`)
  expect(h.sentOf("session.merge")).toHaveLength(2)
  await h.type("/fork merge nosuchid\r")
  expect(h.sentOf("session.merge")).toHaveLength(2)
  expect(h.text().join("\n")).toContain("no fork nosuchid in this tree")
})

test("/label bookmarks the latest message and clears with no text; /timeline ^L bookmarks any message", async () => {
  const sessionId = ids("session")
  const one = { turnId: ids("turn"), itemId: ids("item"), at: NOW, preview: "first", reverted: false }
  const two = { turnId: ids("turn"), itemId: ids("item"), at: NOW, preview: "second", reverted: false }
  const gone = { turnId: ids("turn"), itemId: ids("item"), at: NOW, preview: "undone", reverted: true }
  const h = appHarness({ sessionId, dataDir: tempDir(), reply: (command) => {
    if (command.type === "session.timeline") return { ok: true, result: { entries: [one, two, gone] } }
    if (command.type === "session.label") return { ok: true, result: { itemId: command.itemId, ...(command.label ? { label: command.label.trim() } : {}) } }
  } })
  h.app.applySettings({ onboarded: true })
  await h.type("/label ")
  await h.type("good fix\r")
  expect(h.sentOf("session.label").at(-1)).toEqual({ type: "session.label", sessionId, itemId: two.itemId, label: "good fix" })
  await h.type("/label\r")
  expect(h.sentOf("session.label").at(-1)).toEqual({ type: "session.label", sessionId, itemId: two.itemId })

  await h.type("/timeline\r")
  expect(h.text().join("\n")).toContain("^L bookmark")
  await h.type("\x1b[A")
  await h.type("\x0c")
  await h.type("idea a")
  expect(h.text().join("\n")).toContain("label: idea a")
  await h.type("\r")
  expect(h.sentOf("session.label").at(-1)).toEqual({ type: "session.label", sessionId, itemId: one.itemId, label: "idea a" })
  expect(h.text().join("\n")).toContain("◆ idea a")
})

test("/recap asks the daemon, shows the summary, caches it and refreshes with r", async () => {
  const sessionId = ids("session")
  let calls = 0
  const h = appHarness({ sessionId, dataDir: tempDir(), width: 100, height: 30, reply: (command) => {
    if (command.type !== "session.recap") return undefined
    calls++
    return command.refresh ? { ok: true, result: { text: "Goal: second", at: NOW, cached: false } } : { ok: true, result: { text: "Goal: ship it\n- built the store\n- next: tests", at: NOW, cached: calls > 1 } }
  } })
  h.app.applySettings({ onboarded: true })
  await h.type("/recap\r")
  expect(h.sentOf("session.recap").at(-1)).toEqual({ type: "session.recap", sessionId })
  let frame = h.text().join("\n")
  expect(frame).toContain("Recap")
  expect(frame).toContain("Goal: ship it")
  expect(frame).toContain("• built the store")
  await h.type("r")
  expect(h.sentOf("session.recap").at(-1)).toEqual({ type: "session.recap", sessionId, refresh: true })
  frame = h.text().join("\n")
  expect(frame).toContain("Goal: second")
  await h.type("\x1b")
  expect(h.text().join("\n")).not.toContain("So far")
})

test("/recap shows the daemon's refusal", async () => {
  const h = appHarness({ dataDir: tempDir(), reply: (command) => command.type === "session.recap" ? { ok: false, error: { code: "invalid_command", message: "[DAEMON]: recap needs the native engine" } } : undefined })
  h.app.applySettings({ onboarded: true })
  await h.type("/recap\r")
  expect(h.text().join("\n")).toContain("recap needs the native engine")
})

test("/changelog lists the bundled entries and marks what is new since the last look, remembered across runs", async () => {
  const dataDir = tempDir()
  const open = async () => {
    const h = appHarness({ dataDir, version: "0.0.1-dev", width: 110, height: 40 })
    h.app.applySettings({ onboarded: true })
    await h.type("/changelog\r")
    return h
  }
  const seenFile = path.join(dataDir, "tui", "changelog-seen")
  expect(existsSync(seenFile)).toBe(false)
  let frame = (await open()).text().join("\n")
  expect(frame).toContain("MendCode 0.0.1-dev · first look")
  expect(frame).toContain(CHANGELOG[0]!.title)
  expect(readFileSync(seenFile, "utf8").trim()).toBe(CHANGELOG[0]!.id)

  frame = (await open()).text().join("\n")
  expect(frame).toContain("nothing new since your last look")
  expect(frame).not.toContain("  new")

  await Bun.write(seenFile, `${CHANGELOG[1]!.id}\n`)
  frame = (await open()).text().join("\n")
  expect(frame).toContain("1 new since your last look")
  expect(entriesSince(CHANGELOG[1]!.id).map((entry) => entry.id)).toEqual([CHANGELOG[0]!.id])
  expect(entriesSince(undefined)).toHaveLength(CHANGELOG.length)
})

export type { CommandInput }
