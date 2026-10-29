import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { AttachmentError, detectImageMime, MAX_ATTACHMENT_BYTES } from "./attachments"

const COMMAND_TIMEOUT_MS = 3_000

export type CommandOutput = { code: number; stdout: Uint8Array; stderr: string }
export type CommandRunner = (command: string[], timeoutMs: number) => Promise<CommandOutput>

/** Runs a command with a timeout; never throws (a spawn failure is code -1 with the message in stderr). */
export const runCommand: CommandRunner = async (command, timeoutMs) => {
  try {
    const child = Bun.spawn(command, { stdin: "ignore", stdout: "pipe", stderr: "pipe" })
    const timer = setTimeout(() => child.kill(), timeoutMs)
    try {
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).arrayBuffer().then((buffer) => new Uint8Array(buffer)),
        new Response(child.stderr).text(),
        child.exited,
      ])
      return { code, stdout, stderr }
    } finally {
      clearTimeout(timer)
    }
  } catch (error) {
    return { code: -1, stdout: new Uint8Array(), stderr: error instanceof Error ? error.message : String(error) }
  }
}

export type ClipboardImage = { bytes: Uint8Array; mime: string }
export type ClipboardReader = { read(): Promise<ClipboardImage>; readText?(): Promise<string> }

/** AppleScript: writes the clipboard as `asClass` to `file`; stdout is "ok" or "none" (no error thrown). */
function readClipboardScript(asClass: string, rawFile: string) {
  const file = rawFile.replace(/[\\"]/g, "\\$&")
  return `try
  set imageData to the clipboard as «class ${asClass}»
on error
  return "none"
end try
set fileRef to open for access POSIX file "${file}" with write permission
set eof fileRef to 0
write imageData to fileRef
close access fileRef
return "ok"`
}

async function readDarwin(run: CommandRunner, timeoutMs: number, which: (bin: string) => string | null): Promise<Uint8Array> {
  const dir = await mkdtemp(path.join(tmpdir(), "mendcode-clip-"))
  try {
    const png = path.join(dir, "clip.png")
    const pngResult = await run(["osascript", "-e", readClipboardScript("PNGf", png)], timeoutMs)
    if (pngResult.code === 0 && new TextDecoder().decode(pngResult.stdout).trim() === "ok") return new Uint8Array(await readFile(png))

    // macOS screenshots (Cmd+Ctrl+Shift+4) land on the clipboard as TIFF, not PNG.
    const tiff = path.join(dir, "clip.tiff")
    const tiffResult = await run(["osascript", "-e", readClipboardScript("TIFF", tiff)], timeoutMs)
    if (tiffResult.code !== 0 || new TextDecoder().decode(tiffResult.stdout).trim() !== "ok") return new Uint8Array()

    const sips = which("sips")
    if (!sips) throw new AttachmentError("clipboard tool not found: install sips (should ship with macOS)")
    const converted = await run([sips, "-s", "format", "png", tiff, "--out", png], timeoutMs)
    if (converted.code !== 0) throw new AttachmentError("could not convert the clipboard image to PNG")
    return new Uint8Array(await readFile(png))
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

async function readLinux(run: CommandRunner, timeoutMs: number, which: (bin: string) => string | null): Promise<Uint8Array> {
  const hasWlPaste = which("wl-paste") !== null
  const hasXclip = which("xclip") !== null
  if (!hasWlPaste && !hasXclip) throw new AttachmentError("clipboard tool not found: install wl-clipboard or xclip")
  if (hasWlPaste) {
    const result = await run(["wl-paste", "--type", "image/png"], timeoutMs)
    if (result.code === 0 && result.stdout.byteLength > 0) return result.stdout
  }
  if (hasXclip) {
    const result = await run(["xclip", "-selection", "clipboard", "-t", "image/png", "-o"], timeoutMs)
    if (result.code === 0 && result.stdout.byteLength > 0) return result.stdout
  }
  return new Uint8Array()
}

/** Fixed PowerShell: prints the clipboard image as base64 PNG, or nothing when there is none. No user input is interpolated. */
export const WINDOWS_CLIPBOARD_SCRIPT = "Add-Type -AssemblyName System.Windows.Forms,System.Drawing; $image = [System.Windows.Forms.Clipboard]::GetImage(); if ($null -eq $image) { exit 0 }; $stream = New-Object System.IO.MemoryStream; $image.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png); [Console]::Out.Write([Convert]::ToBase64String($stream.ToArray()))"

/** Argument array for the Windows clipboard read; `shell` is the PowerShell executable found on PATH. */
export function windowsClipboardCommand(shell: string): string[] {
  return [shell, "-NoProfile", "-NonInteractive", "-Sta", "-Command", WINDOWS_CLIPBOARD_SCRIPT]
}

async function readWindows(run: CommandRunner, timeoutMs: number, which: (bin: string) => string | null): Promise<Uint8Array> {
  const shell = which("powershell.exe") ?? which("powershell") ?? which("pwsh")
  if (!shell) throw new AttachmentError("clipboard tool not found: PowerShell is required")
  const result = await run(windowsClipboardCommand(shell), timeoutMs)
  if (result.code !== 0) return new Uint8Array()
  const encoded = new TextDecoder().decode(result.stdout).trim()
  if (!/^[A-Za-z0-9+/=]+$/.test(encoded)) return new Uint8Array()
  return Uint8Array.from(Buffer.from(encoded, "base64"))
}

/**
 * Reads an image from the system clipboard: macOS via `osascript` (falling back to `sips` for a TIFF
 * screenshot), Linux via `wl-paste` or `xclip`, Windows via PowerShell. `platform`, `run` and `which` are
 * injectable so tests never touch the real clipboard. Bounded to `timeoutMs` (default 3 s) and `MAX_ATTACHMENT_BYTES`.
 */
export function createClipboardReader(options: { platform?: string; run?: CommandRunner; which?: (bin: string) => string | null; timeoutMs?: number } = {}): ClipboardReader {
  const platform = options.platform ?? process.platform
  const run = options.run ?? runCommand
  const which = options.which ?? Bun.which
  const timeoutMs = options.timeoutMs ?? COMMAND_TIMEOUT_MS
  return {
    async readText() {
      // Windows terminals paste text themselves; an image-only Ctrl+V falls through to the image read.
      if (platform === "win32") return ""
      const command = platform === "darwin" ? ["pbpaste"] : which("wl-paste") ? ["wl-paste", "--no-newline", "--type", "text/plain"] : which("xclip") ? ["xclip", "-selection", "clipboard", "-t", "UTF8_STRING", "-o"] : undefined
      if (!command) throw new AttachmentError(`clipboard text paste is not supported on ${platform}`)
      const result = await run(command, timeoutMs)
      if (result.code !== 0) return ""
      if (result.stdout.byteLength > 100_000) throw new AttachmentError("clipboard text exceeds 100 KB")
      return new TextDecoder().decode(result.stdout)
    },
    async read() {
      if (platform !== "darwin" && platform !== "linux" && platform !== "win32") throw new AttachmentError(`clipboard image paste is not supported on ${platform}`)
      const bytes = platform === "darwin" ? await readDarwin(run, timeoutMs, which) : platform === "win32" ? await readWindows(run, timeoutMs, which) : await readLinux(run, timeoutMs, which)
      if (bytes.byteLength === 0) throw new AttachmentError("no image in the clipboard")
      if (bytes.byteLength > MAX_ATTACHMENT_BYTES) throw new AttachmentError(`clipboard image is ${Math.round(bytes.byteLength / 1_048_576)} MB; the limit is 20 MB`)
      const mime = detectImageMime(bytes)
      if (!mime) throw new AttachmentError("clipboard does not contain a supported image (PNG, JPEG, GIF or WebP)")
      return { bytes, mime }
    },
  }
}
