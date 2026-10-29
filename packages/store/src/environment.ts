import { existsSync, readFileSync } from "node:fs"
import path from "node:path"
import { atomicPrivateWrite, createSealedFiles } from "./sealed-file"

export type EnvironmentScope = "session" | "project" | "global"
export type EnvironmentEntry = { name: string; scope: EnvironmentScope; owner: string; value: string; updatedAt: number }
export type EnvironmentInfo = Omit<EnvironmentEntry, "value" | "owner">
export const ENVIRONMENT_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/
// Never permit credentials to turn shell startup into arbitrary code execution.
const UNSAFE = /^(PATH|HOME|SHELL|ENV|BASH_ENV|BASHOPTS|SHELLOPTS|IFS|CDPATH|ZDOTDIR|PROMPT_COMMAND|PS4|NODE_OPTIONS|NODE_PATH|PYTHONPATH|PYTHONHOME|RUBYOPT|PERL5OPT|LD_.*|DYLD_.*|MENDCODE_.*)$/i

export function createEnvironment(dir: string, now: () => number) {
  const file = path.join(dir, "environment.enc")
  const sealed = createSealedFiles(dir, "environment", () => existsSync(file))
  let entries: EnvironmentEntry[] | undefined
  function load() {
    if (!entries) {
      if (!existsSync(file)) entries = []
      else {
        const bytes = readFileSync(file)
        if (!sealed.encrypted(bytes)) throw new Error("[ENV]: vault is not an authenticated encrypted file")
        const parsed = JSON.parse(sealed.open(bytes, "environment").toString("utf8"))
        if (!Array.isArray(parsed) || parsed.length > 1024 || parsed.some((entry) => !entry || typeof entry.name !== "string" || !ENVIRONMENT_NAME.test(entry.name) || entry.name.length > 128 || UNSAFE.test(entry.name) || typeof entry.value !== "string" || !entry.value || entry.value.length > 16_384 || entry.value.includes("\0") || !["session", "project", "global"].includes(entry.scope) || typeof entry.owner !== "string" || typeof entry.updatedAt !== "number")) throw new Error("[ENV]: invalid vault contents")
        entries = parsed
      }
    }
    return entries!
  }
  function save(next: EnvironmentEntry[]) {
    atomicPrivateWrite(file, sealed.seal(Buffer.from(JSON.stringify(next)), "environment"))
    entries = next
  }
  function applicable(sessionId: string, directory: string) {
    return load().filter((entry) => entry.scope === "global" || entry.owner === (entry.scope === "session" ? sessionId : directory))
  }
  function setMany(values: Record<string, string>, input: { scope: EnvironmentScope; sessionId: string; directory: string }) {
    for (const [name, value] of Object.entries(values)) {
      if (!ENVIRONMENT_NAME.test(name) || name.length > 128 || UNSAFE.test(name)) throw new Error("[ENV]: use credential names, not shell/runtime configuration variables")
      if (!value || value.length > 16_384 || value.includes("\0")) throw new Error("[ENV]: values must be 1–16384 characters without NUL")
    }
    const owner = input.scope === "global" ? "" : input.scope === "project" ? input.directory : input.sessionId
    const next = load().filter((entry) => !(Object.hasOwn(values, entry.name) && entry.scope === input.scope && entry.owner === owner))
    if (next.length + Object.keys(values).length > 1024) throw new Error("[ENV]: credential limit reached")
    save([...next, ...Object.entries(values).map(([name, value]) => ({ name, value, scope: input.scope, owner, updatedAt: now() }))])
  }
  return {
    setMany,
    list(sessionId: string, directory: string): EnvironmentInfo[] {
      return applicable(sessionId, directory).map(({ name, scope, updatedAt }) => ({ name, scope, updatedAt })).sort((a, b) => a.name.localeCompare(b.name))
    },
    values(sessionId: string, directory: string): Record<string, string> {
      const order = { global: 0, project: 1, session: 2 }
      return Object.fromEntries(applicable(sessionId, directory).sort((a, b) => order[a.scope] - order[b.scope]).map((entry) => [entry.name, entry.value]))
    },
    set(input: { name: string; value: string; scope: EnvironmentScope; sessionId: string; directory: string }) {
      setMany({ [input.name]: input.value }, input)
    },
    remove(name: string, scope: EnvironmentScope, sessionId: string, directory: string) {
      const owner = scope === "global" ? "" : scope === "project" ? directory : sessionId
      save(load().filter((entry) => !(entry.name === name && entry.scope === scope && entry.owner === owner)))
    },
    drop(sessionId: string) {
      const next = load().filter((entry) => entry.scope !== "session" || entry.owner !== sessionId)
      if (next.length !== load().length) save(next)
    },
  }
}
