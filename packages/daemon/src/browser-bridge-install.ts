import { createHash, generateKeyPairSync, randomBytes } from "node:crypto"
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import * as extensionFiles from "./browser-extension-files"

export const NATIVE_HOST_NAME = "com.mendcode.browser"

/** Where each Chromium browser looks for native messaging hosts, relative to the home directory. */
const BROWSERS: ReadonlyArray<{ name: string; darwin: string; linux: string }> = [
  { name: "Chrome", darwin: "Library/Application Support/Google/Chrome", linux: ".config/google-chrome" },
  { name: "Arc", darwin: "Library/Application Support/Arc/User Data", linux: "" },
  { name: "Brave", darwin: "Library/Application Support/BraveSoftware/Brave-Browser", linux: ".config/BraveSoftware/Brave-Browser" },
  { name: "Edge", darwin: "Library/Application Support/Microsoft Edge", linux: ".config/microsoft-edge" },
  { name: "Chromium", darwin: "Library/Application Support/Chromium", linux: ".config/chromium" },
]

export type BridgeFiles = {
  root: string
  extensionDir: string
  hostScript: string
  socket: string
  sitesFile: string
  receipt: string
}

export function bridgeFiles(dataDir: string): BridgeFiles {
  const root = path.join(dataDir, "browser")
  return { root, extensionDir: path.join(root, "extension"), hostScript: path.join(root, "host.sh"), socket: path.join(root, "bridge.sock"), sitesFile: path.join(root, "sites.json"), receipt: path.join(root, "installed.json") }
}

export type InstallReceipt = { extensionId: string; token: string; browsers: string[]; manifests: string[]; installedAt: number }

export function readReceipt(dataDir: string): InstallReceipt | undefined {
  try {
    const parsed = JSON.parse(readFileSync(bridgeFiles(dataDir).receipt, "utf8")) as InstallReceipt
    return typeof parsed.extensionId === "string" && typeof parsed.token === "string" ? parsed : undefined
  } catch {
    return undefined
  }
}

/** Chrome derives an unpacked extension's id from its public key: the first 16 bytes of the SHA-256 of the DER key, as a-p. */
export function extensionIdFor(publicKeyDer: Buffer) {
  return [...createHash("sha256").update(publicKeyDer).digest().subarray(0, 16)].map((byte) => String.fromCharCode(97 + (byte >> 4)) + String.fromCharCode(97 + (byte & 15))).join("")
}

export type InstallInput = {
  dataDir: string
  home: string
  platform?: NodeJS.Platform
  /** The runtime that runs the host script: the compiled binary re-enters Bun with BUN_BE_BUN. */
  execPath?: string
  /** Browser names to register for; default: those whose profile folder exists. */
  browsers?: string[]
}

export type InstallResult = { ok: true; extensionId: string; extensionDir: string; written: string[]; browsers: string[]; steps: string[] } | { ok: false; error: string }

const read = (file: string) => readFileSync(file, "utf8")

/**
 * Writes the extension, the host launcher and one native-host manifest per detected browser, then prints (returns) every
 * path. It writes nothing else and registers nothing outside `home`. An existing install keeps its key and token.
 */
export function installUserBrowser({ dataDir, home, platform = process.platform, execPath = process.execPath, browsers }: InstallInput): InstallResult {
  if (platform !== "darwin" && platform !== "linux") return { ok: false, error: `installing the browser bridge is supported on macOS and Linux, not ${platform}` }
  const files = bridgeFiles(dataDir)
  const found = BROWSERS.filter((browser) => {
    const folder = browser[platform]
    if (!folder) return false
    if (browsers && !browsers.some((name) => name.toLowerCase() === browser.name.toLowerCase())) return false
    return existsSync(path.join(home, folder))
  })
  if (found.length === 0) return { ok: false, error: browsers?.length ? `none of ${browsers.join(", ")} found in ${home}` : "no Chrome, Arc, Brave, Edge or Chromium profile folder found" }

  const previous = readReceipt(dataDir)
  const keyFile = path.join(files.root, "extension-key.pub")
  let publicDer: Buffer
  if (previous && existsSync(keyFile)) publicDer = Buffer.from(read(keyFile).trim(), "base64")
  else publicDer = generateKeyPairSync("rsa", { modulusLength: 2048 }).publicKey.export({ type: "spki", format: "der" })
  const extensionId = extensionIdFor(publicDer)
  const token = previous?.token ?? randomBytes(24).toString("hex")

  const written: string[] = []
  const put = (file: string, content: string, mode = 0o600) => {
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
    writeFileSync(file, content, { mode })
    chmodSync(file, mode)
    written.push(file)
  }
  mkdirSync(files.root, { recursive: true, mode: 0o700 })
  chmodSync(files.root, 0o700)
  put(keyFile, publicDer.toString("base64"))
  put(path.join(files.extensionDir, "manifest.json"), extensionFiles.manifest.replace("__KEY__", publicDer.toString("base64")), 0o644)
  put(path.join(files.extensionDir, "background.js"), extensionFiles.background, 0o644)
  put(path.join(files.extensionDir, "popup.html"), extensionFiles.popupHtml, 0o644)
  put(path.join(files.extensionDir, "popup.js"), extensionFiles.popupScript, 0o644)
  put(path.join(files.extensionDir, "config.json"), JSON.stringify({ token }), 0o600)
  const hostJs = path.join(files.root, "host.mjs")
  put(hostJs, extensionFiles.host.replace("__SOCKET__", JSON.stringify(files.socket)), 0o644)
  put(files.hostScript, `#!/bin/sh\nBUN_BE_BUN=1 exec ${JSON.stringify(execPath)} ${JSON.stringify(hostJs)}\n`, 0o755)

  const manifests: string[] = []
  for (const browser of found) {
    const file = path.join(home, browser[platform], "NativeMessagingHosts", `${NATIVE_HOST_NAME}.json`)
    put(file, JSON.stringify({ name: NATIVE_HOST_NAME, description: "MendCode browser bridge", path: files.hostScript, type: "stdio", allowed_origins: [`chrome-extension://${extensionId}/`] }, null, 2) + "\n", 0o644)
    manifests.push(file)
  }
  put(files.receipt, JSON.stringify({ extensionId, token, browsers: found.map((browser) => browser.name), manifests, installedAt: Date.now() } satisfies InstallReceipt, null, 2) + "\n")
  return {
    ok: true,
    extensionId,
    extensionDir: files.extensionDir,
    written,
    browsers: found.map((browser) => browser.name),
    steps: [
      `Open chrome://extensions in ${found.map((browser) => browser.name).join(" / ")}, turn on Developer mode, choose "Load unpacked" and pick ${files.extensionDir}.`,
      "On a site you want MendCode to use, click the MendCode toolbar button and choose Allow, then approve the site when MendCode asks.",
      "Restart the browser once so it picks up the native host manifest.",
    ],
  }
}
