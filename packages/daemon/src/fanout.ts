import type { Store } from "@mendcode/store"
import type { WorktreePort } from "@mendcode/loops"
import { redactSecrets, type SessionId } from "@mendcode/protocol"
import { excerpt } from "./session-recall"

export type FanoutBranch = { sessionId: SessionId; model: string; directory: string; branch: string; base: string; error?: string }
export type FanoutGroup = { owner: SessionId; at: number; branches: FanoutBranch[] }

/** Leases stay available for comparison. No automatic commit, merge or removal of a successful run. */
export function createFanout(input: {
  store: Store
  now(): number
  id(): SessionId
  leases: WorktreePort
  valid(model: string): string | undefined
  start(branch: FanoutBranch, prompt: string, owner: SessionId): Promise<string | undefined>
  state(id: SessionId): string
}) {
  const pending = new Set<SessionId>()
  function summary(id: SessionId) {
    const saved = input.store.meta.get(`session.summary:${id}`)
    if (saved) return redactSecrets(saved).text.slice(0, 500)
    const answer = input.store.recall.page(id, Number.MAX_SAFE_INTEGER, 12).find((item) => item.kind === "agent_message")
    return answer ? redactSecrets(excerpt(input.store.recall.chunks(answer), 500)?.text ?? "").text : ""
  }
  function compare(requested: SessionId) {
    const owner = (input.store.meta.get(`session.fanout.owner:${requested}`) || requested) as SessionId
    let group: FanoutGroup | undefined
    try { group = JSON.parse(input.store.sessionData.get(owner, "fanout") ?? "null") ?? undefined } catch {}
    if (!group) return { branches: [] }
    return { ...group, branches: group.branches.map((branch) => ({ ...branch, state: input.state(branch.sessionId), summary: summary(branch.sessionId) })) }
  }
  async function start(owner: SessionId, prompt: string, models: string[]) {
    const source = input.store.sessionInfo(owner)
    if (!source) throw new Error("Unknown session")
    if (pending.has(owner)) throw new Error("Fan-out already starting")
    if (!prompt.trim() || models.length < 2 || models.length > 8) throw new Error("Use a prompt and 2–8 models")
    for (const model of models) { const error = input.valid(model); if (error) throw new Error(error) }
    pending.add(owner)
    const branches: FanoutBranch[] = []
    try {
      // Make every lease before any provider starts. A provisioning failure leaves no running subset.
      for (const model of models) {
        const sessionId = input.id()
        const lease = await input.leases.create({ directory: source.directory, key: sessionId, label: `fanout-${model}` })
        if (!lease.ok) throw new Error(lease.message)
        branches.push({ sessionId, model, directory: lease.path, branch: lease.branch, base: lease.base })
      }
    } catch (error) {
      for (const branch of branches) await input.leases.release({ directory: source.directory, path: branch.directory, branch: branch.branch, base: branch.base })
      pending.delete(owner)
      throw error
    }
    const group: FanoutGroup = { owner, at: input.now(), branches }
    const save = () => input.store.sessionData.set(owner, "fanout", JSON.stringify(group))
    try {
      for (const branch of branches) {
        input.store.createSession({ id: branch.sessionId, directory: branch.directory, parentId: owner, title: `fanout · ${branch.model}`.slice(0, 200) })
        input.store.setSessionModel(branch.sessionId, { model: branch.model })
        input.store.meta.set(`session.title.manual:${branch.sessionId}`, "true")
        input.store.meta.set(`session.fanout.owner:${branch.sessionId}`, owner)
      }
      save()
      for (const branch of branches) {
        try { const error = await input.start(branch, prompt, owner); if (error) branch.error = error }
        catch { branch.error = "Could not start branch; lease retained" }
        save()
      }
      return compare(owner)
    } finally { pending.delete(owner) }
  }
  return { start, compare }
}
