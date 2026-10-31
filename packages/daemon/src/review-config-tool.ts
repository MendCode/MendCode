import { z } from "zod"
import { defineTool, fail } from "@mendcode/tools"
import type { ConfigControl, ConfigControlAction } from "./pr-review/config-control"
import { NO_SELF_MENTION } from "./pr-review-tool"

/**
 * `review_config`: the conversational side of the PR reviewer's configuration (docs/pr-review.md). The model reads, previews,
 * applies, reverts and lists versions of either the repository's reviewer (`global`: `.mendcode/review.yaml` in the working tree,
 * never committed by this tool) or the user's own (`personal`: their profile under the data directory). Every call goes through
 * config-control, which refuses a call without `scope` and names both targets and what exists, so "change my review" can never
 * edit the repository's file. Writes (apply, revert) ask the user every time with the exact before/after as the approval text.
 * `setup` (pr-review/setup.ts) is the read-only start of a guided setup with the developer: what exists, their role's signals,
 * what is missing and the questions to ask; it needs no scope and changes nothing.
 */

const ACTIONS = { show: "config-show", preview: "config-preview", apply: "config-apply", revert: "config-revert", history: "config-history" } as const satisfies Record<string, ConfigControlAction>

/** The guided setup's report for a checkout (pr-review/setup.ts), loaded on its first call. */
export type ReviewSetupPort = { run(directory: string): Promise<{ text: string }> }

export { NO_SELF_MENTION }

export const ReviewConfigToolArgs = z.strictObject({
  action: z.enum(["setup", "show", "preview", "apply", "revert", "history"]),
  scope: z.enum(["global", "personal"]).optional().describe("Required for every action but setup: global = the repository's reviewer (.mendcode/review.yaml), personal = the user's own reviewer for this repository. Leave it out only to ask what exists."),
  patch: z.record(z.string().min(1).max(64), z.unknown()).optional().describe("preview, apply: top-level keys of .mendcode/review.yaml; each replaces the whole key, null removes it"),
  version: z.number().int().nonnegative().optional().describe("revert: the version to go back to (from history)"),
  summary: z.string().trim().min(1).max(200).optional().describe("apply: one line for the history"),
})
type Args = z.infer<typeof ReviewConfigToolArgs>

const writes = (args: Args) => args.action === "apply" || args.action === "revert"

/** The approval text: the target, the before/after and the problems, bounded like any tool preview. */
const approvalText = (result: Awaited<ReturnType<ConfigControl["run"]>>) => {
  const config = result.config
  if (!config) return result.text.slice(0, 4000)
  return [
    `${config.scope === "global" ? "Repository's reviewer" : "Your own reviewer"}: ${config.target}`,
    "--- before", (config.before ?? "").slice(0, 6000) || "(empty)",
    "+++ after", (config.after ?? "").slice(0, 6000) || "(empty)",
    ...(config.problems ?? []).map((problem) => `Problem: ${problem}`),
  ].join("\n")
}

/** `enabled`: `experimental.pr_review` is on (checked on every call, so turning it off stops the tool at once). */
export function createReviewConfigTool({ control, enabled, setup }: { control: ConfigControl; enabled(): boolean; setup?: ReviewSetupPort | undefined }) {
  return defineTool({
    name: "review_config",
    tier: "balanced",
    description: [
      "Configure MendCode's pull request reviewer for this repository.",
      "When the user asks to set up or configure PR review, to review all PRs from now on, or to watch this repository, it is a sit-down setup with them: call setup first (read only, no scope). It reports the forge, their login and permission, the repository's config on the base branch, watches, claims, their personal profile, the hosted workflow, the signals of their role (permission, CODEOWNERS, reviewers.yaml, PR activity, saved memory), what is missing and the questions to ask: role, global or individual reviewer, topology, posting consent, language, fixes, budget. Confirm the inferred role with the user instead of assuming it; ask when nothing is known. Apply each answer through preview and apply.",
      NO_SELF_MENTION,
      "Two different targets, never confused: scope global is the repository's reviewer (.mendcode/review.yaml, shared with everyone; apply writes the working-tree file only and never commits), scope personal is the user's own reviewer for this repository (a versioned profile on this machine that may only narrow the repository's settings: profile, cap, template, phases, coverage, extra path instructions or ignores, a lower budget, a fix mode up to the repository's).",
      "If the user did not say which (\"my review\" is personal, \"the repo's\"/\"global\"/\"team\" is global), call show without scope: it changes nothing and lists both targets and what exists; then ask the user. Never change global when they asked for their own.",
      "show: effective settings with the origin of each key (preset, repository, personal). preview: the before/after and problems of a patch, nothing written. apply: writes it (the user approves each time). history: versions; revert: back to one, as a new version.",
      "Keys: preset (balanced|quiet|strict|on-request|autofix), enabled, profile, cap, paths, ignore, checks, mode, filters, coverage, fix, phases, template (language: a name or auto), budget, triggers, cooldown, reviewers, publishers, backlog (docs: mendcode docs --search pr review).",
    ].join(" "),
    permission: "write",
    permissionFor: (args) => (writes(args) ? "write" : "read"),
    approvalFor: writes,
    args: ReviewConfigToolArgs,
    async preview(args, context) {
      if (!writes(args) || !args.scope || !enabled()) return undefined
      const dry = args.action === "apply"
        ? await control.run({ action: "config-preview", scope: args.scope, directory: context.cwd, patch: args.patch, summary: args.summary }).catch(() => undefined)
        : await control.run({ action: "config-revert", scope: args.scope, directory: context.cwd, version: args.version, dryRun: true }).catch(() => undefined)
      return dry ? approvalText(dry) : undefined
    },
    async execute(args, context) {
      const title = `review_config ${args.action}${args.scope ? ` ${args.scope}` : ""}`
      if (!enabled()) return fail({ title, message: "The PR reviewer is off: the user turns it on with /pr on (experimental.pr_review)." })
      if (args.action === "setup") {
        if (!setup) return fail({ title, message: "The guided setup is not available in this session; use show without scope to list both targets." })
        const report = await setup.run(context.cwd)
        return { output: report.text, truncated: false, title, isError: false }
      }
      if (!args.scope && args.action !== "show") {
        const listed = await control.run({ action: "config-show", directory: context.cwd })
        return fail({ title, message: `${args.action} needs scope global or personal; nothing was changed.\n${listed.text}` })
      }
      const result = await control.run({ action: ACTIONS[args.action as keyof typeof ACTIONS], scope: args.scope, directory: context.cwd, patch: args.patch, version: args.version, summary: args.summary })
      if (!result.ok && args.scope) return fail({ title, message: result.text })
      return { output: result.text, truncated: false, title, isError: false }
    },
  })
}
