import { expect, test } from "bun:test"
import {
  appendLiveShellOutput,
  latestTerminalOutputPreview,
  previewShellOutput,
  renderTerminalOutput,
  selectShellOutput,
} from "../../../../src/cli/cmd/tui/context/shell-output"
import {
  createShellOutputDeltaBuffer,
  SHELL_LIVE_OUTPUT_DELTA_MAX_CHARS,
} from "../../../../src/tool/shell-output"

test("live shell output appends deltas without replaying the latest line", () => {
  expect(appendLiveShellOutput("25%\n", "30%\n")).toBe("25%\n30%\n")
  expect(appendLiveShellOutput("25%\n30%\n", "30%\n")).toBe("25%\n30%\n")
  expect(appendLiveShellOutput("25%\n30%\n", "25%\n30%\n")).toBe("25%\n30%\n")
  expect(appendLiveShellOutput("25%\n30%\n", "30%\n35%\n")).toBe("25%\n30%\n35%\n")
  expect(appendLiveShellOutput("abc", "d")).toBe("abcd")
  expect(appendLiveShellOutput("25%\r30%", "\r30%")).toBe("25%\r30%")
  expect(appendLiveShellOutput("x\n", "x\n")).toBe("x\nx\n")
})

test("live shell output can preserve repeated raw deltas", () => {
  expect(appendLiveShellOutput("tick\n", "tick\n", { replayProtection: false })).toBe("tick\ntick\n")
})

test("live shell output bounds large deltas before replay detection", () => {
  const output = appendLiveShellOutput("a".repeat(30_000), "b".repeat(30_000))

  expect(output.length).toBeLessThanOrEqual(30_005)
  expect(output.endsWith("b".repeat(100))).toBe(true)
})

test("live shell delta buffer bounds bursty output and keeps its tail", () => {
  const buffer = createShellOutputDeltaBuffer()
  buffer.append("old\n")
  buffer.append("x".repeat(SHELL_LIVE_OUTPUT_DELTA_MAX_CHARS * 4))

  const delta = buffer.take()

  expect(delta.length).toBeLessThanOrEqual(SHELL_LIVE_OUTPUT_DELTA_MAX_CHARS)
  expect(delta).toContain("Live output throttled")
  expect(delta.endsWith("x".repeat(100))).toBe(true)
  expect(buffer.hasPending()).toBe(false)
})

test("terminal output renderer stabilizes carriage-return updates", () => {
  expect(renderTerminalOutput("25%\r30%\r100%")).toBe("100%")
  expect(renderTerminalOutput("download: 25%\rdownload: 30%\ndone")).toBe("download: 30%\ndone")
  expect(renderTerminalOutput("downloading 100%\r\u001b[2Kdone")).toBe("done")
  expect(renderTerminalOutput("downloading 100%\r\u001b[Kdone")).toBe("done")
  expect(renderTerminalOutput("abc\b\bXY")).toBe("aXY")
  expect(renderTerminalOutput("a\u0000b\u0007c")).toBe("abc")
})

test("terminal output renderer preserves meaningful surrounding whitespace", () => {
  expect(renderTerminalOutput("  indented\n\n")).toBe("  indented\n\n")
  expect(renderTerminalOutput("\r  padded")).toBe("  padded")
})

test("terminal output renderer handles cursor redraw sequences", () => {
  expect(renderTerminalOutput("line1 0%\nline2 0%\u001b[2A\r\u001b[2Kline1 50%\n\r\u001b[2Kline2 50%")).toBe(
    "line1 50%\nline2 50%",
  )
  expect(renderTerminalOutput("progress old\u001b[1G\u001b[2Kprogress new")).toBe("progress new")
  expect(renderTerminalOutput("old\nvalue\u001b[2Jfresh")).toBe("fresh")
})

