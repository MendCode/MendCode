import { afterEach, describe, expect, test } from "bun:test"
import { glyphs } from "../src/ui/theme"
import { reasoningBlock } from "../src/view/chat-blocks"
import { textWidth } from "../src/view/wrap"
import { appHarness, cleanTemps, conversation, ids, plain, tempDir } from "./session-ui-harness"

afterEach(cleanTemps)

/** A source text made of distinct words (`cmd001 cmd002 ...`), so a frame can tell how far into it a row got. */
const words = (prefix: string, count: number, join = " ") => Array.from({ length: count }, (_, i) => `${prefix}${String(i + 1).padStart(3, "0")}`).join(join)

/** Every long text the fixture puts in the session, by name; the test looks each one up in the frames. */
const SOURCES = {
  user: words("usr", 40),
  answer: words("ans", 50),
  codeLine: words("cde", 30, "_"),
  cell: words("cel", 20),
  bullet: words("blt", 30),
  quote: words("quo", 30),
  command: `cd /Users/user/Code/repos/${words("cmd", 24, "/")} && bun scripts/build.ts --base-url ${words("url", 6, "-")}`,
  runningCommand: `bun run ${words("run", 30)}`,
  readPath: `src/${words("rdp", 14, "/")}/index.ts`,
  editPath: `packages/${words("edp", 14, "/")}/main.ts`,
  hunk: `function ${words("hnk", 30, "_")}`,
  grepPattern: words("grp", 20, ","),
  fetchUrl: `example.com/${words("web", 16, "/")}`,
  // The Claude Code engine's titles have no `tool: ` prefix: a bash command is the whole title, the others are `verb argument`.
  claudeCommand: `cd /srv/claude-code/heltecv4-32bit-windows && make release BASE_URL=${words("bsh", 20, "/")}`,
  claudeRunning: `bun scripts/build.ts --base-url ${words("bsr", 20, "/")}`,
  claudeRead: `read /Users/user/Code/${words("crd", 16, "/")}/index.ts`,
  claudeEdit: `edit /Users/user/Code/${words("ced", 16, "/")}/index.ts`,
  task: words("tsk", 28),
  todo: words("tdo", 24),
  thought: words("tht", 60),
  queued: words("que", 25),
  output: words("out", 40),
  failure: words("err", 40),
} as const

type Source = keyof typeof SOURCES

/** A turn with the long tool calls of every kind; `mode` and `width` are the view under test. */
async function session(mode: "minimal" | "balanced" | "full", width: number) {
  const h = appHarness({ dataDir: tempDir(), directory: tempDir(), width, height: 400, mode })
  h.app.applySettings({ onboarded: true })
  await Bun.sleep(10)
  const talk = conversation(h.sessionId, h.app.onEvent)
  talk.exchange(SOURCES.user, `${SOURCES.answer}\n\n\`\`\`ts\nconst value = "${SOURCES.codeLine}"\n\`\`\`\n\n| name | note |\n| --- | --- |\n| row | ${SOURCES.cell} |\n\n- ${SOURCES.bullet}\n\n> ${SOURCES.quote}`)
  const turnId = ids("turn")
  talk.emit({ type: "turn.started", turnId, queueId: ids("queue") })
  const reasoning = ids("item")
  talk.emit({ type: "item.started", turnId, itemId: reasoning, kind: "reasoning" })
  talk.emit({ type: "item.completed", itemId: reasoning, status: "ok", text: `${SOURCES.thought}\n\nThe plan has a few steps.` })
  const tool = (title: string, text: string, status: "ok" | "error" | "running" = "ok", input?: object) => {
    const itemId = ids("item")
    talk.emit({ type: "item.started", turnId, itemId, kind: "tool_call", meta: { tool: title } })
    if (status !== "running") talk.emit({ type: "item.completed", itemId, status, text, ...(input ? { toolInput: JSON.stringify(input) } : {}), meta: { tool: title } })
    return itemId
  }
  tool(`shell: ${SOURCES.command}`, SOURCES.output)
  tool(`shell: ${SOURCES.command}`, SOURCES.failure, "error")
  tool(`read: ${SOURCES.readPath}`, Array.from({ length: 6 }, (_, i) => `${String(i + 1).padStart(6)}\tconst value${i} = 1`).join("\n"))
  tool(`edit: ${SOURCES.editPath}`, `@@ -1,1 +1,1 @@ ${SOURCES.hunk}\n-old\n+new`)
  tool(`write: ${SOURCES.editPath}`, `Created ${SOURCES.editPath} (12 bytes)`)
  tool(`grep: src`, "src/a.ts:1:match", "ok", { pattern: SOURCES.grepPattern, path: "src" })
  tool(`webfetch: https://${SOURCES.fetchUrl}`, "page text")
  tool(SOURCES.claudeCommand, SOURCES.output)
  tool(SOURCES.claudeRead, "file text")
  tool(SOURCES.claudeEdit, "edited")
  tool(`task: ${SOURCES.task}`, "result text")
  tool("todo 0/1", `[ ] ${SOURCES.todo}`)
  tool(`mcp__server__${words("mcp", 8, "_")}: ${SOURCES.task}`, "ok")
  tool(`shell: ${SOURCES.runningCommand}`, "", "running")
  tool(SOURCES.claudeRunning, "", "running")
  // Typed while the turn runs: the prompt waits in the queue.
  talk.emit({ type: "queue.changed", queue: [{ queueId: ids("queue"), preview: SOURCES.queued, attachments: 0 }] })
  h.app.render()
  return h
}

