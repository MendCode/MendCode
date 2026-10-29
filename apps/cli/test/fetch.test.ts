import { afterAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createIdFactory } from "@mendcode/protocol"
import { createApp } from "../src/ui/app"
import { glyphs, type Line } from "../src/ui/theme"
import { FETCH_LOGO, fetchRows, renderFetchCard, type FetchFacts } from "../src/view/fetch-card"
import { gitBranch, nodeFs, projectFacts, scanLanguages, type FetchFs } from "../src/view/fetch-info"

const ids = createIdFactory()
const plain = (line: Line) => line.map((span) => span.text).join("")
const temps: string[] = []
const temp = () => {
  const dir = mkdtempSync(path.join(tmpdir(), "mendcode-fetch-"))
  temps.push(dir)
  return dir
}
afterAll(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true })
})
const write = (root: string, file: string, text = "") => {
  mkdirSync(path.dirname(path.join(root, file)), { recursive: true })
  writeFileSync(path.join(root, file), text)
}
const SHA = "0123456789abcdef0123456789abcdef01234567"

describe("gitBranch", () => {
  test("reads the branch from .git/HEAD, walking up from a subdirectory", () => {
    const root = temp()
    write(root, ".git/HEAD", "ref: refs/heads/feature/fetch\n")
    mkdirSync(path.join(root, "a/b"), { recursive: true })
    expect(gitBranch({ cwd: path.join(root, "a/b"), fs: nodeFs })).toBe("feature/fetch")
  })

  test("a detached HEAD shows the short sha", () => {
    const root = temp()
    write(root, ".git/HEAD", `${SHA}\n`)
    expect(gitBranch({ cwd: root, fs: nodeFs })).toBe("0123456")
  })

  test("a worktree's .git file points at the real git dir", () => {
    const root = temp()
    write(root, "real/HEAD", "ref: refs/heads/wt\n")
    write(root, "work/.git", "gitdir: ../real\n")
    expect(gitBranch({ cwd: path.join(root, "work"), fs: nodeFs })).toBe("wt")
  })

  test("no repository says no git", () => {
    const fs: FetchFs = { readText: () => undefined, list: () => undefined }
    expect(gitBranch({ cwd: "/nowhere/at/all", fs })).toBe("no git")
    expect(gitBranch({ cwd: temp(), fs: { ...nodeFs, readText: (file) => (file.endsWith("HEAD") ? undefined : nodeFs.readText(file)) } })).toBe("no git")
  })
})

describe("scanLanguages", () => {
  const clock = () => 0

  test("counts files by language, top four, most files first", () => {
    const root = temp()
    for (let index = 0; index < 5; index++) write(root, `src/f${index}.ts`)
    for (let index = 0; index < 3; index++) write(root, `lib/f${index}.py`)
    write(root, "main.rs")
    write(root, "a.go")
    write(root, "b.sh")
    write(root, "README.md")
    write(root, "package.json")
    const scan = scanLanguages({ root, fs: nodeFs, now: clock })
    expect(scan.capped).toBe(false)
    expect(scan.top.map((share) => share.name)).toEqual(["TypeScript", "Python", "Go", "Rust"])
    expect(scan.top[0]).toEqual({ name: "TypeScript", files: 5, percent: 45 })
    expect(scan.seen).toBe(13)
  })

  test("skips node_modules, .git, dist, build and graft", () => {
    const root = temp()
    write(root, "src/a.ts")
    for (const dir of ["node_modules/x", ".git/x", "dist", "build", "graft"]) write(root, `${dir}/skip.rs`)
    const scan = scanLanguages({ root, fs: nodeFs, now: clock })
    expect(scan.top).toEqual([{ name: "TypeScript", files: 1, percent: 100 }])
    expect(scan.seen).toBe(1)
  })

  test("stops at the file cap and says the shares are estimates", () => {
    const root = temp()
    for (let index = 0; index < 30; index++) write(root, `f${index}.ts`)
    const scan = scanLanguages({ root, fs: nodeFs, now: clock, files: 10 })
    expect(scan.capped).toBe(true)
    expect(scan.seen).toBe(10)
    expect(scan.top[0]!.files).toBe(10)
  })

  test("stops at the time budget between directories", () => {
    const root = temp()
    for (let index = 0; index < 5; index++) write(root, `d${index}/a.ts`)
    let tick = 0
    const scan = scanLanguages({ root, fs: nodeFs, now: () => tick++ * 20, budgetMs: 40 })
    expect(scan.capped).toBe(true)
    expect(scan.top[0]!.files).toBeLessThan(5)
  })

  test("the default caps are 5000 files and 40 ms", () => {
    let listed = 0
    const fs: FetchFs = {
      readText: () => undefined,
      list: () => {
        listed++
        return [{ name: "sub", dir: true }, ...Array.from({ length: 2_000 }, (_, index) => ({ name: `f${index}.ts`, dir: false }))]
      },
    }
    const scan = scanLanguages({ root: "/virtual", fs, now: clock })
    expect(scan.seen).toBe(5_000)
    expect(scan.capped).toBe(true)
    expect(listed).toBe(3)
  })

  test("an unreadable or empty directory gives no languages", () => {
    expect(scanLanguages({ root: "/virtual", fs: { readText: () => undefined, list: () => undefined }, now: clock })).toEqual({ top: [], seen: 0, capped: false })
  })

  test("projectFacts names the project by its directory", () => {
    const root = temp()
    write(root, ".git/HEAD", "ref: refs/heads/main\n")
    write(root, "a.ts")
    const facts = projectFacts({ cwd: root })
    expect(facts.project).toBe(path.basename(root))
    expect(facts.branch).toBe("main")
    expect(facts.languages.top[0]!.name).toBe("TypeScript")
  })
})

