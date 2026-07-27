import path from "path"
import { pathToFileURL } from "url"
import z from "zod"
import { Duration, Effect, Layer, Context, Schema, Stream } from "effect"
import { zod } from "@/util/effect-zod"
import { withStatics } from "@/util/schema"
import { NamedError } from "@mendcode/core/util/error"
import type { Agent } from "@/agent/agent"
import { Bus } from "@/bus"
import { BusEvent } from "@/bus/bus-event"
import { InstanceState } from "@/effect/instance-state"
import { FileWatcher } from "@/file/watcher"
import { Flag } from "@mendcode/core/flag/flag"
import { Global } from "@mendcode/core/global"
import { Permission } from "@/permission"
import { AppFileSystem } from "@mendcode/core/filesystem"
import { Config } from "@/config/config"
import { ConfigMarkdown } from "@/config/markdown"
import { Glob } from "@mendcode/core/util/glob"
import * as Log from "@mendcode/core/util/log"
import { Discovery } from "./discovery"

const log = Log.create({ service: "skill" })
const CLAUDE_EXTERNAL_DIR = ".claude"
const AGENTS_EXTERNAL_DIR = ".agents"
const MENDCODE_DIR = ".mendcode"
const OPENCODE_COMPAT_DIR = ".opencode"
const EXTERNAL_SKILL_PATTERN = "skills/**/SKILL.md"
const OPENCODE_SKILL_PATTERN = "{skill,skills}/**/SKILL.md"
const SKILL_PATTERN = "**/SKILL.md"
const HOT_RELOAD_DEBOUNCE = Duration.millis(100)
const SKILL_PARSE_RETRIES = 4
const SKILL_PARSE_RETRY_DELAY = Duration.millis(100)

const SkillSource = Schema.Literals(["mendcode", "compat-opencode", "agents", "claude", "config-path", "remote"])
const SkillScope = Schema.Literals(["project", "global", "configured", "remote"])
const SkillStatus = Schema.Literals(["active", "shadowed", "invalid"])

type SkillSource = Schema.Schema.Type<typeof SkillSource>
type SkillScope = Schema.Schema.Type<typeof SkillScope>
type SkillStatus = Schema.Schema.Type<typeof SkillStatus>

export const Info = Schema.Struct({
  name: Schema.String,
  description: Schema.String,
  location: Schema.String,
  content: Schema.String,
  source: Schema.optional(SkillSource),
  scope: Schema.optional(SkillScope),
  status: Schema.optional(SkillStatus),
  updatedAt: Schema.optional(Schema.Number),
}).pipe(withStatics((s) => ({ zod: zod(s) })))
export type Info = Schema.Schema.Type<typeof Info>

export const Event = {
  Updated: BusEvent.define(
    "skill.updated",
    Schema.Struct({
      added: Schema.Array(Schema.String),
      changed: Schema.Array(Schema.String),
      removed: Schema.Array(Schema.String),
      shadowed: Schema.Array(Schema.String),
      invalid: Schema.Array(Schema.String),
      count: Schema.Number,
    }),
  ),
}

export const InvalidError = NamedError.create(
  "SkillInvalidError",
  z.object({
    path: z.string(),
    message: z.string().optional(),
    issues: z.custom<z.core.$ZodIssue[]>().optional(),
  }),
)

export const NameMismatchError = NamedError.create(
  "SkillNameMismatchError",
  z.object({
    path: z.string(),
    expected: z.string(),
    actual: z.string(),
  }),
)

type State = {
  skills: Record<string, Info>
  dirs: Set<string>
  remote: Info[]
}

type DiscoveredSkill = {
  path: string
  source: SkillSource
  scope: SkillScope
  remote: boolean
}

type DiscoveryState = {
  matches: DiscoveredSkill[]
  dirs: string[]
}

type ScanState = {
  matches: Map<string, DiscoveredSkill>
  dirs: Set<string>
}

