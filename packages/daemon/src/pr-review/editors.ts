import type { ReviewProvider } from "./contracts"
import type { EditResult, PrEditor, PrEdit, PrSnapshot } from "./describe"
import { listAll, resolveFixedThreads, resolveFixedThroughProvider, type GhCall } from "./publish"

/**
 * The forge side of `@mendcode describe | resolve | approve`: GitHub through the user's own `gh`, GitLab and Gitea through their
 * adapter. A forge that cannot do one of them leaves that method out (`PrEditor`), and the command says so.
 */

const json = (text: string): unknown => { try { return JSON.parse(text) } catch { return undefined } }
const text = (value: unknown, limit: number) => typeof value === "string" ? value.slice(0, limit) : ""
const failed = (done: { code: number; out: string; err?: string }): EditResult => ({ ok: false, reason: `${done.err ?? ""}\n${done.out}`.split("\n").find((line) => line.trim())?.trim().slice(0, 200) ?? `gh exited with ${done.code}` })

export function githubEditor({ gh, repo, number }: { gh: GhCall; repo: string; number: number }): PrEditor {
  const send = (endpoint: string, method: string, body: unknown) => gh({ argv: ["api", endpoint, "--method", method, "--input", "-"], stdin: JSON.stringify(body) }).catch((error: unknown) => ({ code: -1, out: "", err: String(error) }))
  return {
    name: "GitHub",
    async read(): Promise<PrSnapshot | undefined> {
      const done = await gh({ argv: ["api", `repos/${repo}/pulls/${number}`] }).catch(() => undefined)
      if (!done || done.code !== 0) return undefined
      const pr = json(done.out) as { title?: unknown; body?: unknown; labels?: Array<{ name?: unknown }>; head?: { sha?: unknown } } | undefined
      if (!pr || typeof pr.title !== "string") return undefined
      const head = text(pr.head?.sha, 64)
      return { title: pr.title, body: text(pr.body, 100_000), labels: (pr.labels ?? []).flatMap((label) => typeof label.name === "string" ? [label.name] : []), ...(head ? { head } : {}) }
    },
    async repoLabels() {
      const labels = await listAll(gh, `repos/${repo}/labels`, 10)
      return labels?.flatMap((label) => typeof (label as { name?: unknown }).name === "string" ? [(label as { name: string }).name] : [])
    },
    async edit({ title, body, labels }: PrEdit) {
      if (title !== undefined || body !== undefined) {
        const done = await send(`repos/${repo}/pulls/${number}`, "PATCH", { ...(title !== undefined ? { title } : {}), ...(body !== undefined ? { body } : {}) })
        if (done.code !== 0) return failed(done)
      }
      if (labels?.length) {
        const done = await send(`repos/${repo}/issues/${number}/labels`, "POST", { labels })
        if (done.code !== 0) return failed(done)
      }
      return { ok: true }
    },
    async approve({ head, body }) {
      const done = await send(`repos/${repo}/pulls/${number}/reviews`, "POST", { commit_id: head, event: "APPROVE", body })
      return done.code === 0 ? { ok: true } : failed(done)
    },
    resolveFixed: ({ state }) => resolveFixedThreads({ gh, repo, number, state }),
  }
}

export function providerEditor({ provider, repo, number }: { provider: ReviewProvider; repo: string; number: number }): PrEditor {
  const name = provider.kind === "gitlab" ? "GitLab" : provider.kind === "gitea" ? "Gitea" : "GitHub"
  const { edit, approve, repoLabels } = provider
  return {
    name,
    async read() {
      const facts = await provider.view({ directory: "", repo, number }).catch(() => undefined)
      return facts ? { title: facts.title ?? "", body: facts.body ?? "", labels: facts.labels, ...(facts.head ? { head: facts.head } : {}) } : undefined
    },
    ...(repoLabels ? { repoLabels: () => repoLabels.call(provider, { repo }) } : {}),
    ...(edit ? { edit: (input: PrEdit) => edit.call(provider, { repo, number, ...input }) } : {}),
    ...(approve ? { approve: (input: { head: string; body: string }) => approve.call(provider, { repo, number, ...input }) } : {}),
    ...(provider.capabilities.resolveThreads && provider.threads && provider.resolve ? { resolveFixed: ({ state }: { state: import("./state").ReviewState }) => resolveFixedThroughProvider({ provider, repo, number, state }) } : {}),
  }
}
