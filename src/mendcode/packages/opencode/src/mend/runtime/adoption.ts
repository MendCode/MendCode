import { cpSync, existsSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from "fs"
import { mkdir, writeFile } from "fs/promises"
import path from "path"
import { mendPaths } from "../config/paths"
import { ownedRuntimeStatus } from "./system"

function readJsonSync<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T
  } catch {
    return fallback
  }
}

async function writeJson(file: string, data: unknown) {
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, `${JSON.stringify(data, null, 2)}\n`)
}

function engineRoot(root: string) {
  return path.join(root, ".agents", "vendor", "opencode")
}

function ownedRuntimeRoot(root: string) {
  return path.join(root, "src", "mendcode")
}

function upstreamState(root: string) {
  return readJsonSync<Record<string, any>>(path.join(root, ".mendcode", "upstream.json"), {
    runtimeCommit: "aa3c99a3c0a609ea4dd485355627e3161251584a",
    watchRemote: "https://mendcode.ai",
  })
}

function ownedRuntimeCopyRoots() {
  return [
    "packages/opencode",
    "packages/core",
    "packages/plugin",
    "packages/web",
    "packages/console",
    "packages/tui",
    "packages/vscode",
    "packages/function",
    "packages/sdk",
    "packages/ai",
    "packages/auth",
    "packages/platform",
    "packages/issue-providers",
    "packages/tunnel",
    "packages/discord",
    "packages/cloudflare",
    "script",
    "github",
    "patches",
    "infra",
    "nix",
    ".opencode",
    ".github",
    ".vscode",
    ".zed",
    ".husky",
  ]
}

function ownedRuntimeRootFiles() {
  return [
    "package.json",
    "bun.lock",
    "bunfig.toml",
    "tsconfig.json",
    "turbo.json",
    "LICENSE",
    "SECURITY.md",
    "CONTRIBUTING.md",
    "AGENTS.md",
    "README.md",
    "install",
    "flake.nix",
    "flake.lock",
    "sst.config.ts",
    "sst-env.d.ts",
    ".editorconfig",
    ".gitignore",
    ".oxlintrc.json",
    ".prettierignore",
  ]
}

function ignoredRuntimeCopyPath(source: string) {
  const base = path.basename(source)
  if ([".git", "node_modules", ".turbo", "dist", "build", "coverage", ".next", ".sst"].includes(base)) return true
  if (source.includes(`${path.sep}node_modules${path.sep}`)) return true
  if (source.includes(`${path.sep}.git${path.sep}`)) return true
  if (source.includes(`${path.sep}dist${path.sep}`) || source.includes(`${path.sep}build${path.sep}`)) return true
  return false
}

function neutralizeRuntimeGitignores(root: string, projectRoot: string) {
  const renamed: string[] = []
  if (!existsSync(root)) return renamed
  const visit = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const full = path.join(dir, entry)
      if (ignoredRuntimeCopyPath(full)) continue
      const stat = statSync(full)
      if (stat.isDirectory()) {
        visit(full)
        continue
      }
      if (entry !== ".gitignore") continue
      const target = path.join(dir, ".gitignore.upstream")
      if (existsSync(target)) rmSync(target, { force: true })
      renameSync(full, target)
      renamed.push(path.relative(projectRoot, target))
    }
  }
  visit(root)
  return renamed
}

export function ownedRuntimePlan(root = mendPaths().root) {
  const donor = engineRoot(root)
  const target = ownedRuntimeRoot(root)
  return {
    version: 0,
    generatedAt: new Date().toISOString(),
    status: "ready-to-adopt-owned-runtime-source",
    source: path.relative(root, donor),
    target: path.relative(root, target),
    donorCommit: upstreamState(root).runtimeCommit,
    copyRoots: ownedRuntimeCopyRoots(),
    rootFiles: ownedRuntimeRootFiles(),
    excludes: ["node_modules", ".git", ".turbo", "dist", "build", "coverage", ".next", ".sst"],
    license: {
      source: path.relative(root, path.join(donor, "LICENSE")),
      target: path.relative(root, path.join(target, "LICENSE")),
      required: true,
      note: "Donor MIT license must remain with adopted source.",
    },
    nextPatchSurface: {
      allowedAfterAdoption: [
        "src/mendcode/packages/opencode/src/cli/cmd/tui/**",
        "src/mendcode/packages/opencode/src/session/**",
        "src/mendcode/packages/plugin/src/tui.ts",
      ],
      stillBlocked: [".agents/vendor/opencode/** direct product runtime dependency", "copying proprietary prompt bodies", "public donor auth/updater identity leakage"],
    },
    command: "mend runtime adopt --execute",
  }
}

export async function adoptOwnedRuntime(args: string[] = [], root = mendPaths().root) {
  const execute = args.includes("--execute")
  const force = args.includes("--force")
  if (!execute) return ownedRuntimePlan(root)
  const donor = engineRoot(root)
  const target = ownedRuntimeRoot(root)
  if (!existsSync(donor)) throw new Error(`missing donor checkout: ${donor}`)
  if (!existsSync(path.join(donor, "LICENSE"))) throw new Error("refusing adoption without donor LICENSE")
  if (existsSync(target)) {
    if (!force) throw new Error(`owned runtime already exists: ${path.relative(root, target)}; use --force to replace`)
    rmSync(target, { recursive: true, force: true })
  }
  await mkdir(target, { recursive: true })
  for (const rel of ownedRuntimeRootFiles()) {
    const src = path.join(donor, rel)
    if (existsSync(src)) cpSync(src, path.join(target, rel), { recursive: true, filter: (source) => !ignoredRuntimeCopyPath(source) })
  }
  for (const rel of ownedRuntimeCopyRoots()) {
    const src = path.join(donor, rel)
    if (existsSync(src)) cpSync(src, path.join(target, rel), { recursive: true, filter: (source) => !ignoredRuntimeCopyPath(source) })
  }
  const neutralizedGitignores = neutralizeRuntimeGitignores(target, root)
  const state = {
    version: 0,
    copiedAt: new Date().toISOString(),
    donorCommit: upstreamState(root).runtimeCommit,
    donorSource: path.relative(root, donor),
    target: path.relative(root, target),
    mode: "owned-source-copy",
    excludes: ownedRuntimePlan(root).excludes,
    licensePreserved: existsSync(path.join(target, "LICENSE")),
    neutralizedGitignores,
    note: "MendCode now owns this source copy for rebrand/runtime patches. .agents/vendor/opencode remains reference only.",
  }
  await writeJson(path.join(root, ".mendcode", "runtime-adoption.json"), state)
  return { ...state, status: ownedRuntimeStatus(root) }
}