/** The frame's characters with the chrome (rails) and every blank taken out: a wrapped text reads on as one run. */
const flat = (rows: string[]) => rows.join("").replace(/[│|▏┃↪]/g, "").replace(/\s+/g, "")

/** Shortest start of a source that counts as showing it at all (shorter could be a coincidence). */
const HEAD = 12

/**
 * How a source shows in the frame, comparing the source text with what the rows say: `whole` when all of it is there in order
 * (wrapped over rows or not), `ellipsis` when its start is there and a `…` follows it (a cut at the end or in the middle), `cut`
 * when its start is there and the text just stops, `hidden` when none of it shows.
 */
export function showing(frame: string[], source: string): "whole" | "ellipsis" | "cut" | "hidden" {
  const text = flat(frame)
  const target = source.replace(/\s+/g, "")
  if (text.includes(target)) return "whole"
  // The longest start of the source the frame has: whatever follows it says whether the text ended there on purpose.
  for (let length = target.length - 1; length >= Math.min(HEAD, target.length); length--) {
    const start = target.slice(0, length)
    if (text.includes(start)) return text.includes(`${start}…`) || text.includes(`${start}...`) ? "ellipsis" : "cut"
  }
  return "hidden"
}

const SIZES = [60, 80, 120, 200] as const
const MODES = ["minimal", "balanced", "full"] as const

describe("a row is never silently clipped", () => {
  for (const mode of MODES) {
    for (const width of SIZES) {
      test(`${mode} view at ${width} columns: every row fits and every long text wraps or ends in an ellipsis`, async () => {
        const h = await session(mode, width)
        const frame = h.frames.at(-1)!.map(plain)
        const wide = frame.map((row, at) => ({ at, width: textWidth(row), row })).filter((row) => row.width > width)
        expect(wide).toEqual([])
        const cut = (Object.keys(SOURCES) as Source[]).filter((name) => showing(frame, SOURCES[name]) === "cut")
        expect(cut).toEqual([])
        // The conversation itself is never lost: the user's message, the answer and the command that is still running show at least in part in every view.
        expect((["user", "answer", "claudeRunning", "queued"] as Source[]).filter((name) => showing(frame, SOURCES[name]) === "hidden")).toEqual([])
      })
    }
  }
})

describe("the Thought: header", () => {
  test("a title that needs more than the two rows the header keeps ends its second row in an ellipsis", () => {
    const title = words("ttl", 12)
    const rows = reasoningBlock({ text: `${title}\n\nbody`, running: false, ms: 1500, width: 40, rows: 4, glyphs: glyphs({}), oneLine: false })
    const text = rows.map(plain)
    expect(text.slice(0, 2).every((row) => textWidth(row) <= 40)).toBe(true)
    expect(text[1]).toMatch(/…$/)
    expect(showing(text.slice(0, 2), `Thought: ${title}`)).toBe("ellipsis")
  })
})

describe("the fit check itself", () => {
  const frame = (rows: string[]) => rows
  test("tells a wrapped text, an ellipsis, a cut and a missing text apart", () => {
    const source = "alpha01 beta02 gamma03 delta04 epsilon05"
    expect(showing(frame(["  alpha01 beta02 gamma03", "  │ delta04 epsilon05"]), source)).toBe("whole")
    expect(showing(frame(["  alpha01 beta02 gam…"]), source)).toBe("ellipsis")
    expect(showing(frame(["  alpha01 beta02 gamma03 …ilon05"]), source)).toBe("ellipsis")
    expect(showing(frame(["  alpha01 beta02 gam"]), source)).toBe("cut")
    expect(showing(frame(["  alpha01 beta02 gamma03 delta04 eps  1s"]), source)).toBe("cut")
    expect(showing(frame(["  nothing here"]), source)).toBe("hidden")
  })
})