test("terminal output renderer ignores non-visual terminal control sequences", () => {
  expect(renderTerminalOutput("before\u001b]0;title\u0007after")).toBe("beforeafter")
  expect(renderTerminalOutput("before\u001b]8;;https://example.com\u001b\\link\u001b]8;;\u001b\\after")).toBe("beforelinkafter")
  expect(renderTerminalOutput("plain\u001b(B text")).toBe("plain text")
  expect(renderTerminalOutput("plain\u001b%G utf8\u001b#8 text")).toBe("plain utf8 text")
  expect(renderTerminalOutput("before\u001b=keypad\u001b>after\u001bcreset")).toBe("beforekeypadafterreset")
  expect(renderTerminalOutput("hidden\u001b[?25lcursor\u001b[?25h visible\u001b[31m red\u001b[0m")).toBe("hiddencursor visible red")
  expect(renderTerminalOutput("before\u001b[31")).toBe("before")
  expect(renderTerminalOutput("before\u001b]0;title")).toBe("before")
})

test("terminal output renderer supports saved cursor restores", () => {
  expect(renderTerminalOutput("start\u001b[s\nignored\u001b[u done")).toBe("start done\nignored")
  expect(renderTerminalOutput("start\u001b7\nignored\u001b8 done")).toBe("start done\nignored")
})

test("terminal output renderer handles legacy line movement and tabs", () => {
  expect(renderTerminalOutput("top\u001bEline")).toBe("top\nline")
  expect(renderTerminalOutput("top\u001bDdown")).toBe("top\n   down")
  expect(renderTerminalOutput("top\nline\u001bMup")).toBe("top up\nline")
  expect(renderTerminalOutput("a\tb")).toBe("a       b")
})

test("terminal output renderer bounds synthetic cursor movement", () => {
  const rendered = renderTerminalOutput("top\u001b[999999Bbottom")
  expect(rendered.split("\n").length).toBeLessThanOrEqual(2_002)
  expect(rendered.endsWith("bottom")).toBe(true)
  expect(renderTerminalOutput("x\u001b[999999Cy").length).toBeLessThanOrEqual(30_002)
})

test("terminal output renderer stays bounded for long unbroken whitespace", () => {
  const rendered = renderTerminalOutput(" ".repeat(100_000) + "done")

  expect(rendered.length).toBeLessThanOrEqual(30_005)
  expect(rendered.endsWith("done")).toBe(true)
})

test("terminal output renderer limits expanded rows", () => {
  const rendered = renderTerminalOutput("line\n".repeat(10_000))

  expect(rendered.split("\n").length).toBeLessThanOrEqual(2_000)
})

test("shell output preview keeps tail-only semantics", () => {
  expect(previewShellOutput("x".repeat(30_001))).toBe("...\n\n" + "x".repeat(30_000))
})

test("shell output uses live text while running and final text after completion", () => {
  expect(selectShellOutput({ running: true, live: "live tail", final: "complete output" })).toBe("live tail")
  expect(selectShellOutput({ running: false, live: "stale live tail", final: "complete output" })).toBe("complete output")
  expect(selectShellOutput({ running: false, live: "live fallback" })).toBe("live fallback")
})

test("latest terminal preview renders only tail while keeping saved-output hints", () => {
  expect(latestTerminalOutputPreview("a\nb\nc\nd", 2)).toEqual({
    text: "...\nc\nd",
    overflow: true,
    hiddenLines: 2,
  })
  expect(latestTerminalOutputPreview("a\nb", 3)).toEqual({ text: "a\nb", overflow: false, hiddenLines: 0 })
  expect(
    latestTerminalOutputPreview("...output truncated...\n\nFull output saved to: /tmp/out\nold\nnew", 1).text,
  ).toBe("...\n...output truncated...\nFull output saved to: /tmp/out\nnew")
})

test("latest terminal preview bounds long unbroken lines", () => {
  const preview = latestTerminalOutputPreview("x".repeat(10_000), 10)

  expect(preview.overflow).toBe(true)
  expect(preview.text.length).toBeLessThanOrEqual(2_055)
  expect(preview.text.endsWith("x".repeat(2_048))).toBe(true)
})
