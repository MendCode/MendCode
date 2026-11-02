import { createHash } from "node:crypto"
import type { Settings } from "@mendcode/protocol"
import { effectiveSettings, featureOn } from "@mendcode/protocol/wire"
import { CONFIG_PATH, parseReviewConfig } from "./config"
import { gitRun, type GitRun } from "./context"
import { ghProcess } from "../pr-watch"
import { checkoutForge, detectProvider } from "./providers"
import { watchesOf } from "./setup"

export type QuickSetupReport = {
  directory: string
  repo?: string | undefined
  role: "all" | "requested"
  changes: string[]
  skipped: string[]
  problems: string[]
  publicRepo?: string | undefined
  digest: string
  text: string
  enable: boolean
  watch: boolean
  publish: boolean
}

/** A small, read-only preflight. No activity, memories, claims, model calls or git fetch. */
export async function previewQuickSetup(input: {
  directory: string; dataDir: string; settings: Settings; safeMode?: boolean | undefined
  role?: "all" | "requested" | undefined; git?: GitRun | undefined
  gh?: ((argv: string[], cwd: string) => Promise<{ code: number; out: string }>) | undefined
}): Promise<QuickSetupReport> {
  const git = input.git ?? gitRun
  const gh = input.gh ?? ((argv, cwd) => ghProcess({ argv, cwd }))
  const directory = input.directory
  const settings = effectiveSettings(input.settings, { safeMode: input.safeMode })
  const problems: string[] = []
  const changes: string[] = []
  const skipped: string[] = []
  const allowed = featureOn(input.settings, "pr_review", { safeMode: input.safeMode })
  if (!allowed) problems.push("PR review requires balanced tier or above and permission for pr_review. Use /tier balanced, or restore the feature override; safe mode must be off.")
  // The local remote/base reads and authentication are independent. Never fall back to a feature branch's HEAD.
  const [forge, auth, base, publicUrl] = await Promise.all([
    checkoutForge({ directory, git }),
    gh(["auth", "status"], directory).catch(() => ({ code: 1, out: "" })),
    (async () => {
      const head = await git(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], directory)
      const ref = head.code === 0 ? head.out.trim() : ""
      return { ref, read: ref ? await git(["show", `${ref}:${CONFIG_PATH}`], directory) : { code: 1, out: "" } }
    })(),
    git(["config", "--get", "remote.public.url"], directory),
  ])
  let ref = base.ref
  let read = base.read
  if (!forge.kind) problems.push("Origin is not a supported forge. Open a repository clone with a GitHub, GitLab or Gitea origin; configure mendcode.forge for a self-hosted forge.")
  // This quick path uses gh; the existing forge-specific commands remain available.
  else if (forge.kind !== "github") problems.push("Quick setup currently checks GitHub. For this forge use /pr on, /pr watch-repo and /pr publish on after its login is configured.")
  if (forge.kind === "github" && auth.code !== 0) problems.push("gh is missing or logged out. Install gh separately if needed, then run gh auth login on the daemon's machine.")
  if (!ref && forge.kind === "github" && forge.repo && auth.code === 0) {
    const branch = await gh(["api", `repos/${forge.repo}`, "--jq", ".default_branch"], directory)
    if (branch.code === 0 && /^[A-Za-z0-9][A-Za-z0-9/_.-]*$/.test(branch.out.trim())) {
      ref = `refs/remotes/origin/${branch.out.trim()}`
      read = await git(["show", `${ref}:${CONFIG_PATH}`], directory)
    }
  }
  const parsed = parseReviewConfig(read.code === 0 ? read.out : undefined, forge.kind)
  if (!ref) problems.push("The origin base branch is unknown. Fetch origin and run git remote set-head origin -a, then retry.")
  if (read.code !== 0) problems.push(`No ${CONFIG_PATH} readable on the origin base branch. Commit it there with enabled: true, fetch origin, then retry.`)
  else if (parsed.problem) problems.push(`Fix ${CONFIG_PATH} on the base branch: ${parsed.problem}`)
  else if (!parsed.config.enabled) problems.push(`${CONFIG_PATH} on the base branch must say enabled: true. Commit that change there and fetch origin.`)
  const role = input.role ?? (parsed.config.reviewers === "all" ? "all" : "requested")
  const repo = forge.kind ? forge.repo : undefined
  const watches = watchesOf(input.dataDir, directory, repo).filter((watch) => watch.directory === directory)
  const active = watches.find((watch) => watch.state === "active" && (watch.role ?? parsed.config.reviewers) === role)
  ;(settings.experimental?.pr_review === true ? skipped : changes).push(settings.experimental?.pr_review === true ? "PR reviewer already on" : "Enable experimental.pr_review (network and model calls)")
  ;(active ? skipped : changes).push(active ? `Repository already watched (${role})` : `Start repository watch (${role}); eligible open PRs may spend model calls`)
  const published = watches.some((watch) => watch.publish === "posting allowed")
  ;(published ? skipped : changes).push(published ? "Publishing already allowed" : "Allow publishing reviews and held reviews to GitHub using your gh login")
  let publicRepo: string | undefined
  if (publicUrl.code === 0 && (read.code !== 0 || !parsed.config.enabled)) {
    const remote = detectProvider(publicUrl.out.trim())
    if (remote.kind === "github" && remote.repo && remote.repo !== repo && auth.code === 0) {
      const config = await gh(["api", `repos/${remote.repo}/contents/${CONFIG_PATH}`, "-H", "Accept: application/vnd.github.raw+json"], directory)
      if (config.code === 0 && parseReviewConfig(config.out, "github").config.enabled) {
        publicRepo = remote.repo
        problems.push(`The public remote (${publicRepo}) has review enabled instead. To use it, open a clone of that repository and run /pr setup there. No remote has been changed.`)
      }
    }
  }
  const facts = { directory, repo, role, changes, skipped, problems, publicRepo, enable: settings.experimental?.pr_review !== true, watch: !active, publish: !published }
  // Authentication output stays private; its fingerprint prevents accepting under a changed gh account.
  const digest = createHash("sha256").update(JSON.stringify({ ...facts, ref, config: read.out, auth: auth.out })).digest("hex")
  const text = [`PR setup · ${repo ?? directory} · balanced tier`, `Review: ${role}`, ...problems.length ? ["", "Needs attention (nothing changed):", ...problems.map((line) => `- ${line}`)] : [], "", "Will change:", ...changes.length ? changes.map((line) => `- ${line}`) : ["Nothing."], "", "Already configured:", ...skipped.length ? skipped.map((line) => `- ${line}`) : ["Nothing yet."], "", "Repository files, remotes and model selection are not changed."].join("\n")
  return { ...facts, digest, text }
}
