import { describe, expect, test } from "bun:test"

describe("pre-session approval mode command", () => {
  test("exposes a Home-only slash command that writes the future-session default", async () => {
    const source = await Bun.file(new URL("../../../src/cli/cmd/tui/app.tsx", import.meta.url)).text()

    expect(source).toContain('value: "mendcode.permission.status"')
    expect(source).toContain('slash: { name: "permission", aliases: ["permissions", "approval"] }')
    expect(source).toContain('enabled: route.data.type === "home"')
    expect(source).toContain("writePermissionsConfig({ mode })")
    expect(source).toContain("Default approval mode saved:")
  })

  test("labels the Home command as a change while keeping session controls separate", async () => {
    const commands = await Bun.file(new URL("../../../src/cli/cmd/tui/component/dialog-command.tsx", import.meta.url)).text()
    const session = await Bun.file(new URL("../../../src/cli/cmd/tui/routes/session/index.tsx", import.meta.url)).text()

    expect(commands).toContain('"mendcode.permission.status": "Change Default Approval Mode"')
    expect(commands).toContain('"session.permission.status": "Change Approval Mode"')
    expect(session).toContain('value: "session.permission.status"')
  })
})
