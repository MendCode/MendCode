import { describe, expect, test } from "bun:test"
import { existsSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import { createScreenshotTool, runTool, screenshot, type CommandRunner } from "../src"
import { makeContext } from "./helpers"

/** Smallest thing pngSize accepts: signature, IHDR length/type, then width and height. */
function pngHeader({ width, height, extra = 0 }: { width: number; height: number; extra?: number }): Buffer {
  const header = Buffer.alloc(24 + extra)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(header)
  header.writeUInt32BE(13, 8)
  header.write("IHDR", 12)
  header.writeUInt32BE(width, 16)
  header.writeUInt32BE(height, 20)
  return header
}

type Call = string[]
/** A fake OS: records commands and writes whatever image the scenario says screencapture/sips produce. */
function fakeMac(options: { permission?: "granted" | "denied" | "unknown"; windowId?: string; capture?: () => Buffer | undefined; captureCode?: number; resized?: Buffer; jpeg?: Buffer } = {}) {
  const calls: Call[] = []
  const files: string[] = []
  const run: CommandRunner = async (command) => {
    calls.push(command)
    const [binary] = command
    const script = command.at(-1) ?? ""
    if (binary === "/usr/bin/osascript") {
      if (script.includes("CGPreflightScreenCaptureAccess")) {
        return options.permission === "unknown" ? { code: 1, stdout: "", stderr: "no" } : { code: 0, stdout: `${options.permission ?? "granted"}\n`, stderr: "" }
      }
      return { code: 0, stdout: `${options.windowId ?? "0"}\n`, stderr: "" }
    }
    if (binary === "/usr/sbin/screencapture") {
      const file = command.at(-1)!
      files.push(file)
      const image = options.capture ? options.capture() : pngHeader({ width: 800, height: 500 })
      if (image) writeFileSync(file, image)
      return { code: options.captureCode ?? 0, stdout: "", stderr: options.captureCode ? "could not create image from display" : "" }
    }
    if (binary === "/usr/bin/sips") {
      if (command.includes("--out")) writeFileSync(command[command.indexOf("--out") + 1]!, options.jpeg ?? Buffer.alloc(2000, 1))
      else if (options.resized) writeFileSync(command.at(-1)!, options.resized)
      return { code: 0, stdout: "", stderr: "" }
    }
    return { code: 127, stdout: "", stderr: "unknown" }
  }
  return { run, calls, files }
}

const context = () => makeContext({ cwd: "/" })
const capture = (calls: Call[]) => calls.find((c) => c[0] === "/usr/sbin/screencapture")!

describe("screenshot tool", () => {
  test("is a registered execute tool that reveals the screen, so it needs approval", () => {
    expect(screenshot.name).toBe("screenshot")
    expect(screenshot.permission).toBe("execute")
  })
  test("arguments are validated at the boundary", async () => {
    const tool = createScreenshotTool({ platform: "darwin", run: fakeMac().run })
    for (const bad of [{ target: "tab" }, { display: 0 }, { region: { x: -1, y: 0, width: 10, height: 10 } }, { region: { x: 0, y: 0, width: 0, height: 10 } }, { region: { x: 0, y: 0 } }, { display: 1.5 }]) {
      expect((await runTool(tool, bad, context())).isError).toBe(true)
    }
    expect((await runTool(tool, {}, context())).isError).toBe(false)
    expect((await runTool(tool, { target: "window", display: 2, region: { x: 1, y: 2, width: 3, height: 4 } }, context())).isError).toBe(false)
  })
  test("other platforms get a clear error and nothing runs", async () => {
    const mac = fakeMac()
    for (const platform of ["linux", "win32"]) {
      const result = await createScreenshotTool({ platform, run: mac.run }).execute({}, context())
      expect(result).toMatchObject({ isError: true, output: "screenshot is available on macOS only" })
      expect(result.images).toBeUndefined()
    }
    expect(mac.calls).toEqual([])
  })
  test("captures the screen quietly to a temp file, returns the image and removes the file", async () => {
    const mac = fakeMac()
    const result = await createScreenshotTool({ platform: "darwin", run: mac.run }).execute({}, context())
    expect(result).toMatchObject({ isError: false, output: "screenshot 800×500 (display 1)", meta: { width: 800, height: 500 } })
    expect(result.images).toHaveLength(1)
    expect(result.images![0]).toMatchObject({ mime: "image/png" })
    expect(result.images![0]!.bytes.length).toBe(24)
    const call = capture(mac.calls)
    expect(call.slice(0, 4)).toEqual(["/usr/sbin/screencapture", "-x", "-t", "png"])
    expect(mac.calls.some((c) => c[0] === "/usr/bin/sips")).toBe(false)
    expect(existsSync(dirname(mac.files[0]!))).toBe(false)
  })
  test("display and region select what is captured", async () => {
    const display = fakeMac()
    const shown = await createScreenshotTool({ platform: "darwin", run: display.run }).execute({ display: 2 }, context())
    expect(capture(display.calls).slice(4, 6)).toEqual(["-D", "2"])
    expect(shown.output).toBe("screenshot 800×500 (display 2)")
    const region = fakeMac({ capture: () => pngHeader({ width: 400, height: 300 }) })
    const cropped = await createScreenshotTool({ platform: "darwin", run: region.run }).execute({ region: { x: 10, y: 20, width: 200, height: 150 } }, context())
    expect(capture(region.calls).slice(4, 6)).toEqual(["-R", "10,20,200,150"])
    expect(cropped.output).toBe("screenshot 400×300 (region 10,20)")
  })
  test("window target uses the frontmost window id, and falls back to the screen with a note when none is found", async () => {
    const found = fakeMac({ windowId: "4242" })
    const window = await createScreenshotTool({ platform: "darwin", run: found.run }).execute({ target: "window" }, context())
    expect(capture(found.calls).slice(4, 6)).toEqual(["-l", "4242"])
    expect(window.output).toBe("screenshot 800×500 (frontmost window)")
    const missing = fakeMac({ windowId: "0" })
    const fallback = await createScreenshotTool({ platform: "darwin", run: missing.run }).execute({ target: "window" }, context())
    expect(capture(missing.calls)).not.toContain("-l")
    expect(fallback.isError).toBe(false)
    expect(fallback.output).toContain("captured the whole screen instead")
  })
  test("large captures are downscaled to 1600 px and the smaller size is reported", async () => {
    const mac = fakeMac({ capture: () => pngHeader({ width: 3200, height: 2000 }), resized: pngHeader({ width: 1600, height: 1000 }) })
    const result = await createScreenshotTool({ platform: "darwin", run: mac.run }).execute({}, context())
    expect(mac.calls.find((c) => c[0] === "/usr/bin/sips")!.slice(0, 3)).toEqual(["/usr/bin/sips", "--resampleHeightWidthMax", "1600"])
    expect(result.output).toBe("screenshot 1600×1000 (display 1)")
  })
  test("an image still over 5 MB after downscaling is re-encoded as JPEG", async () => {
    const mac = fakeMac({ capture: () => pngHeader({ width: 1200, height: 800, extra: 6 * 1024 * 1024 }), jpeg: Buffer.alloc(3000, 7) })
    const result = await createScreenshotTool({ platform: "darwin", run: mac.run }).execute({}, context())
    expect(result.images![0]).toMatchObject({ mime: "image/jpeg" })
    expect(result.images![0]!.bytes.length).toBe(3000)
    const tooBig = fakeMac({ capture: () => pngHeader({ width: 1200, height: 800, extra: 6 * 1024 * 1024 }), jpeg: Buffer.alloc(6 * 1024 * 1024) })
    expect((await createScreenshotTool({ platform: "darwin", run: tooBig.run }).execute({}, context())).output).toContain("too large")
  })
  test("missing Screen Recording permission is reported with what to do, before capturing", async () => {
    const mac = fakeMac({ permission: "denied" })
    const result = await createScreenshotTool({ platform: "darwin", run: mac.run }).execute({}, context())
    expect(result.isError).toBe(true)
    expect(result.output).toContain("Screen Recording")
    expect(result.output).toContain("System Settings")
    expect(mac.calls.some((c) => c[0] === "/usr/sbin/screencapture")).toBe(false)
  })
  test("an unknown permission state still tries to capture; an empty or failed capture gets the same guidance", async () => {
    const unknown = fakeMac({ permission: "unknown" })
    expect((await createScreenshotTool({ platform: "darwin", run: unknown.run }).execute({}, context())).isError).toBe(false)
    for (const scenario of [fakeMac({ capture: () => undefined }), fakeMac({ capture: () => Buffer.alloc(0) }), fakeMac({ captureCode: 1, capture: () => undefined }), fakeMac({ capture: () => Buffer.from("not a png at all, just text") })]) {
      const result = await createScreenshotTool({ platform: "darwin", run: scenario.run }).execute({}, context())
      expect(result.isError).toBe(true)
      expect(result.output).toContain("Screen Recording")
      expect(existsSync(dirname(scenario.files[0]!))).toBe(false)
    }
  })
  test("cancellation before starting does nothing", async () => {
    const mac = fakeMac()
    const controller = new AbortController()
    controller.abort()
    const result = await createScreenshotTool({ platform: "darwin", run: mac.run }).execute({}, makeContext({ cwd: "/", signal: controller.signal }))
    expect(result).toMatchObject({ isError: true, output: "cancelled" })
    expect(mac.calls).toEqual([])
  })
})
