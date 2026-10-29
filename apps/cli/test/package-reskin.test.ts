import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createClient } from "@mendcode/client"
import { createFauxEngine } from "@mendcode/engine-faux"
import type { PackagesReport, Settings } from "@mendcode/protocol"
import { setTheme } from "../src/ui/theme"
import { startDaemon } from "../../../packages/daemon/src"
import { readWorkflowScripts } from "../../../packages/daemon/src/workflow-files"
import { extensionLayers } from "../../../packages/packages/src"
import { registerThemes, setTheme, sgr } from "../src/ui/theme"
import type { Line } from "../src/ui/theme"
import { appHarness } from "./extensions-harness"
import { budgetMs } from "../../../scripts/test-budget"

/**
 * The promise of docs/packages.md, end to end on a real daemon in a temp dir: install a full reskin, enable it, every surface
 * changes, edit it and it reloads, disable it and every frame equals the default byte for byte, remove it and it stays that way.
 * `PACKAGE_RESKIN_FRAMES=<dir>` also writes the frames (plain text, and with colors) for reading.
 */

const EXAMPLE = path.join(import.meta.dir, "..", "..", "..", "examples", "packages", "retro")
const SIZES = [{ width: 100, height: 30 }, { width: 200, height: 60 }] as const
const FRAMES_OUT = process.env.PACKAGE_RESKIN_FRAMES

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  registerThemes([])
  setTheme("mend")
})

function temp(prefix: string) {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), prefix)))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

/** What the terminal would write: every span with its real color codes, so a theme change is a byte change. */
const ansi = (rows: Line[]) => rows.map((line) => line.map((span) => `${sgr(span, "truecolor")}${span.text}\x1b[0m`).join("")).join("\n")
const plain = (rows: Line[]) => rows.map((line) => line.map((span) => span.text).join("").replace(/\s+$/, "")).join("\n")

async function boot() {
  const dir = temp("mend-reskin-")
  const project = temp("mend-reskin-project-")
  const daemon = await startDaemon({ dir, socketPath: path.join(dir, "mendd.sock"), engine: ({ clock }) => createFauxEngine({ clock, deltaMs: 1 }) })
  cleanups.push(() => daemon.stop())
  const client = createClient({ socketPath: daemon.socketPath, name: "reskin" })
  await client.connect()
  cleanups.push(() => client.close())
  const send = (command: Record<string, unknown>) => client.send({ ...command, directory: project } as never) as Promise<{ ok: boolean; result?: unknown; error?: { message: string } }>
  const settings = async () => ((await client.send({ type: "settings.get" })) as { result?: { settings?: Settings } }).result?.settings ?? {}
  return { dir, project, client, send, settings }
}

type Boot = Awaited<ReturnType<typeof boot>>
type Surface = "chat" | "slash" | "home"

/** One live terminal per surface and size: the same instance goes default -> package -> default, like a user's would. */
async function terminal(env: Boot, size: { width: number; height: number }, surface: Surface) {
  const h = await appHarness({ dataDir: env.dir, directory: env.project, width: size.width, height: size.height, reply: (command) => env.client.send(command as never) })
  await h.start({ onboarded: true, ...(await env.settings()) } as never)
  await Bun.sleep(30)
  if (surface !== "home") {
    h.message("how do I list the files here?", "Run `ls -la` in the project folder.\n\n- **src** holds the code\n- **docs** holds the guides\n\n```sh\nls -la\n```")
    h.tool("read: src/main.ts", "import { run } from './run'\nrun()\nexport {}")
    h.tool("shell: make test", "42 passed\n0 failed")
  }
  if (surface === "slash") await openSlashMenu(h)
  h.app.render()
  return h
}

/** The user types "/" again: the terminal asks the daemon for the custom commands each time the menu opens. */
async function openSlashMenu(h: Awaited<ReturnType<typeof appHarness>>) {
  h.app.editor.clear()
  await h.type("/")
  await Bun.sleep(30)
  h.app.render()
}

type Terminal = Awaited<ReturnType<typeof terminal>>
let revision = 0

