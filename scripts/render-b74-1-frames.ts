import { mkdirSync, writeFileSync } from "node:fs"
import path from "node:path"
import { b74Harness } from "../apps/cli/test/b74-fixtures"
import { fit } from "../apps/cli/src/view/deck"
import { textWidth } from "../apps/cli/src/view/wrap"

export async function renderB741Frames(directory: string, sizes: string[]) {
  mkdirSync(directory, { recursive: true })
  for (const size of sizes.length ? sizes : ["100x30", "180x50"]) {
    const match = /^(\d+)x(\d+)$/.exec(size)
    if (!match) throw new Error("Invalid B74.1 frame size")
    const width = Number(match[1]), height = Number(match[2])
    const save = (name: string, h: ReturnType<typeof b74Harness>) => {
      h.app.render()
      const frame = h.frames.at(-1) ?? []
      if (frame.length !== height || frame.some((row) => textWidth(row.map((span) => span.text).join("")) > width)) throw new Error(`B74.1 frame overflow: ${name} ${size}`)
      const text = frame.map((row) => fit(row, width).map((span) => span.text).join("")).join("\n")
      if (text.includes("\x1b")) throw new Error("ANSI in B74.1 frame")
      writeFileSync(path.join(directory, `${name}-${size}.txt`), text + "\n")
    }
    const disabled = b74Harness({ width, height, enabled: false })
    try {
      await disabled.type("/console\r"); save("console-disabled", disabled)
      await disabled.keys("s"); save("console-setup", disabled)
    } finally { await disabled.app.onKey("\x03") }
    const h = b74Harness({ width, height })
    try {
      await h.type("/console\r"); save("console-accounts-quota", h)
      await h.keys("l"); save("console-login", h)
      await h.keys("p"); save("console-login-success", h)
      await h.keys("d"); save("console-logout-confirm", h)
      await h.keys("y"); save("console-logged-out", h)
      h.failNext(); await h.keys("r"); save("console-error", h)
    } finally { await h.app.onKey("\x03") }
    const picker = b74Harness({ width, height })
    try {
      picker.patchReport({ unavailableAccountIDs: ["offline-account"], metadataError: "Console metadata unavailable", quota: undefined, billingUrl: undefined, consoleManagedProviders: [] })
      await picker.type("/console\r"); save("console-partial-service", picker)
      await picker.keys("\x1b"); await picker.type("/org\r"); save("org-picker", picker)
      await picker.type("research"); save("org-search", picker)
      picker.failNext(); await picker.keys("\r"); save("org-switch-error", picker)
      await picker.keys("\x15"); await picker.type("absent"); save("org-no-matches", picker)
      await picker.keys("\x1b")
      const sample = picker.getReport().orgs[0]!
      picker.patchReport({ orgs: Array.from({ length: 60 }, (_, i) => ({ ...sample, orgID: `org-${i}`, orgName: `Organization ${String(i).padStart(2, "0")}`, active: i === 0 })) })
      await picker.type("/org\r"); await picker.keys(...Array.from({ length: 65 }, () => "\x1b[B")); save("org-scroll-last", picker)
    } finally { await picker.app.onKey("\x03") }
    const remote = b74Harness({ width, height, remote: { host: "127.0.0.1", readOnly: true } })
    try { await remote.type("/org\r"); save("org-remote-blocked", remote) }
    finally { await remote.app.onKey("\x03") }
  }
}