export interface Interface {
  readonly get: (name: string) => Effect.Effect<Info | undefined>
  readonly all: () => Effect.Effect<Info[]>
  readonly dirs: () => Effect.Effect<string[]>
  readonly available: (agent?: Agent.Info) => Effect.Effect<Info[]>
}

function fingerprint(skill: Info) {
  return [skill.name, skill.description, skill.location, skill.content, skill.source, skill.scope, skill.status].join("\0")
}

function scopeForDotDir(dir: string, global: Global.Interface): SkillScope {
  return path.dirname(dir) === global.home ? "global" : "project"
}

function sourceForConfigDir(dir: string, global: Global.Interface): Pick<DiscoveredSkill, "source" | "scope" | "remote"> {
  const base = path.basename(dir)
  if (base === OPENCODE_COMPAT_DIR) return { source: "compat-opencode", scope: scopeForDotDir(dir, global), remote: false }
  if (base === MENDCODE_DIR) return { source: "mendcode", scope: scopeForDotDir(dir, global), remote: false }
  return { source: "mendcode", scope: "global", remote: false }
}

function configDirPriority(dir: string) {
  const base = path.basename(dir)
  if (base === OPENCODE_COMPAT_DIR) return 0
  if (base === MENDCODE_DIR) return 1
  return 2
}

function orderConfigDirs(dirs: Iterable<string>) {
  return Array.from(new Set(dirs)).toSorted((a, b) => {
    const depth = a.split(path.sep).length - b.split(path.sep).length
    if (depth !== 0) return depth
    const priority = configDirPriority(a) - configDirPriority(b)
    if (priority !== 0) return priority
    return a.localeCompare(b)
  })
}

function isSkillFile(file: string) {
  return path.basename(file) === "SKILL.md"
}

function isMissingFileError(error: unknown): error is { code: string } {
  return typeof error === "object" && error !== null && "code" in error && (error as { code: string }).code === "ENOENT"
}

function diffSkills(prev: Record<string, Info>, next: Record<string, Info>) {
  const added = Object.keys(next).filter((name) => !prev[name]).toSorted()
  const removed = Object.keys(prev).filter((name) => !next[name]).toSorted()
  const changed = Object.keys(next)
    .filter((name) => prev[name] && fingerprint(prev[name]) !== fingerprint(next[name]))
    .toSorted()
  return { added, changed, removed }
}

const publishInvalid = Effect.fnUntraced(function* (bus: Bus.Interface, match: DiscoveredSkill, message: string, cause?: unknown) {
  if (match.source === "claude" || match.source === "agents") {
    log.warn("skipping invalid external skill", { skill: match.path, source: match.source, scope: match.scope, cause })
    return
  }

  const { Session } = yield* Effect.promise(() => import("@/session/session"))
  yield* bus.publish(Session.Event.Error, { error: new NamedError.Unknown({ message }).toObject() })
  log.error("failed to load skill", { skill: match.path, source: match.source, scope: match.scope, cause })
})

