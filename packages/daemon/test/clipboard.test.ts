import { describe, expect, test } from "bun:test"
import { AttachmentError, MAX_ATTACHMENT_BYTES } from "../src/attachments"
import { createClipboardReader, windowsClipboardCommand, WINDOWS_CLIPBOARD_SCRIPT, type CommandOutput, type CommandRunner } from "../src/clipboard"

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0, 0, 0, 0, 0])
const ok = (stdout: Uint8Array = new Uint8Array()): CommandOutput => ({ code: 0, stdout, stderr: "" })
const fail = (stderr = ""): CommandOutput => ({ code: 1, stdout: new Uint8Array(), stderr })
const text = (s: string) => new TextEncoder().encode(s)

describe("clipboard: darwin", () => {
  test("reads a PNG straight off the clipboard via osascript", async () => {
    const calls: string[][] = []
    const run: CommandRunner = async (command) => {
      calls.push(command)
      // The PNGf attempt succeeds and osascript "wrote" the temp file; readFile is stubbed via a fake fs is
      // overkill here, so the reader's own temp file is what osascript would have written — simulate by
      // writing it directly before returning "ok".
      const file = command[2]!.match(/POSIX file "([^"]+)"/)?.[1]
      if (file) await Bun.write(file, PNG)
      return ok(text("ok"))
    }
    const reader = createClipboardReader({ platform: "darwin", run, which: () => "/usr/bin/sips" })
    const image = await reader.read()
    expect(image).toEqual({ bytes: PNG, mime: "image/png" })
    expect(calls).toHaveLength(1)
    expect(calls[0]).toEqual(["osascript", "-e", expect.stringContaining("«class PNGf»") as unknown as string])
  })

  test("falls back to TIFF + sips when the clipboard has no PNG representation", async () => {
    let call = 0
    const run: CommandRunner = async (command) => {
      call++
      if (call === 1) return ok(text("none")) // PNGf attempt: nothing on the clipboard as PNG
      if (call === 2) {
        const file = command[2]!.match(/POSIX file "([^"]+)"/)?.[1]!
        await Bun.write(file, new Uint8Array([0, 1, 2])) // fake TIFF bytes
        return ok(text("ok"))
      }
      // sips conversion: write real PNG bytes to its --out path
      const out = command.at(-1)!
      await Bun.write(out, PNG)
      return ok()
    }
    const reader = createClipboardReader({ platform: "darwin", run, which: () => "/usr/bin/sips" })
    const image = await reader.read()
    expect(image).toEqual({ bytes: PNG, mime: "image/png" })
  })

  test("no image on the clipboard at all", async () => {
    const run: CommandRunner = async () => ok(text("none"))
    const reader = createClipboardReader({ platform: "darwin", run, which: () => "/usr/bin/sips" })
    await expect(reader.read()).rejects.toThrow("no image in the clipboard")
  })

  test("a TIFF screenshot without sips installed is a clear error", async () => {
    let call = 0
    const run: CommandRunner = async (command) => {
      call++
      if (call === 1) return ok(text("none"))
      const file = command[2]!.match(/POSIX file "([^"]+)"/)?.[1]!
      await Bun.write(file, new Uint8Array([0, 1, 2]))
      return ok(text("ok"))
    }
    const reader = createClipboardReader({ platform: "darwin", run, which: () => null })
    await expect(reader.read()).rejects.toThrow("clipboard tool not found: install sips")
  })
})

describe("clipboard: linux", () => {
  test("reads via wl-paste when it is available", async () => {
    const run: CommandRunner = async (command) => (command[0] === "wl-paste" ? ok(PNG) : fail())
    const reader = createClipboardReader({ platform: "linux", run, which: (bin) => (bin === "wl-paste" ? "/usr/bin/wl-paste" : null) })
    expect(await reader.read()).toEqual({ bytes: PNG, mime: "image/png" })
  })

  test("falls back to xclip when wl-paste returns nothing", async () => {
    const run: CommandRunner = async (command) => (command[0] === "xclip" ? ok(PNG) : ok())
    const reader = createClipboardReader({ platform: "linux", run, which: () => "/usr/bin/tool" })
    expect(await reader.read()).toEqual({ bytes: PNG, mime: "image/png" })
  })

  test("neither tool installed is a clear error", async () => {
    const reader = createClipboardReader({ platform: "linux", run: async () => ok(), which: () => null })
    await expect(reader.read()).rejects.toThrow("clipboard tool not found: install wl-clipboard or xclip")
  })

  test("tools installed but the clipboard has no image", async () => {
    const reader = createClipboardReader({ platform: "linux", run: async () => ok(), which: () => "/usr/bin/xclip" })
    await expect(reader.read()).rejects.toThrow("no image in the clipboard")
  })
})

describe("clipboard: bounds and platform", () => {
  test("an unsupported platform is refused clearly", async () => {
    const reader = createClipboardReader({ platform: "freebsd", run: async () => ok() })
    await expect(reader.read()).rejects.toThrow("clipboard image paste is not supported on freebsd")
  })

  test("an oversized clipboard image is rejected before storing", async () => {
    const big = new Uint8Array(MAX_ATTACHMENT_BYTES + 1)
    big.set(PNG)
    const reader = createClipboardReader({ platform: "linux", run: async () => ok(big), which: () => "/usr/bin/wl-paste" })
    await expect(reader.read()).rejects.toThrow("the limit is 20 MB")
  })

  test("bytes that are not a supported image are rejected even if a tool reported success", async () => {
    const reader = createClipboardReader({ platform: "linux", run: async () => ok(text("not an image")), which: () => "/usr/bin/wl-paste" })
    await expect(reader.read()).rejects.toBeInstanceOf(AttachmentError)
  })
})

describe("clipboard: windows", () => {
  test("runs a fixed PowerShell argument array and decodes the base64 PNG it prints", async () => {
    const calls: string[][] = []
    const run: CommandRunner = async (command) => {
      calls.push(command)
      return ok(text(Buffer.from(PNG).toString("base64")))
    }
    const reader = createClipboardReader({ platform: "win32", run, which: (bin) => (bin === "powershell.exe" ? "C:\\Windows\\powershell.exe" : null) })
    expect(await reader.read()).toEqual({ bytes: PNG, mime: "image/png" })
    expect(calls).toEqual([windowsClipboardCommand("C:\\Windows\\powershell.exe")])
    expect(calls[0]).toEqual(["C:\\Windows\\powershell.exe", "-NoProfile", "-NonInteractive", "-Sta", "-Command", WINDOWS_CLIPBOARD_SCRIPT])
  })

  test("empty output means no image; output that is not base64 is ignored", async () => {
    for (const out of ["", "Exception: not an image"]) {
      const reader = createClipboardReader({ platform: "win32", run: async () => ok(text(out)), which: () => "powershell.exe" })
      await expect(reader.read()).rejects.toThrow("no image in the clipboard")
    }
  })

  test("without PowerShell on PATH it is a clear error, and text reads defer to the terminal", async () => {
    const reader = createClipboardReader({ platform: "win32", run: async () => ok(), which: () => null })
    await expect(reader.read()).rejects.toThrow("PowerShell")
    expect(await reader.readText!()).toBe("")
  })
})
