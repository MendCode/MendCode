import { SessionLifecycle, redactSecrets, type SessionId, type SessionMetaInput } from "@mendcode/protocol"
import type { Store } from "@mendcode/store"
import type { GhRun } from "./pr-watch"

export function lifecycleOf(store: Store, id: SessionId): SessionLifecycle {
  let data: SessionLifecycle = {}
  try { data = SessionLifecycle.parse(JSON.parse(store.sessionData.get(id, "lifecycle") ?? "{}")) } catch {}
  const pinnedAt = store.sessionPinnedAt(id)
  return { ...data, ...(pinnedAt !== undefined ? { pinnedAt } : {}) }
}

/** Rules are opt-in, evaluated at list/check time; PR state is refreshed only by an explicit check. */
export function createSessionLifecycle(input: {
  store: Store
  now(): number
  busy(id: SessionId): boolean
  changed(id: SessionId): void
  settled(id: SessionId): void
  regenerate(id: SessionId): Promise<boolean>
  gh: GhRun
}) {
  const { store } = input
  const pending = new Set<SessionId>()
  const save = (id: SessionId, data: SessionLifecycle) => {
    const { pinnedAt: _pin, ...persisted } = data
    store.sessionData.set(id, "lifecycle", JSON.stringify(persisted))
    input.changed(id)
  }
  function settle(id: SessionId, reason: string) {
    if (input.busy(id)) throw new Error("Session has running or queued work")
    store.setSessionArchived(id, true)
    save(id, { ...lifecycleOf(store, id), settledReason: redactSecrets(reason).text.slice(0, 400) })
    input.settled(id)
  }
  function evaluate(id: SessionId) {
    const info = store.sessionInfo(id)
    const data = lifecycleOf(store, id)
    const rules = data.rules
    const requested = store.meta.get(`session.settle.pending:${id}`)
    if (info && requested && !input.busy(id)) {
      store.meta.set(`session.settle.pending:${id}`, "")
      return settle(id, requested)
    }
    if (!info || info.archivedAt !== null || !rules || rules.disabled || data.pinnedAt !== undefined || input.busy(id)) return
    if (rules.prClosed && data.pr && data.pr.state !== "OPEN") settle(id, `PR #${data.pr.number} ${data.pr.state.toLowerCase()}`)
    else if (rules.inactiveDays && input.now() - (info.updatedAt || store.sessionSummary(id)!.createdAt) >= rules.inactiveDays * 86_400_000) settle(id, `Inactive ${rules.inactiveDays} days`)
  }
  async function run(id: SessionId, request: SessionMetaInput) {
    const info = store.sessionInfo(id)
    if (!info) throw new Error("Unknown session")
    if (pending.has(id)) throw new Error("Metadata operation already running")
    pending.add(id)
    try {
      let data = lifecycleOf(store, id)
      switch (request.action) {
        case "rename": {
          const title = redactSecrets(request.title ?? "").text.trim()
          if (!title) throw new Error("rename needs title")
          store.renameSession(id, title)
          store.meta.set(`session.title.manual:${id}`, "true")
          input.changed(id)
          break
        }
        case "regenerate_title":
          if (!await input.regenerate(id)) throw new Error("Title generation unavailable, cancelled or superseded")
          break
        case "link_pr":
        case "check": {
          const ref = request.pr ?? (request.action === "check" ? data.pr?.url : undefined)
          if (ref && !/^(?:[1-9]\d*|https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/[1-9]\d*)$/.test(ref)) throw new Error("Use a PR number or github.com pull request URL")
          if (request.action === "link_pr" || data.pr) {
            const result = await input.gh({ cwd: info.directory, argv: ["pr", "view", ...(ref ? [ref] : []), "--json", "number,url,title,state,headRefName"] })
            if (result.code !== 0) throw new Error("Could not read PR through gh")
            let raw: Record<string, unknown>
            try { raw = JSON.parse(result.out) } catch { throw new Error("Invalid gh PR response") }
            const parsed = SessionLifecycle.safeParse({ ...data, pr: { number: raw.number, url: raw.url, title: typeof raw.title === "string" ? redactSecrets(raw.title).text.slice(0, 200) : "", state: raw.state, branch: raw.headRefName, checkedAt: input.now() } })
            if (!parsed.success || !/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/[1-9]\d*$/.test(parsed.data.pr!.url)) throw new Error("Invalid gh PR response")
            // A deleted session must not be recreated by a late response.
            if (!store.hasSession(id)) throw new Error("Session was removed")
            data = parsed.data
            save(id, data)
          }
          if (request.action === "check") evaluate(id)
          break
        }
        case "unlink_pr": { delete data.pr; save(id, data); break }
        case "pin": {
          store.setSessionPinned(id, request.pinned ?? true)
          input.changed(id)
          break
        }
        case "rules": {
          const rules = { ...data.rules, ...(request.prClosed !== undefined ? { prClosed: request.prClosed } : {}), ...(request.disabled !== undefined ? { disabled: request.disabled } : {}) }
          if (request.inactiveDays === null) delete rules.inactiveDays
          else if (request.inactiveDays !== undefined) rules.inactiveDays = request.inactiveDays
          save(id, { ...data, rules })
          break
        }
        case "settle": settle(id, request.reason ?? "Settled by user"); break
        case "restore": {
          store.meta.set(`session.settle.pending:${id}`, "")
          store.setSessionArchived(id, false)
          delete data.settledReason
          // Undo must survive the next listing instead of immediately settling again.
          save(id, { ...data, ...(data.rules ? { rules: { ...data.rules, disabled: true } } : {}) })
          break
        }
      }
      return { sessionId: id, title: store.sessionInfo(id)?.title, lifecycle: lifecycleOf(store, id) }
    } finally { pending.delete(id) }
  }
  function requestSettle(id: SessionId, reason = "Settled by agent") {
    if (!store.hasSession(id)) throw new Error("Unknown session")
    store.meta.set(`session.settle.pending:${id}`, redactSecrets(reason).text.slice(0, 400))
    return { pending: true, text: "Thread will settle when running and queued work finishes" }
  }
  return { run, evaluate, requestSettle }
}
