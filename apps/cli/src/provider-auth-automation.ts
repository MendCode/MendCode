import type { ProviderAuthStatus, ProviderAuthorization } from "@mendcode/protocol"
import type { Common } from "./automation"
import type { CatalogAutomation } from "./catalog-args"
import type { CatalogContext } from "./catalog-automation"

/** Waits for daemon auth, with no provider HTTP or credentials in the CLI. */
export function createProviderAuthAutomation(ctx: CatalogContext) {
  const { request, result, fail } = ctx
  async function login(provider: string, method?: string, json = false, open = false) {
    let interrupted = false
    let timedOut = false
    let owned = false
    let success = false
    let wake: (() => void) | undefined
    const timer = ctx.setTimer ?? ((ms: number, callback: () => void) => { const id = setTimeout(callback, ms); return { cancel: () => clearTimeout(id) } })
    // As long as the daemon keeps the login open (15 minutes): an account, workspace and consent in the browser can take a while.
    const timeout = timer(900_000, () => { timedOut = true; wake?.() })
    ctx.onInterrupt(() => { interrupted = true; wake?.() })
    try {
      const started = await request({ type: "providers.auth.authorize", provider, ...(method ? { method } : {}), ...(open ? { open } : {}) })
      if (!started.ok) return fail(started.message, 1, started.code)
      const authorization = started.result.authorization as ProviderAuthorization | undefined
      if (!authorization) return fail("No authorization returned")
      owned = true
      const authProvider = authorization.provider
      // The authorization URL/code is displayed only for this explicit login, never in status or inventory.
      const surface = json ? ctx.err : ctx.out
      surface.write(`${authorization.instructions}\nAuthorize: ${authorization.url}\n`)
      while (!interrupted && !timedOut) {
        const reply = await request({ type: "providers.auth.status", provider: authProvider })
        if (!reply.ok) return fail(reply.message, 1, reply.code)
        const status = (reply.result.statuses as ProviderAuthStatus[] | undefined)?.[0]
        if (status?.state === "authorized") { success = true; return result({ status, secretsPrinted: false }, `${authProvider === "github-copilot" ? "GitHub Copilot" : "ChatGPT"} connected\n`) }
        if (status?.state !== "pending") return fail(status?.error ?? "OAuth authorization cancelled or failed", status?.state === "cancelled" ? 2 : 1)
        await new Promise<void>((resolve) => {
          const tick = timer(1000, () => { wake = undefined; resolve() })
          wake = () => { tick.cancel(); wake = undefined; resolve() }
          if (interrupted || timedOut) wake()
        })
      }
      return fail(timedOut ? "OAuth authorization timed out" : "OAuth authorization cancelled", timedOut ? 3 : 2, timedOut ? "timeout" : "cancelled")
    } finally {
      timeout.cancel()
      // Failed clients must not leave a listener or device poll running in the daemon.
      if (owned && !success) await request({ type: "providers.auth.action", provider: provider === "github-copilot" ? provider : "chatgpt", action: "cancel" })
      ctx.onInterrupt(() => {})
    }
  }
  return {
    login,
    async run(command: Extract<CatalogAutomation, { kind: "catalog.auth" }> & Common) {
      const { provider, method, operation } = command
      if (operation === "login" && command.execute) return login(provider!, method, command.json, command.open)
      if (["refresh", "logout"].includes(operation) && !command.execute) return fail("Pass --execute to change OAuth credentials", 64)
      const reply = await request(operation === "status" ? { type: "providers.auth.status", ...(provider ? { provider } : {}) }
        : ["login", "login-plan"].includes(operation) ? { type: "providers.auth.plan", provider: provider!, ...(method ? { method } : {}) }
        : { type: "providers.auth.action", provider: provider!, action: operation as "refresh" | "logout" })
      return reply.ok ? result(reply.result, `${JSON.stringify(reply.result, null, 2)}\n`) : fail(reply.message, 1, reply.code)
    },
  }
}
