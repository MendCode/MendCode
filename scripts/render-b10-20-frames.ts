import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { CONNECT_CHOICES } from "../apps/cli/src/view/connect-page"
import { textWidth } from "../apps/cli/src/view/wrap"
import { gitlabHarness } from "../apps/cli/test/gitlab-harness"
import { plain } from "../apps/cli/test/providers-harness"
import { GITLAB_TOKEN, GITLAB_NAMESPACE, GITLAB_URL } from "../packages/engine-native/test/gitlab-fixtures"

export async function renderB1020Frames(directory: string, sizes: string[]) {
  const dir = mkdtempSync(path.join(tmpdir(), "mendcode-b10-20-frames-"))
  try {
    for (const size of sizes.length ? sizes : ["100x30", "180x50"]) {
      const match = /^(\d+)x(\d+)$/.exec(size)
      if (!match || Number(match[1]) < 20 || Number(match[2]) < 10) throw new Error(`Invalid size ${size}`)
      const width = Number(match[1]), height = Number(match[2])
      const h = gitlabHarness({ dataDir: dir, width, height })
      const save = (name: string, frame = h.frames.at(-1)!) => {
        const rows = frame.map(plain)
        if (rows.length !== height || rows.some((row) => textWidth(row) > width || row.includes("\x1b")) || rows.join("\n").includes(GITLAB_TOKEN)) throw new Error(`Invalid frame ${name} ${size}`)
        writeFileSync(path.join(directory, `${name}-${size}.txt`), `${rows.join("\n")}\n`)
      }
      await h.run("/connect")
      for (let index = 0; index < CONNECT_CHOICES.indexOf("gitlab"); index++) await h.type("\x1b[B")
      save("connect-gitlab-selected")
      await h.type("\r"); save("connect-gitlab-proxy")
      await h.type(GITLAB_URL); await h.type("\r"); await h.type(GITLAB_TOKEN); save("connect-gitlab-masked")
      await h.type("\x05"); save("connect-gitlab-environment")
      await h.type("\r"); await h.type(GITLAB_NAMESPACE); save("connect-gitlab-namespace")
      await h.type("\r"); save("connect-gitlab-connected")
      if (!h.text().includes("GitLab connected")) throw new Error(`Missing connection result ${size}`)
      for (const phase of ["Saving", "Loading", "Testing"]) {
        const frame = h.frames.find((frame) => frame.map(plain).join("\n").includes(`${phase} GitLab`))
        if (!frame) throw new Error(`Missing ${phase} frame ${size}`)
        save(`connect-gitlab-${phase.toLowerCase()}`, frame)
      }
      await h.type("r"); save("connect-gitlab-refreshed")
      const refreshing = h.frames.find((frame) => frame.map(plain).join("\n").includes("Refreshing GitLab"))
      if (!refreshing) throw new Error(`Missing refresh frame ${size}`)
      save("connect-gitlab-refreshing", refreshing)
      await h.type("m"); save("model-gitlab")
      await h.type("/"); await h.type("gitlab:duo-chat-gpt-5-2"); save("model-gitlab-picker")
      await h.type("\r"); save("model-gitlab-selected")
      await h.run("/model"); await h.type("/"); await h.type("gitlab:duo-workflow-sonnet-4-6"); save("model-gitlab-workflow-picker")
      await h.type("\r"); save("model-gitlab-workflow-selected")
      if (h.commands("session.model.set").at(-1)?.choice && (h.commands("session.model.set").at(-1)!.choice as { model: string }).model !== "gitlab:duo-workflow-sonnet-4-6") throw new Error(`Missing workflow selection ${size}`)
      await h.type("\x1b"); await h.run("/providers"); save("providers-gitlab")
      await h.type("\r"); save("providers-gitlab-details")
      await h.type("\x1b"); await h.type("e"); save("providers-gitlab-off")
      await h.type("d"); save("providers-gitlab-remove")
      await h.type("y"); save("providers-gitlab-removed")
      await h.type("\x1b")
      for (const [phase, name] of [["providers.set", "save-failed"], ["providers.refresh", "refresh-failed"], ["providers.test", "test-failed"]]) {
        await h.run("/connect gitlab"); await h.type(GITLAB_URL); await h.type("\r"); await h.type(GITLAB_TOKEN); await h.type("\r"); await h.type(GITLAB_NAMESPACE)
        h.fail(phase); await h.type("\r"); save(`connect-gitlab-${name}`)
        h.fail()
        if (phase === "providers.refresh") {
          const refreshes = h.commands("providers.refresh").length
          await h.type("r")
          if (h.commands("providers.refresh").length !== refreshes + 1 || !h.text().includes("GitLab connected")) throw new Error(`Missing refresh retry ${size}`)
          save("connect-gitlab-refresh-retry")
          await h.type("t"); save("connect-gitlab-test-retry")
        }
        if (phase !== "providers.set") { await h.type("e"); save(`connect-gitlab-edit-${name}`) }
        await h.type("\x1b"); await h.type("\x1b")
      }
      await h.run("/connect gitlab"); await h.type("https://gitlab.com"); await h.type("\x05"); await h.type("\r"); await h.type("\r"); save("connect-gitlab-blocked")
      if (h.commands("providers.set").at(-1)?.baseUrl === "https://gitlab.com") throw new Error(`Unsafe endpoint sent ${size}`)
      await h.type("\x1b"); await h.type("\x1b")
      await h.run("/connect gitlab"); await h.type(GITLAB_URL); await h.type("\x05"); await h.type("\r"); await h.type("123"); await h.type("\r"); save("connect-gitlab-invalid-namespace")
      await h.type("\x1b"); await h.type("\x1b")
    }
  } finally { rmSync(dir, { recursive: true, force: true }) }
}
