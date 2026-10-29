import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { z } from "zod"
import { defineTool, type ToolResult } from "../tool"
import { errorMessage, fail } from "../util"

const MAX_EDGE = 1600
const MAX_IMAGE_BYTES = 5 * 1024 * 1024
const COMMAND_TIMEOUT_MS = 15_000
const SCREENCAPTURE = "/usr/sbin/screencapture"
const SIPS = "/usr/bin/sips"
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47]

const PERMISSION_HELP = "grant Screen Recording to your terminal in System Settings › Privacy & Security › Screen & System Audio Recording, then restart it"

export type CommandOutput = { code: number; stdout: string; stderr: string }
export type CommandRunner = (command: string[], signal: AbortSignal) => Promise<CommandOutput>

/** Runs a command with a timeout; never throws (a spawn failure is code -1 with the message in stderr). */
export const runCommand: CommandRunner = async (command, signal) => {
  try {
    const child = Bun.spawn(command, { stdin: "ignore", stdout: "pipe", stderr: "pipe" })
    const timer = setTimeout(() => child.kill(), COMMAND_TIMEOUT_MS)
    const onAbort = () => child.kill()
    signal.addEventListener("abort", onAbort, { once: true })
    try {
      const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
      return { code, stdout, stderr }
    } finally {
      clearTimeout(timer)
      signal.removeEventListener("abort", onAbort)
    }
  } catch (error) {
    return { code: -1, stdout: "", stderr: errorMessage(error) }
  }
}

/** JXA: true/false from the OS permission check, run through osascript so it is attributed to the terminal. */
const PREFLIGHT_SCRIPT = "ObjC.import('CoreGraphics'); $.CGPreflightScreenCaptureAccess() ? 'granted' : 'denied'"

/** JXA: CGWindowID of the frontmost app's frontmost normal window, or 0. */
const FRONT_WINDOW_SCRIPT = `ObjC.import('CoreGraphics'); ObjC.import('AppKit');
const pid = $.NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier;
const list = ObjC.deepUnwrap(ObjC.castRefToObject($.CGWindowListCopyWindowInfo($.kCGWindowListOptionOnScreenOnly | $.kCGWindowListExcludeDesktopElements, 0)));
const win = list.find((w) => w.kCGWindowOwnerPID === pid && w.kCGWindowLayer === 0 && (w.kCGWindowBounds || {}).Width > 50);
win ? String(win.kCGWindowNumber) : '0'`

function pngSize(bytes: Uint8Array): { width: number; height: number } | undefined {
  if (bytes.length < 24 || PNG_SIGNATURE.some((value, index) => bytes[index] !== value)) return undefined
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const width = view.getUint32(16)
  const height = view.getUint32(20)
  return width > 0 && height > 0 ? { width, height } : undefined
}

const args = z.object({
  target: z.enum(["screen", "window"]).optional().describe('"screen" (default) or "window" (the frontmost window)'),
  display: z.number().int().min(1).optional().describe("Display number, 1 = main (screen target only)"),
  region: z
    .object({ x: z.number().int().min(0), y: z.number().int().min(0), width: z.number().int().min(1), height: z.number().int().min(1) })
    .optional()
    .describe("Capture only this rectangle, in screen points; overrides target and display"),
})

/**
 * `screenshot` for macOS. `platform` and `run` are injectable so tests can cover other platforms and failure modes
 * without touching the screen.
 */
export function createScreenshotTool({ platform = process.platform, run = runCommand }: { platform?: string; run?: CommandRunner } = {}) {
  return defineTool({
    name: "screenshot",
    description:
      "Take a screenshot of the screen, the frontmost window or a region and return it as an image you can see. macOS only. Large images are downscaled to at most 1600 px.",
    permission: "execute",
    args,
    async execute({ target, display, region }, context): Promise<ToolResult> {
      const title = "Screenshot"
      if (platform !== "darwin") return fail({ title, message: "screenshot is available on macOS only" })
      if (context.signal.aborted) return fail({ title, message: "cancelled" })
      const dir = await mkdtemp(join(tmpdir(), "mendcode-shot-"))
      const file = join(dir, "shot.png")
      try {
        const preflight = await run(["/usr/bin/osascript", "-l", "JavaScript", "-e", PREFLIGHT_SCRIPT], context.signal)
        if (preflight.code === 0 && preflight.stdout.trim() === "denied") {
          return fail({ title, message: `Screen Recording permission is missing: ${PERMISSION_HELP}` })
        }

        let scope = display ? `display ${display}` : "display 1"
        const flags: string[] = []
        let note = ""
        if (region) {
          flags.push("-R", `${region.x},${region.y},${region.width},${region.height}`)
          scope = `region ${region.x},${region.y}`
        } else if (target === "window") {
          const found = await run(["/usr/bin/osascript", "-l", "JavaScript", "-e", FRONT_WINDOW_SCRIPT], context.signal)
          const id = Number(found.stdout.trim())
          if (found.code === 0 && Number.isInteger(id) && id > 0) {
            flags.push("-l", String(id))
            scope = "frontmost window"
          } else {
            note = "\n(could not find the frontmost window; captured the whole screen instead)"
            if (display) flags.push("-D", String(display))
          }
        } else if (display) flags.push("-D", String(display))

        const captured = await run([SCREENCAPTURE, "-x", "-t", "png", ...flags, file], context.signal)
        if (context.signal.aborted) return fail({ title, message: "cancelled" })
        let bytes: Uint8Array | undefined = await readFile(file).catch(() => undefined)
        if (captured.code !== 0 || !bytes || bytes.length === 0) {
          const detail = captured.stderr.trim().split("\n")[0]
          return fail({ title, message: `screen capture failed${detail ? ` (${detail})` : ""}; ${PERMISSION_HELP}` })
        }
        let size = pngSize(bytes)
        if (!size) return fail({ title, message: `screen capture produced an unreadable image; ${PERMISSION_HELP}` })

        let mime: "image/png" | "image/jpeg" = "image/png"
        if (Math.max(size.width, size.height) > MAX_EDGE) {
          await run([SIPS, "--resampleHeightWidthMax", String(MAX_EDGE), file], context.signal)
          bytes = await readFile(file).catch(() => bytes)
          size = pngSize(bytes as Uint8Array) ?? size
        }
        if ((bytes as Uint8Array).length > MAX_IMAGE_BYTES) {
          const jpeg = join(dir, "shot.jpg")
          await run([SIPS, "-s", "format", "jpeg", "-s", "formatOptions", "70", file, "--out", jpeg], context.signal)
          const smaller = await readFile(jpeg).catch(() => undefined)
          if (!smaller || smaller.length > MAX_IMAGE_BYTES) return fail({ title, message: "screenshot is too large even after downscaling; capture a smaller region" })
          bytes = smaller
          mime = "image/jpeg"
        }
        return {
          output: `screenshot ${size.width}×${size.height} (${scope})${note}`,
          truncated: false,
          title,
          isError: false,
          images: [{ mime, bytes: bytes as Uint8Array }],
          meta: { width: size.width, height: size.height, bytes: (bytes as Uint8Array).length },
        }
      } catch (error) {
        return fail({ title, message: `screenshot failed: ${errorMessage(error)}` })
      } finally {
        await rm(dir, { recursive: true, force: true })
      }
    },
  })
}

export default createScreenshotTool()