const parseSkill = Effect.fnUntraced(function* (match: DiscoveredSkill, bus: Bus.Interface) {
  let parseError: unknown
  let invalidFrontmatter: unknown

  for (let attempt = 0; attempt <= SKILL_PARSE_RETRIES; attempt++) {
    const result = yield* Effect.tryPromise({
      try: () => ConfigMarkdown.parse(match.path),
      catch: (error) => error,
    }).pipe(
      Effect.map((md) => ({ ok: true as const, md })),
      Effect.catch((error) => Effect.succeed({ ok: false as const, error })),
    )

    if (result.ok) {
      parseError = undefined
      const parsed = z.object({ name: z.string().min(1), description: z.string().min(1) }).safeParse(result.md.data)
      if (parsed.success) {
        return {
          skill: {
            name: parsed.data.name,
            description: parsed.data.description,
            location: match.path,
            content: result.md.content,
            source: match.source,
            scope: match.scope,
            status: "active" as const,
            updatedAt: Date.now(),
          },
        }
      }
      invalidFrontmatter = parsed.error
    } else {
      if (isMissingFileError(result.error)) return { invalid: match.path }
      invalidFrontmatter = undefined
      parseError = result.error
    }

    if (attempt < SKILL_PARSE_RETRIES) yield* Effect.sleep(SKILL_PARSE_RETRY_DELAY)
  }

  if (invalidFrontmatter) {
    yield* publishInvalid(
      bus,
      match,
      `Skill ${match.path} must include non-empty frontmatter fields: name and description.`,
      invalidFrontmatter,
    )
  } else {
    const message = ConfigMarkdown.FrontmatterError.isInstance(parseError)
      ? parseError.data.message
      : `Failed to parse skill ${match.path}`
    yield* publishInvalid(bus, match, message, parseError)
  }
  return { invalid: match.path }
})

const scan = Effect.fnUntraced(function* (
  state: ScanState,
  root: string,
  pattern: string,
  meta: Pick<DiscoveredSkill, "source" | "scope" | "remote">,
  opts?: { dot?: boolean; scope?: string },
) {
  const matches = yield* Effect.tryPromise({
    try: () =>
      Glob.scan(pattern, {
        cwd: root,
        absolute: true,
        include: "file",
        symlink: true,
        dot: opts?.dot,
      }),
    catch: (error) => error,
  }).pipe(
    Effect.catch((error) => {
      if (!opts?.scope) return Effect.die(error)
      log.error(`failed to scan ${opts.scope} skills`, { dir: root, error })
      return Effect.succeed([] as string[])
    }),
  )

  for (const match of matches) {
    state.matches.set(match, { path: match, ...meta })
    state.dirs.add(path.dirname(match))
  }
})

const discoverSkills = Effect.fnUntraced(function* (
  config: Config.Interface,
  discovery: Discovery.Interface,
  fsys: AppFileSystem.Interface,
  global: Global.Interface,
  directory: string,
  worktree: string,
  opts?: { includeRemote?: boolean },
) {
  const state: ScanState = { matches: new Map(), dirs: new Set() }

  if (!Flag.OPENCODE_DISABLE_EXTERNAL_SKILLS) {
    if (!Flag.OPENCODE_DISABLE_CLAUDE_CODE_SKILLS) {
      const root = path.join(global.home, CLAUDE_EXTERNAL_DIR)
      if (yield* fsys.isDir(root)) {
        yield* scan(state, root, EXTERNAL_SKILL_PATTERN, { source: "claude", scope: "global", remote: false }, { dot: true, scope: "global" })
      }
    }

    const agentRoot = path.join(global.home, AGENTS_EXTERNAL_DIR)
    if (yield* fsys.isDir(agentRoot)) {
      yield* scan(state, agentRoot, EXTERNAL_SKILL_PATTERN, { source: "agents", scope: "global", remote: false }, { dot: true, scope: "global" })
    }

    const upDirs = yield* fsys
      .up({ targets: [CLAUDE_EXTERNAL_DIR, AGENTS_EXTERNAL_DIR], start: directory, stop: worktree })
      .pipe(Effect.catch(() => Effect.succeed([] as string[])))

    for (const root of upDirs) {
      const source: SkillSource = path.basename(root) === CLAUDE_EXTERNAL_DIR ? "claude" : "agents"
      yield* scan(state, root, EXTERNAL_SKILL_PATTERN, { source, scope: "project", remote: false }, { dot: true, scope: "project" })
    }
  }

  const projectConfigDirs = !Flag.OPENCODE_DISABLE_PROJECT_CONFIG
    ? orderConfigDirs(
        yield* fsys
          .up({ targets: [OPENCODE_COMPAT_DIR, MENDCODE_DIR], start: directory, stop: worktree })
          .pipe(Effect.catch(() => Effect.succeed([] as string[]))),
      )
    : []
  const homeConfigDirs = orderConfigDirs(
    yield* fsys
      .up({ targets: [OPENCODE_COMPAT_DIR, MENDCODE_DIR], start: global.home, stop: global.home })
      .pipe(Effect.catch(() => Effect.succeed([] as string[]))),
  )
  const configDirs = Array.from(new Set([global.config, ...homeConfigDirs, ...projectConfigDirs, ...(yield* config.directories())]))
  for (const dir of configDirs) {
    yield* scan(state, dir, OPENCODE_SKILL_PATTERN, sourceForConfigDir(dir, global))
  }

  const cfg = yield* config.get()
  for (const item of cfg.skills?.paths ?? []) {
    const expanded = item.startsWith("~/") ? path.join(global.home, item.slice(2)) : item
    const dir = path.isAbsolute(expanded) ? expanded : path.join(directory, expanded)
    if (!(yield* fsys.isDir(dir))) {
      log.warn("skill path not found", { path: dir })
      continue
    }

    yield* scan(state, dir, SKILL_PATTERN, { source: "config-path", scope: "configured", remote: false })
  }

  if (opts?.includeRemote !== false) {
    for (const url of cfg.skills?.urls ?? []) {
      const pulledDirs = yield* discovery.pull(url)
      for (const dir of pulledDirs) {
        yield* scan(state, dir, SKILL_PATTERN, { source: "remote", scope: "remote", remote: true })
      }
    }
  }

  return {
    matches: Array.from(state.matches.values()),
    dirs: Array.from(state.dirs),
  }
})

