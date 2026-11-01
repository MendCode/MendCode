import { createEnvironmentPageState, looksLikeDotenv, type EnvInfo, type EnvironmentPageState, type EnvScope, type PastedItem } from "../../view/environment-page"
import type { AppContext } from "./context"

export function createEnvironmentPanel(ctx: AppContext) {
  const { state, input, requestFrame } = ctx
  async function load() {
    const page = state.environmentPage
    if (!page) return
    page.loading = true
    requestFrame()
    const asked = state.sessionId
    try {
      const [env, privacy] = await Promise.all([input.send({ type: "env.list", sessionId: asked }), input.send({ type: "privacy.get" })])
      if (page !== state.environmentPage || asked !== state.sessionId) return
      page.error = ""
      if (env.ok) {
        page.entries = (env.result?.entries as EnvInfo[] | undefined) ?? []
        page.native = env.result?.native as boolean | undefined
        page.engines = env.result?.engines as boolean | undefined
        page.selected = Math.min(page.selected, Math.max(0, page.entries.length - 1))
      } else page.error = "Could not load credentials; local owner access is required."
      if (privacy.ok) {
        page.encrypted = privacy.result?.enabled as boolean
        page.encryptionTarget = privacy.result?.target as boolean | undefined
        page.encryptionPending = privacy.result?.pending as number | undefined
      }
      else page.error = "Could not load encryption status; local owner access is required."
    } catch { page.error = "Connection unavailable. Press r to retry." }
    finally { page.loading = false; requestFrame() }
  }
  async function open(privacy = false) {
    state.environmentPage = createEnvironmentPageState()
    state.page = "env"
    await load()
    if (privacy && state.page === "env") state.environmentPage.confirm = "privacy"
    requestFrame()
  }
  /** Asks the daemon what the pasted text holds. Names and statuses come back, never values; the text itself stays in `page.paste`. */
  async function previewPaste(page: EnvironmentPageState, content: string, keep?: ReadonlySet<string>) {
    page.busy = true
    requestFrame()
    try {
      const result = await input.send({ type: "env.import", sessionId: state.sessionId, content, scope: page.scope })
      const items = result.ok ? (result.result?.items as PastedItem[] | undefined) ?? [] : []
      if (!result.ok || !items.length) { page.paste = undefined; page.error = result.ok ? "No variables found in the pasted text." : "Could not read the pasted text as NAME=value lines." }
      else {
        const saveable = items.filter((item) => item.status === "new" || item.status === "replace").map((item) => item.name)
        page.paste = { content, items, digest: result.result?.digest as string, checked: new Set(keep ? saveable.filter((name) => keep.has(name)) : saveable), cursor: page.paste?.cursor ?? 0 }
        page.error = ""
      }
    } catch { page.paste = undefined; page.error = "Connection unavailable. Nothing has been saved." }
    finally { page.busy = false }
  }
  async function applyPaste(page: EnvironmentPageState) {
    const paste = page.paste
    if (!paste) return
    const names = paste.items.filter((item) => paste.checked.has(item.name)).map((item) => item.name)
    if (!names.length) { page.error = "Select at least one variable (space), or esc to cancel."; return }
    page.busy = true
    requestFrame()
    try {
      const result = await input.send({ type: "env.import", sessionId: state.sessionId, content: paste.content, scope: page.scope, digest: paste.digest, names })
      if (result.ok) {
        page.paste = undefined; page.edit = undefined; page.error = ""
        page.notice = `Saved ${names.length} variable${names.length === 1 ? "" : "s"} to ${page.scope} scope, encrypted.`
        await load()
      } else page.error = "Could not save the selected variables. Check the vault key and disk space."
    } catch { page.error = "Connection unavailable. Nothing has been saved." }
    finally { page.busy = false }
  }
  async function key(key: string) {
    const page = state.environmentPage
    if (!page) return
    if (page.busy) return
    if (key === "\x1b") {
      if (page.paste) { page.paste = undefined; page.error = "" }
      else if (page.edit || page.confirm || page.import) { page.edit = undefined; page.confirm = undefined; page.import = undefined; page.error = "" }
      else { state.environmentPage = undefined; state.page = "chat" }
      requestFrame()
      return
    }
    if (page.loading) return
    page.notice = ""
    // A paste arrives as one multi-character string (never an escape sequence); a lone character is an ordinary key.
    const pasted = key.length > 1 && !key.startsWith("\x1b")
    if (page.paste) {
      const paste = page.paste
      const saveable = paste.items.filter((item) => item.status === "new" || item.status === "replace")
      if (key === "\x13") {
        const scopes: EnvScope[] = ["project", "session", "global"]
        page.scope = scopes[(scopes.indexOf(page.scope) + 1) % scopes.length]!
        await previewPaste(page, paste.content, paste.checked)
      } else if (key === "\r" || key === "\n") await applyPaste(page)
      else if (key === " ") { const item = paste.items[paste.cursor]; if (item && saveable.includes(item)) { if (!paste.checked.delete(item.name)) paste.checked.add(item.name) } }
      else if (key.toLowerCase() === "a") { if (paste.checked.size === saveable.length) paste.checked.clear(); else for (const item of saveable) paste.checked.add(item.name) }
      else if (["\x1b[A", "\x1bOA", "k"].includes(key)) paste.cursor = Math.max(0, paste.cursor - 1)
      else if (["\x1b[B", "\x1bOB", "j"].includes(key)) paste.cursor = Math.min(paste.items.length - 1, paste.cursor + 1)
    } else if (pasted && looksLikeDotenv(key) && (!page.import && !page.confirm)) {
      await previewPaste(page, key)
    } else if (page.import && !page.confirm) {
      if (key === "\x13") {
        const scopes: EnvScope[] = ["project", "session", "global"]
        page.scope = scopes[(scopes.indexOf(page.scope) + 1) % scopes.length]!
      } else if (key === "\r" || key === "\n") {
        page.busy = true
        requestFrame()
        try {
          const result = await input.send({ type: "env.import", sessionId: state.sessionId, path: page.import.path, scope: page.scope })
          if (result.ok) {
            page.import.digest = result.result?.digest as string
            page.import.names = result.result?.names as string[]
            page.confirm = "import"
            page.error = ""
          } else page.error = "Could not import. Choose a valid dotenv file inside this project."
        } catch { page.error = "Connection unavailable. Nothing has been imported." }
        finally { page.busy = false }
      } else if (key === "\x7f" || key === "\b") page.import.path = [...page.import.path].slice(0, -1).join("")
      else if (!/[\x00-\x1f\x7f-\x9f]/.test(key)) page.import.path = (page.import.path + key).slice(0, 4096)
    } else if (page.edit) {
      const edit = page.edit
      if (key === "\x13") {
        const scopes: EnvScope[] = ["project", "session", "global"]
        page.scope = scopes[(scopes.indexOf(page.scope) + 1) % scopes.length]!
      } else if (key === "\t") edit.field = edit.field === "name" ? "value" : "name"
      else if (key === "\r" || key === "\n") {
        if (edit.field === "name") {
          if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(edit.name)) page.error = "Use an environment variable name, e.g. MY_API_KEY."
          else { edit.field = "value"; page.error = "" }
        } else if (!edit.value) page.error = "Paste a value first."
        else {
          page.busy = true
          requestFrame()
          try {
            const result = await input.send({ type: "env.set", sessionId: state.sessionId, name: edit.name, value: edit.value, scope: page.scope })
            if (!result.ok) page.error = "Could not save. Check the credential name, value and vault key."
            else { page.edit = undefined; await load() }
          } catch { page.error = "Connection unavailable. Your entry has not been saved." }
          finally { page.busy = false }
        }
      } else if (key === "\x7f" || key === "\b") edit[edit.field] = [...edit[edit.field]].slice(0, -1).join("")
      else if (!/[\x00-\x1f\x7f-\x9f]/.test(key)) edit[edit.field] = (edit[edit.field] + key).slice(0, edit.field === "name" ? 128 : 16_384)
    } else if (page.confirm) {
      if (key.toLowerCase() !== "y") return
      page.busy = true
      requestFrame()
      try {
        const selected = page.entries[page.selected]
        const result = page.confirm === "privacy"
          ? await input.send({ type: "privacy.set", enabled: !(page.encryptionTarget ?? page.encrypted) })
          : page.confirm === "import" && page.import?.digest ? await input.send({ type: "env.import", sessionId: state.sessionId, path: page.import.path, scope: page.scope, digest: page.import.digest })
          : selected ? await input.send({ type: "env.remove", sessionId: state.sessionId, name: selected.name, scope: selected.scope }) : undefined
        page.confirm = undefined
        if (result?.ok) { page.import = undefined; await load() }
        else page.error = result && !result.ok && result.error.code === "busy" ? "Wait for active turns and jobs to finish, then retry." : "Change failed. Check disk space, local access and vault keys."
      } catch { page.error = "Connection unavailable. Reload to check whether the change completed." }
      finally { page.busy = false }
    } else if (key === "r") await load()
    else if (key === "i") { page.scope = "project"; page.import = { path: ".env" }; page.error = "" }
    else if (key === "p" && page.encrypted !== undefined) page.confirm = "privacy"
    else if (key === "a") { page.scope = "project"; page.edit = { name: "", value: "", field: "name" }; page.error = "" }
    else if (key === "e" && page.entries[page.selected]) {
      const selected = page.entries[page.selected]!
      page.scope = selected.scope
      page.edit = { name: selected.name, value: "", field: "value" }
      page.error = ""
    } else if (key === "x" && page.entries[page.selected]) page.confirm = "remove"
    else if (["\x1b[A", "\x1bOA", "k"].includes(key)) page.selected = Math.max(0, page.selected - 1)
    else if (["\x1b[B", "\x1bOB", "j"].includes(key)) page.selected = Math.min(Math.max(0, page.entries.length - 1), page.selected + 1)
    else if (key === "q") { state.environmentPage = undefined; state.page = "chat" }
    requestFrame()
  }
  return { open, key }
}
