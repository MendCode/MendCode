import type { UninstallPlan } from "@mendcode/upgrade/uninstall"
import { uninstallFrame } from "../view/uninstall-page"
import type { Line } from "./theme"
import { createScreen } from "./screen"
import { tokenizeKeys } from "./keys"

export function createUninstallPrompt(ctx: { plan: UninstallPlan; size(): { width: number; height: number }; draw(rows: Line[]): void; finish(confirmed: boolean): void; dryRun?: boolean }) {
  let scroll = 0
  let finished = false
  const render = () => {
    const frame = uninstallFrame({ plan: ctx.plan, ...ctx.size(), scroll, ...(ctx.dryRun ? { dryRun: true } : {}) })
    scroll = Math.min(scroll, frame.maxScroll)
    ctx.draw(frame.rows)
  }
  const key = (seq: string) => {
    if (finished) return
    if (["\x1b", "\x03", "n", "N", "q", "\r", "\n"].includes(seq) || !ctx.dryRun && !ctx.plan.fatal && ["y", "Y"].includes(seq)) {
      finished = true
      ctx.finish(!ctx.dryRun && !ctx.plan.fatal && ["y", "Y"].includes(seq))
      return
    }
    if (["\x1b[B", "\x1bOB", "j"].includes(seq)) scroll++
    else if (["\x1b[A", "\x1bOA", "k"].includes(seq)) scroll = Math.max(0, scroll - 1)
    else if (seq === "\x1b[6~") scroll += Math.max(1, ctx.size().height - 4)
    else if (seq === "\x1b[5~") scroll = Math.max(0, scroll - ctx.size().height + 4)
    else if (seq === "\x1b[H" || seq === "\x1bOH") scroll = 0
    render()
  }
  return { render, key }
}

export async function terminalUninstallPrompt(plan: UninstallPlan, dryRun = false) {
  const screen = createScreen(process.stdout, process.env)
  const previousRaw = process.stdin.isRaw
  let resolve!: (value: boolean) => void
  const done = new Promise<boolean>((settle) => { resolve = settle })
  const app = createUninstallPrompt({ plan, dryRun, size: () => ({ width: process.stdout.columns ?? 80, height: process.stdout.rows ?? 24 }), draw: (rows) => screen.draw(rows), finish: resolve })
  const input = (chunk: Buffer) => { for (const token of tokenizeKeys(chunk.toString("utf8"))) if (token.type === "key") app.key(token.seq) }
  const resize = () => { screen.resize(process.stdout.columns ?? 80, process.stdout.rows ?? 24); app.render() }
  const stop = () => resolve(false)
  try {
    screen.enter()
    process.stdin.setRawMode?.(true)
    process.stdin.on("data", input)
    process.stdout.on("resize", resize)
    process.once("SIGTERM", stop)
    process.stdin.resume()
    app.render()
    return await done
  } finally {
    process.stdin.off("data", input)
    process.stdout.off("resize", resize)
    process.off("SIGTERM", stop)
    process.stdin.setRawMode?.(previousRaw ?? false)
    process.stdin.pause()
    screen.leave()
  }
}