const facts: FetchFacts = {
  project: "mendcode",
  branch: "main",
  languages: { top: [{ name: "TypeScript", files: 8, percent: 80 }, { name: "Python", files: 2, percent: 20 }], seen: 12, capped: true },
  sessions: 14,
  model: "gpt-x · high",
  usageToday: { tokens: 123_456, calls: 12, costMicros: 1_230_000 },
  pet: "Dot",
  version: "0.4.0",
  terminal: "120x40",
}

describe("fetch card", () => {
  test("rows: what is known, in order, with ~ on a capped scan", () => {
    const rows = fetchRows(facts)
    expect(rows.map((row) => row.key)).toEqual(["project", "branch", "languages", "sessions", "model", "usage", "pet", "version", "terminal"])
    expect(rows[2]!.value).toBe("~TypeScript 80% · Python 20%")
    expect(rows[5]!.value).toBe("123K tokens · 12 calls · $1.23")
    const bare = fetchRows({ project: "p", branch: "no git", terminal: "80x24" })
    expect(bare.map((row) => row.key)).toEqual(["project", "branch", "terminal"])
  })

  test("the logo is at most 9 rows and 28 cells", () => {
    expect(FETCH_LOGO.rows).toBeLessThanOrEqual(9)
    expect(FETCH_LOGO.width).toBeLessThanOrEqual(28)
  })

  for (const width of [80, 120]) {
    test(`every row is one card wide at ${width} columns and the logo shows`, () => {
      const card = renderFetchCard({ facts, width, bottom: 30 })!
      const widths = new Set(card.rows.map((row) => Bun.stringWidth(plain(row))))
      expect(widths.size).toBe(1)
      expect([...widths][0]).toBe(Math.min(76, width - 4))
      expect(card.top + card.rows.length).toBe(30)
      const text = card.rows.map(plain).join("\n")
      expect(text).toContain("██")
      expect(text).toContain("project")
      expect(text).toContain("~TypeScript 80%")
      expect(text).toContain("esc")
    })
  }

  test("a long value is cut to its column", () => {
    const card = renderFetchCard({ facts: { ...facts, project: "x".repeat(200) }, width: 80, bottom: 30 })!
    for (const row of card.rows) expect(Bun.stringWidth(plain(row))).toBe(76)
    expect(card.rows.map(plain).join("\n")).toContain("…")
  })

  test("a narrow screen drops the logo and keeps the rows; a tiny one shows no card", () => {
    const card = renderFetchCard({ facts, width: 40, bottom: 30 })!
    const text = card.rows.map(plain).join("\n")
    expect(text).not.toContain("██")
    expect(text).toContain("branch")
    for (const row of card.rows) expect(Bun.stringWidth(plain(row))).toBe(36)
    expect(renderFetchCard({ facts, width: 20, bottom: 30 })).toBeUndefined()
    expect(renderFetchCard({ facts, width: 120, bottom: 3 })).toBeUndefined()
  })
})

function harness(directory: string) {
  const frames: Line[][] = []
  const sent: Array<Record<string, unknown>> = []
  const screen = { size: { width: 110, height: 32 }, draw: (rows: Line[]) => void frames.push(rows) } as unknown as Parameters<typeof createApp>[0]["screen"]
  const app = createApp({
    sessionId: ids("session"),
    screen,
    directory,
    version: "9.9.9",
    exit() {},
    schedule: (fn) => fn(),
    glyphs: glyphs({}),
    now: () => 1_800_000_000_000,
    random: () => 0,
    mode: "balanced",
    send: (async (command: Record<string, unknown>) => {
      sent.push(command)
      return { ok: true }
    }) as never,
  })
  const text = () => frames.at(-1)!.map(plain).join("\n")
  const key = async (value: string) => {
    await app.onKey(value)
    await Bun.sleep(5)
    app.render()
  }
  return { app, sent, text, key }
}

describe("/fetch", () => {
  test("opens a card over the chat with the project facts, sends nothing, and esc closes it", async () => {
    const root = temp()
    write(root, ".git/HEAD", "ref: refs/heads/fetch-card\n")
    write(root, "src/a.ts")
    write(root, "src/b.ts")
    write(root, "tool.py")
    const { app, sent, text, key } = harness(root)
    app.render()
    const before = sent.length
    await app.onInput("/fetch")
    await key("\r")
    expect(text()).toContain("fetch")
    expect(text()).toContain(path.basename(root))
    expect(text()).toContain("fetch-card")
    expect(text()).toContain("TypeScript 67%")
    expect(text()).toContain("9.9.9")
    expect(text()).toContain("110x32")
    expect(text()).toContain("██")
    expect(sent.slice(before).filter((command) => command.type === "session.aside" || command.type === "user.submit")).toEqual([])
    await key("\x1b")
    expect(text()).not.toContain("TypeScript 67%")
    expect(text()).not.toContain("110x32")
  })

  test("a directory without git says no git", async () => {
    const { app, text, key } = harness(temp())
    await app.onInput("/fetch")
    await key("\r")
    expect(text()).toContain("no git")
  })
})