/** Renders until the frame shows `text` and returns it as plain text; at the deadline returns the last frame so the assertion prints what was on screen. */
async function frameWith(h: Terminal, text: string, milliseconds = budgetMs(10_000)) {
  const deadline = Date.now() + milliseconds
  for (;;) {
    h.app.render()
    const frame = plain(h.frames.at(-1)!)
    if (frame.includes(text) || Date.now() > deadline) return frame
    await Bun.sleep(20)
  }
}

/** What the daemon decided is pushed to every terminal like its own `settings.changed`, then the extensions reload. */
async function sync(env: Boot, all: Terminal[]) {
  const settings = await env.settings()
  revision++
  for (const h of all) {
    h.app.applySettings({ onboarded: true, ...settings } as never)
    h.app.onGlobal({ type: "extensions.changed", revision, seq: revision, at: 0 } as never)
    await h.app.extensionsReady
  }
  await Bun.sleep(40)
  for (const h of all) h.app.render()
}

async function shots(all: Array<{ key: string; h: Terminal }>) {
  const out: Record<string, { ansi: string; plain: string }> = {}
  for (const { key, h } of all) {
    if (key.endsWith("-slash")) await openSlashMenu(h)
    h.app.render()
    out[key] = { ansi: ansi(h.frames.at(-1)!), plain: plain(h.frames.at(-1)!) }
  }
  return out
}

