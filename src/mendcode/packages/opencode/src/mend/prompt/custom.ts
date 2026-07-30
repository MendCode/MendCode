import { open, realpath, stat } from "fs/promises"
import path from "path"
import { mendPaths } from "../config/paths"

export const CUSTOM_PROMPT_RELATIVE_PATH = ".mendcode/prompts/custom.md"
export const MAX_CUSTOM_PROMPT_BYTES = 32 * 1024
const DEFAULT_CUSTOM_PROMPT_NAME = "Project prompt"

export type CustomPromptResolution = {
  name: string | null
  path: string | null
  text: string
  bytes: number
  available: boolean
  fallbackReason: string | null
}

function nameFromPath(pathname: string | null) {
  if (!pathname) return DEFAULT_CUSTOM_PROMPT_NAME
  const base = path.basename(pathname, path.extname(pathname)).replace(/[-_]+/g, " ").trim()
  if (!base || base.toLowerCase() === "custom") return DEFAULT_CUSTOM_PROMPT_NAME
  return base.replace(/\b\w/g, (letter) => letter.toUpperCase())
}

function normalizeName(value: string | undefined, pathname: string | null) {
  const name = value
    ?.trim()
    .replace(/^['"]|['"]$/g, "")
    .trim()
  return (name || nameFromPath(pathname)).slice(0, 80)
}

function parsePromptDocument(input: string, pathname: string | null) {
  const normalized = input.replace(/\r\n?/g, "\n").trim()
  const frontmatter = normalized.match(/^---\n([\s\S]*?)\n---(?:\n|$)/)
  if (!frontmatter) {
    const heading = normalized.match(/^#\s+(.+?)\s*$/m)?.[1]
    return { name: normalizeName(heading, pathname), text: normalized }
  }

  const name = frontmatter[1]
    ?.split("\n")
    .find((line) => /^name\s*:/i.test(line))
    ?.replace(/^name\s*:\s*/i, "")

  return {
    name: normalizeName(name, pathname),
    text: normalized.slice(frontmatter[0].length).trim(),
  }
}

function empty(pathname: string | null, fallbackReason: string): CustomPromptResolution {
  return { name: nameFromPath(pathname), path: pathname, text: "", bytes: 0, available: false, fallbackReason }
}

function relativePath(root: string, file: string) {
  const relative = path.relative(root, file).split(path.sep).join(path.posix.sep)
  return relative && !relative.startsWith("..") && !path.isAbsolute(relative) ? relative : null
}

async function readBounded(file: string) {
  const handle = await open(file, "r")
  try {
    const buffer = Buffer.alloc(MAX_CUSTOM_PROMPT_BYTES + 1)
    const result = await handle.read(buffer, 0, buffer.length, 0)
    return buffer.subarray(0, result.bytesRead)
  } finally {
    await handle.close()
  }
}

export async function readCustomPrompt(root?: string, candidate?: string | null): Promise<CustomPromptResolution> {
  const paths = mendPaths(root)
  const configured = candidate === null ? null : candidate || paths.promptCustom
  const displayPath = configured
    ? path.isAbsolute(configured)
      ? relativePath(paths.root, path.resolve(configured))
      : configured.split(path.sep).join(path.posix.sep)
    : null
  if (!configured) return empty(displayPath, "custom prompt source is not configured")

  try {
    const projectRoot = await realpath(paths.root)
    const file = path.resolve(paths.root, configured)
    const resolved = await realpath(file)
    const relative = relativePath(projectRoot, resolved)
    if (!relative) return empty(displayPath, "custom prompt must stay inside the project root")
    const info = await stat(resolved)
    if (!info.isFile()) return empty(relative, "custom prompt path is not a regular file")
    if (info.size > MAX_CUSTOM_PROMPT_BYTES)
      return empty(relative, `custom prompt exceeds ${MAX_CUSTOM_PROMPT_BYTES} bytes`)

    const bytes = await readBounded(resolved)
    if (bytes.byteLength > MAX_CUSTOM_PROMPT_BYTES)
      return empty(relative, `custom prompt exceeds ${MAX_CUSTOM_PROMPT_BYTES} bytes`)
    const parsed = parsePromptDocument(bytes.toString("utf8"), relative)
    const text = parsed.text
    if (!text) return empty(relative, "custom prompt file is empty")
    return {
      name: parsed.name,
      path: relative,
      text,
      bytes: Buffer.byteLength(text),
      available: true,
      fallbackReason: null,
    }
  } catch {
    return empty(displayPath, "custom prompt file is unavailable")
  }
}

export * as PromptCustom from "./custom"