const collectSkills = Effect.fnUntraced(function* (discovered: DiscoveryState, bus: Bus.Interface) {
  const parsed = yield* Effect.forEach(discovered.matches, (match) => parseSkill(match, bus), {
    concurrency: "unbounded",
  })

  return {
    skills: parsed.flatMap((item) => ("skill" in item && item.skill ? [item.skill] : [])),
    invalid: parsed.flatMap((item) => ("invalid" in item && item.invalid ? [item.invalid] : [])),
  }
})

const applySkills = Effect.fnUntraced(function* (
  state: State,
  skills: Info[],
  invalid: string[],
  bus: Bus.Interface,
  opts?: { publish?: boolean },
) {
  const next: Record<string, Info> = {}
  const dirs = new Set<string>()
  const shadowed = new Set<string>()

  for (const skill of skills) {
    const previous = next[skill.name]
    if (previous) {
      shadowed.add(skill.name)
      log.warn("duplicate skill name", {
        name: skill.name,
        existing: previous.location,
        duplicate: skill.location,
        winner: skill.location,
      })
    }

    dirs.add(path.dirname(skill.location))
    next[skill.name] = {
      ...skill,
      status: "active",
      updatedAt: previous && fingerprint(previous) === fingerprint(skill) ? previous.updatedAt : skill.updatedAt,
    }
  }

  const final = Object.fromEntries(
    Object.values(next).map((skill) => {
      const previous = state.skills[skill.name]
      return [
        skill.name,
        {
          ...skill,
          updatedAt: previous && fingerprint(previous) === fingerprint(skill) ? previous.updatedAt : skill.updatedAt,
        },
      ] as const
    }),
  )

  const diff = diffSkills(state.skills, final)
  state.skills = final
  state.dirs = dirs

  if (!opts?.publish) return
  if (!diff.added.length && !diff.changed.length && !diff.removed.length && !shadowed.size && !invalid.length) return

  yield* bus.publish(Event.Updated, {
    ...diff,
    shadowed: Array.from(shadowed).toSorted(),
    invalid: invalid.toSorted(),
    count: Object.keys(state.skills).length,
  })
})

