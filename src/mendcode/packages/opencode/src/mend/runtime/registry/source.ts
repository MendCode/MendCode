import { spawnSync } from "child_process"
import { existsSync } from "fs"
import { cp, mkdir, readFile, rm, stat } from "fs/promises"
import path from "path"
import { buildLocalRuntimePack, type RuntimePack } from "../pack"
import { sourceCacheDir } from "./state"
import type { RuntimeRegistryEntry } from "./types"

function stagedFileName(source: string) {
  return path.basename(source) || "runtime-pack.json"
}

function isLikelyGitSource(type: RuntimeRegistryEntry["type"]) {
  return type === "github" || type === "private-git" || type === "team"
}

function cloneEnv(entry: RuntimeRegistryEntry) {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: "0" }
  if (entry.type === "private-git" && entry.privateGit?.credentialMode === "env-token" && entry.privateGit.tokenEnv) {
    const token = process.env[entry.privateGit.tokenEnv]
    if (!token) throw new Error(`Private registry source ${entry.id} requires environment variable ${entry.privateGit.tokenEnv}; no credentials are stored in .mendcode/registry.json`)
    env.GIT_CONFIG_COUNT = "1"
    env.GIT_CONFIG_KEY_0 = "http.extraHeader"
    env.GIT_CONFIG_VALUE_0 = `Authorization: Bearer ${token}`
  }
  return env
}

function cloneArgs(url: string, stage: string) {
  return ["clone", "--depth", "1", url, stage]
}

export function registrySourceSmokePlan(entry: RuntimeRegistryEntry) {
  const url = entry.url || null
  const looksLocal = Boolean(url && (url.startsWith(".") || url.startsWith("/") || !/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(url)))
  return {
    id: entry.id,
    type: entry.type,
    url,
    mode: looksLocal ? "local-path" : "remote",
    clone: isLikelyGitSource(entry.type) || entry.type === "opencode-settings",
    credentialMode: entry.privateGit?.credentialMode || null,
    tokenEnv: entry.privateGit?.tokenEnv || null,
    tokenPresent: entry.privateGit?.tokenEnv ? Boolean(process.env[entry.privateGit.tokenEnv]) : false,
    storesCredentialsInRegistry: false,
    usesNetwork: Boolean(url && !looksLocal && (isLikelyGitSource(entry.type) || entry.type === "opencode-settings")),
  }
}

export async function smokeRegistrySource(entry: RuntimeRegistryEntry, root: string, execute = false) {
  const plan = registrySourceSmokePlan(entry)
  if (!plan.clone) {
    return {
      ok: true,
      execute,
      source: plan,
      note: "Source type does not use git fetch/clone; smoke is not required.",
      secretsIncluded: false,
    }
  }

  if (!execute) {
    return {
      ok: true,
      execute: false,
      source: plan,
      note: plan.usesNetwork
        ? "Dry-run only. Remote smoke is opt-in and was not executed."
        : "Dry-run only. Local git-like source can be executed without network when requested.",
      secretsIncluded: false,
    }
  }

  const stage = sourceCacheDir(root, `${entry.id}-smoke`)
  await rm(stage, { recursive: true, force: true })
  await mkdir(path.dirname(stage), { recursive: true })
  const args = cloneArgs(entry.url!, stage)
  const result = spawnSync("git", args, {
    cwd: root,
    encoding: "utf8",
    env: cloneEnv(entry),
  })
  if (result.status !== 0) {
    throw new Error(`Registry smoke failed for ${entry.id}: ${String(result.stderr || result.stdout || "").trim()}`)
  }
  const pack = await readPackFromStage(stage)
  return {
    ok: true,
    execute: true,
    source: plan,
    stageDir: stage,
    containsRuntimePack: Boolean(pack),
    fetchesNetwork: plan.usesNetwork,
    note: "Smoke cloned the source into registry cache without persisting credentials.",
    secretsIncluded: false,
  }
}

export async function fetchRegistrySource(entry: RuntimeRegistryEntry, root: string) {
  if (!entry.url && entry.type !== "local") throw new Error(`Registry source ${entry.id} requires --url`)
  const stage = sourceCacheDir(root, entry.id)
  if (entry.type === "local") {
    if (!entry.url || entry.url === ".mendcode/runtime-pack.json") return { stageDir: root, fetchesNetwork: false, fetched: false }
    const source = path.isAbsolute(entry.url) ? entry.url : path.resolve(root, entry.url)
    await rm(stage, { recursive: true, force: true })
    const info = await stat(source)
    if (info.isDirectory()) {
      await mkdir(path.dirname(stage), { recursive: true })
      await cp(source, stage, { recursive: true })
    } else {
      await mkdir(stage, { recursive: true })
      await cp(source, path.join(stage, stagedFileName(source)))
    }
    return { stageDir: stage, fetchesNetwork: false, fetched: true }
  }

  if (isLikelyGitSource(entry.type) || entry.type === "opencode-settings") {
    const url = entry.url!
    const looksLocal = url.startsWith(".") || url.startsWith("/") || !/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(url)
    const localPath = path.isAbsolute(url) ? url : path.resolve(root, url)
    if (looksLocal && existsSync(localPath)) {
      await rm(stage, { recursive: true, force: true })
      const info = await stat(localPath)
      if (info.isDirectory()) {
        await mkdir(path.dirname(stage), { recursive: true })
        await cp(localPath, stage, { recursive: true })
      } else {
        await mkdir(stage, { recursive: true })
        await cp(localPath, path.join(stage, stagedFileName(localPath)))
      }
      return { stageDir: stage, fetchesNetwork: false, fetched: true }
    }

    await rm(stage, { recursive: true, force: true })
    await mkdir(path.dirname(stage), { recursive: true })
    const result = spawnSync("git", cloneArgs(url, stage), { cwd: root, encoding: "utf8", env: cloneEnv(entry) })
    if (result.status !== 0) {
      throw new Error(`Failed to fetch registry source ${entry.id}: ${String(result.stderr || result.stdout || "").trim()}`)
    }
    return { stageDir: stage, fetchesNetwork: true, fetched: true }
  }
  return { stageDir: stage, fetchesNetwork: false, fetched: false }
}

export async function readPackFromStage(stageDir: string): Promise<RuntimePack | null> {
  const packFile = path.join(stageDir, ".mendcode", "runtime-pack.json")
  if (existsSync(packFile)) return JSON.parse(await readFile(packFile, "utf8")) as RuntimePack
  if (existsSync(path.join(stageDir, ".mendcode"))) return buildLocalRuntimePack(stageDir)
  const rootPack = path.join(stageDir, "runtime-pack.json")
  if (existsSync(rootPack)) return JSON.parse(await readFile(rootPack, "utf8")) as RuntimePack
  return null
}