describe("the Retro package changes every surface and puts everything back", () => {
  test("install -> enable -> frames differ per surface -> hot reload -> disable -> byte-equal default -> remove", async () => {
    // The palette is process-wide state another test file may have left behind: start from the default one.
    setTheme("mend")
    const env = await boot()
    const surfaces: Surface[] = ["chat", "slash", "home"]
    const small = SIZES[0], large = SIZES[1]
    const at = (size: { width: number; height: number }, surface: Surface) => `${size.width}x${size.height}-${surface}`
    const live: Array<{ key: string; h: Terminal }> = []
    for (const size of SIZES) for (const surface of surfaces) live.push({ key: at(size, surface), h: await terminal(env, size, surface) })
    const terminals = live.map((entry) => entry.h)

    const base = await shots(live)

    // Install: the package comes on, claims the look and applies as an overlay.
    const installed = await env.send({ type: "packages.install", source: EXAMPLE, scope: "user" })
    expect(installed.ok).toBe(true)
    expect((installed.result as PackagesReport).packages.map((pkg) => [pkg.key, pkg.enabled])).toEqual([["user:retro", true]])
    await sync(env, terminals)
    const on = await shots(live)
    for (const key of Object.keys(base)) expect([key, on[key]!.ansi === base[key]!.ansi]).toEqual([key, false])

    // Theme: amber primary in the bytes, absent from the default.
    expect(on[at(small, "chat")]!.ansi).toContain("38;2;255;176;0")
    expect(base[at(small, "chat")]!.ansi).not.toContain("38;2;255;176;0")
    // Transcript message and tool card views.
    expect(on[at(large, "chat")]!.plain).toContain("[ASSISTANT]")
    expect(on[at(large, "chat")]!.plain).toContain("▌")
    expect(on[at(small, "chat")]!.plain).toMatch(/\[READ\] src\/main\.ts/)
    expect(on[at(small, "chat")]!.plain).toMatch(/\[SHELL\] make test/)
    expect(base[at(small, "chat")]!.plain).not.toMatch(/\[ASSISTANT\]|\[READ\]/)
    // Slash menu: its own layout, with the package's pinned command in it.
    expect(on[at(small, "slash")]!.plain).toContain("retro-crt")
    expect(base[at(small, "slash")]!.plain).not.toContain("retro-crt")
    // Home: wordmark and tagline from the package.
    expect(on[at(small, "home")]!.plain).toContain("phosphor edition")
    expect(base[at(small, "home")]!.plain).not.toContain("phosphor edition")
    // Skill and workflow reach the daemon's layers.
    const skills = (await env.send({ type: "skills.list" })).result as { skills: Array<{ name: string }> }
    expect(skills.skills.map((skill) => skill.name)).toContain("retro-style")
    expect(readWorkflowScripts(extensionLayers({ userDir: env.dir, directory: env.project })).map((script) => script.name)).toContain("retro-review")
    // Keybindings and panel: alt+g is the package's key and opens the right panel with the package's cards.
    const chat = live.find((entry) => entry.key === at(large, "chat"))!.h
    const closed = plain(chat.frames.at(-1)!)
    await chat.key("\x1bg")
    const panel = plain(chat.frames.at(-1)!)
    expect(panel).not.toBe(closed)
    expect(panel).toContain("alt+g shows this panel")
    expect(base[at(large, "chat")]!.plain).not.toContain("alt+g shows this panel")
    if (FRAMES_OUT) {
      mkdirSync(FRAMES_OUT, { recursive: true })
      for (const [key, shot] of Object.entries(base)) writeFileSync(path.join(FRAMES_OUT, `default-${key}.txt`), `${key} (default)\n${"=".repeat(key.length + 10)}\n${shot.plain}\n`)
      for (const [key, shot] of Object.entries(on)) {
        writeFileSync(path.join(FRAMES_OUT, `retro-${key}.txt`), `${key} (retro)\n${"=".repeat(key.length + 8)}\n${shot.plain}\n`)
        writeFileSync(path.join(FRAMES_OUT, `retro-${key}.ansi`), shot.ansi)
      }
      writeFileSync(path.join(FRAMES_OUT, `retro-${at(large, "chat")}-panel.txt`), `${at(large, "chat")} + alt+g (retro)\n${"=".repeat(30)}\n${panel}\n`)
    }
    await chat.key("\x1bg")
    expect(plain(chat.frames.at(-1)!)).toBe(closed)

    // One precedence report (/packages, p): which layer is in force for every key the package takes, and what it overrides.
    await chat.type("/packages")
    await chat.key("\r")
    await Bun.sleep(80)
    await chat.key("p")
    // `p` asks the daemon for the layers' files and opens the page when the answer is in: wait for the page, not for a fixed time.
    const precedence = await frameWith(chat, "Precedence")
    if (FRAMES_OUT) writeFileSync(path.join(FRAMES_OUT, `retro-${at(large, "chat")}-packages-precedence.txt`), `${at(large, "chat")} /packages p (retro)\n${"=".repeat(40)}\n${precedence}\n`)
    expect(precedence).toContain("Precedence")
    expect(precedence).toContain("Profile keys")
    expect(precedence).toMatch(/promptBorder: package user:retro \(profile\) · overrides your settings/)
    await chat.key("\x1b")
    await chat.key("\x1b")
    chat.app.render()
    expect(plain(chat.frames.at(-1)!)).toBe(closed)

    // Hot reload: edit the installed copy's view and the transcript is laid out again with the new rail.
    const installedView = path.join(env.dir, "packages", "retro", "extensions", "message-assistant.ts")
    writeFileSync(installedView, readFileSync(installedView, "utf8").replace('"▌ "', '"█ "'))
    await sync(env, terminals)
    const edited = await shots(live)
    expect(edited[at(large, "chat")]!.plain).toContain("█ [ASSISTANT]")
    expect(edited[at(large, "chat")]!.plain).not.toContain("▌")

    // Disable: every frame is the default again, byte for byte.
    const disabled = await env.send({ type: "packages.enable", key: "user:retro", enabled: false })
    expect(disabled.ok).toBe(true)
    await sync(env, terminals)
    const off = await shots(live)
    for (const key of Object.keys(base)) expect([key, off[key]!.ansi]).toEqual([key, base[key]!.ansi])
    // The package only ever wrote its own off switch.
    expect((await env.settings()).disabledPackages).toEqual(["user:retro"])

    // Remove: still the default, and the folder is in the Trash, restorable.
    const removed = await env.send({ type: "packages.remove", name: "retro", scope: "user" })
    expect(removed.ok).toBe(true)
    await sync(env, terminals)
    const gone = await shots(live)
    for (const key of Object.keys(base)) expect([key, gone[key]!.ansi]).toEqual([key, base[key]!.ansi])
    expect(existsSync(path.join(env.dir, "packages", "retro"))).toBe(false)
    expect(readdirSync(path.join(env.dir, ".Trash")).some((entry) => entry.startsWith("retro@"))).toBe(true)
  }, 60_000)
})