const loadSkills = Effect.fnUntraced(function* (state: State, discovered: DiscoveryState, bus: Bus.Interface) {
  const collected = yield* collectSkills(discovered, bus)
  state.remote = collected.skills.filter((skill) => skill.source === "remote")
  yield* applySkills(state, collected.skills, collected.invalid, bus)
  log.info("init", { count: Object.keys(state.skills).length })
})

export class Service extends Context.Service<Service, Interface>()("@opencode/Skill") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const discovery = yield* Discovery.Service
    const config = yield* Config.Service
    const bus = yield* Bus.Service
    const fsys = yield* AppFileSystem.Service
    const global = yield* Global.Service
    const discovered = yield* InstanceState.make(
      Effect.fn("Skill.discovery")(function* (ctx) {
        return yield* discoverSkills(config, discovery, fsys, global, ctx.directory, ctx.worktree)
      }),
    )
    const state = yield* InstanceState.make(
      Effect.fn("Skill.state")(function* (ctx) {
        const s: State = { skills: {}, dirs: new Set(), remote: [] }
        yield* loadSkills(s, yield* InstanceState.get(discovered), bus)

        const refreshLocal = Effect.fn("Skill.refreshLocal")(function* () {
          const next = yield* discoverSkills(config, discovery, fsys, global, ctx.directory, ctx.worktree, {
            includeRemote: false,
          })
          const collected = yield* collectSkills(next, bus)
          yield* applySkills(s, [...collected.skills, ...s.remote], collected.invalid, bus, { publish: true })
        })

        yield* bus.subscribe(FileWatcher.Event.Updated).pipe(
          Stream.filter((evt) => isSkillFile(evt.properties.file)),
          Stream.debounce(HOT_RELOAD_DEBOUNCE),
          Stream.runForEach(() => refreshLocal()),
          Effect.forkScoped,
        )

        return s
      }),
    )

    const get = Effect.fn("Skill.get")(function* (name: string) {
      const s = yield* InstanceState.get(state)
      return s.skills[name]
    })

    const all = Effect.fn("Skill.all")(function* () {
      const s = yield* InstanceState.get(state)
      return Object.values(s.skills)
    })

    const dirs = Effect.fn("Skill.dirs")(function* () {
      const s = yield* InstanceState.get(state)
      return Array.from(s.dirs)
    })

    const available = Effect.fn("Skill.available")(function* (agent?: Agent.Info) {
      const s = yield* InstanceState.get(state)
      const list = Object.values(s.skills).toSorted((a, b) => a.name.localeCompare(b.name))
      if (!agent) return list
      return list.filter((skill) => Permission.evaluate("skill", skill.name, agent.permission).action !== "deny")
    })

    return Service.of({ get, all, dirs, available })
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provide(Discovery.defaultLayer),
  Layer.provide(Config.defaultLayer),
  Layer.provide(Bus.layer),
  Layer.provide(AppFileSystem.defaultLayer),
  Layer.provide(Global.layer),
)

export function fmt(list: Info[], opts: { verbose: boolean }) {
  if (list.length === 0) return "No skills are currently available."
  if (opts.verbose) {
    return [
      "<available_skills>",
      ...list
        .sort((a, b) => a.name.localeCompare(b.name))
        .flatMap((skill) => [
          "  <skill>",
          `    <name>${skill.name}</name>`,
          `    <description>${skill.description}</description>`,
          `    <location>${pathToFileURL(skill.location).href}</location>`,
          skill.source ? `    <source>${skill.source}</source>` : undefined,
          skill.scope ? `    <scope>${skill.scope}</scope>` : undefined,
          "  </skill>",
        ].filter((line): line is string => line !== undefined)),
      "</available_skills>",
    ].join("\n")
  }

  return [
    "## Available Skills",
    ...list
      .toSorted((a, b) => a.name.localeCompare(b.name))
      .map((skill) => `- **${skill.name}**: ${skill.description}`),
  ].join("\n")
}

export * as Skill from "."
