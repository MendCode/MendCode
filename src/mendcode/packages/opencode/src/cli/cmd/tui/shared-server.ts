import fs from "fs/promises"
import path from "path"
import { Global } from "@mendcode/core/global"

const STATE_VERSION = 1 as const
const LOCK_STALE_AFTER_MS = 30_000

export type SharedServerState = {
  version: typeof STATE_VERSION
  pid: number
  url: string
  username: string
  password: string
  startedAt: string
}

function rootPath() {
  return path.join(Global.Path.state, "shared-server")
}

export function statePath() {
  return path.join(rootPath(), "server.json")
}

function lockPath() {
  return path.join(rootPath(), "server.lock")
}

function validState(value: unknown): value is SharedServerState {
  if (!value || typeof value !== "object") return false
  const state = value as Record<string, unknown>
  if (state.version !== STATE_VERSION) return false
  if (typeof state.pid !== "number" || !Number.isInteger(state.pid) || state.pid <= 0) return false
  if (typeof state.url !== "string" || typeof state.username !== "string" || typeof state.password !== "string")
    return false
  if (typeof state.startedAt !== "string") return false

  try {
    const url = new URL(state.url)
    if (url.protocol !== "http:" || url.hostname !== "127.0.0.1") return false
    if (url.username || url.password) return false
  } catch {
    return false
  }

  return true
}

export function parseState(value: unknown) {
  return validState(value) ? value : undefined
}

export async function readState() {
  try {
    return parseState(JSON.parse(await fs.readFile(statePath(), "utf8")))
  } catch {
    return undefined
  }
}

export async function writeState(state: SharedServerState) {
  await fs.mkdir(rootPath(), { recursive: true, mode: 0o700 })
  const temporary = `${statePath()}.${process.pid}.${Date.now()}.tmp`
  try {
    await fs.writeFile(temporary, JSON.stringify(state), { encoding: "utf8", mode: 0o600 })
    await fs.rm(statePath(), { force: true })
    await fs.rename(temporary, statePath())
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => undefined)
  }
}

export async function clearState() {
  await fs.rm(statePath(), { force: true }).catch(() => undefined)
}

export function credentials() {
  return {
    username: process.env.MENDCODE_SERVER_USERNAME || process.env.OPENCODE_SERVER_USERNAME || "mendcode",
    password:
      process.env.MENDCODE_SERVER_PASSWORD ||
      process.env.OPENCODE_SERVER_PASSWORD ||
      `${crypto.randomUUID()}${crypto.randomUUID()}`,
  }
}

export async function acquireLock(timeoutMs = 12_000) {
  await fs.mkdir(rootPath(), { recursive: true, mode: 0o700 })
  const started = Date.now()

  while (Date.now() - started < timeoutMs) {
    try {
      await fs.mkdir(lockPath())
      await fs.writeFile(path.join(lockPath(), "owner"), String(process.pid), { encoding: "utf8", mode: 0o600 })
      return async () => {
        await fs.rm(lockPath(), { recursive: true, force: true }).catch(() => undefined)
      }
    } catch {
      try {
        const stat = await fs.stat(lockPath())
        if (Date.now() - stat.mtimeMs > LOCK_STALE_AFTER_MS) {
          await fs.rm(lockPath(), { recursive: true, force: true })
          continue
        }
      } catch {
        // The lock disappeared between mkdir and stat. Retry immediately.
      }
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
  }

  return undefined
}

export * as SharedServer from "./shared-server"
