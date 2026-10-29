import { describe, expect, test } from "bun:test"
import { defaultHomeMascot, defaultActivityMascotStates, defaultActivityMascotHover, mascotRows, mascotPhase } from "../src/view/mascot"

const plain = (phase: string) => mascotRows(phase).map((line) => line.map((span) => span.text).join("")).join("\n")
const faces = { idle: "o o", thinking: "o -", planning: "o .", memory: "o m", compacting: "o c", reading: "o o", searching: "o ?", sending: "* *", patching: "o ^", editing: "o >", running: "o !", installing: "$ $", testing: "o T", subagents: "o S", browsing: "o @", retrying: "! !", blocked: "- -", done: "^ ^", error: "x x" }

describe("official Mend ASCII mascot", () => {
  test("home preserves v1's five rows and exact spacing", () => {
    expect(defaultHomeMascot).toBe("   .-.\n  (o o)\n /|[+]|\\\n/_|___|_\\\n   \\_/")
  })
  test("all nineteen activity states preserve v1's three-row art, plus hover", () => {
    expect(Object.keys(defaultActivityMascotStates)).toEqual(Object.keys(faces))
    for (const [phase, face] of Object.entries(faces)) expect(plain(phase)).toBe(` .-.\n(${face})\n/[+]\\`)
    expect(defaultActivityMascotHover).toBe(" .-.\n(^ ^)\n/[+]\\")
    expect(plain("unknown")).toBe(plain("idle"))
  })
  test("current tool, reasoning, retry, connection and terminal state select real phases", () => {
    const base = { state: "tool", connected: true, retry: false }
    for (const [tool, phase] of Object.entries({ read: "reading", grep: "searching", patch: "patching", write: "editing", pnpm_install: "installing", typecheck: "testing", browser: "browsing", task: "subagents", memory: "memory", review: "planning", shell: "running" })) expect(mascotPhase({ ...base, current: { kind: "tool_call", tool } })).toBe(phase)
    expect(mascotPhase({ ...base, current: { kind: "reasoning" } })).toBe("thinking")
    expect(mascotPhase({ ...base, state: "compacting" })).toBe("compacting")
    expect(mascotPhase({ ...base, state: "idle" })).toBe("done")
    expect(mascotPhase({ ...base, state: "idle", failed: true })).toBe("error")
    expect(mascotPhase({ ...base, connected: false })).toBe("blocked")
    expect(mascotPhase({ ...base, retry: true })).toBe("retrying")
  })
})
