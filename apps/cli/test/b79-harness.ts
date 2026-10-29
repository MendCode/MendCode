import type { IdeReport, IdeSelection } from "@mendcode/protocol/wire"
import { appHarness, tempDir } from "./session-ui-harness"

export const B79_SELECTION: IdeSelection = {
  source: "zed", filePath: "/work/project/src/auth.ts", ranges: [
    { text: "export function authorize(token: string) {\n  return token.length > 0\n}", selection: { start: { line: 12, character: 1 }, end: { line: 14, character: 2 } } },
    { text: "authorize(request.token)", selection: { start: { line: 29, character: 3 }, end: { line: 29, character: 27 } } },
  ],
}

export function b79Harness(options: { width?: number; height?: number; enabled?: boolean; remote?: boolean } = {}) {
  const control: { enabled: boolean; report: IdeReport; submitError: boolean; openError: boolean; queryGate?: Promise<void> } = {
    enabled: options.enabled ?? false,
    report: { editor: "zed", enabled: true, status: "connected", selection: structuredClone(B79_SELECTION) },
    submitError: false, openError: false,
  }
  const h = appHarness({ width: options.width ?? 100, height: options.height ?? 30, directory: "/work/project", dataDir: tempDir("mend-b79-ui-"),
    ...(options.remote ? { remote: { host: "127.0.0.1:7010", readOnly: true } } : {}),
    reply: async (command) => {
      if (command.type === "ide.configure") control.enabled = command.enabled
      if (command.type === "ide.query" || command.type === "ide.configure") {
        if (control.queryGate) await control.queryGate
        return { ok: true, result: control.enabled ? structuredClone(control.report) : { editor: "zed", enabled: false, status: "off" } }
      }
      if (command.type === "ide.open") return { ok: true, result: control.openError ? { opened: false, message: "zed is not installed in the daemon PATH" } : { opened: true } }
      if (command.type === "user.submit" && control.submitError) return { ok: false, error: { code: "busy", message: "Queue unavailable" } }
      if (command.type === "models.list") return { ok: true, result: { engine: "faux", selectable: false, models: [], defaults: {}, effective: {}, roles: {} } }
      return { ok: true }
    },
  })
  h.app.applySettings({ onboarded: true })
  return { ...h, control, close: () => h.app.onKey("\x03") }
}
