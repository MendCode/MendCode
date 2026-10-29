import { afterAll, afterEach, describe, expect, test } from "bun:test"
import { cleanBenches, cleanBenchTemplates } from "../../../packages/daemon/test/git-actions-bench"
import { publishBench, type PublishBench } from "../../../packages/daemon/test/git-publish-bench"
import { createGitPrState, gitPrKey, renderGitPrPage } from "../src/view/git-pr-page"
import { cleanTemps } from "./session-ui-harness"
import { click, frame, gitApp, keys, settle, type GitApp } from "./git-page-helpers"

afterEach(() => { cleanTemps(); cleanBenches() })
afterAll(cleanBenchTemplates)

const ON = { experimental: { git_actions: true } }
const URL = "https://github.com/me/widgets"

const open = async (app: GitApp, command = "/git pr") => { await app.h.type(`${command}\r`); await settle(); await settle(); app.h.app.render() }
const sentOf = (app: GitApp, type: string) => app.h.sent.filter((command) => command.type === type)

/** A repository with a commit and no remote; gh knows the account `me` and, like the real one, adds the remote it was asked for. */
function local(options: { unborn?: boolean; add?: boolean; reply?: Parameters<PublishBench["gh"]["reply"]>[0]; user?: Parameters<PublishBench["user"]>[0] } = {}) {
  const b = publishBench()
  b.user(options.user)
  b.addsRemote(options.add === false ? undefined : `${URL}.git`)
  b.gh.reply(options.reply ?? { stdout: URL })
  if (options.unborn) b.sh("checkout", "-q", "--orphan", "fresh")
  b.clearCalls()
  return b
}
const app = (b: PublishBench, extra: Partial<Parameters<typeof gitApp>[0]> = {}) => gitApp({ bench: b, settings: ON, height: 36, ...extra })
/** The form, with the name `widgets` typed over the folder's. */
async function form(a: GitApp, name = "widgets") {
  await open(a)
  await keys(a.h, "g")
  await keys(a.h, ...Array(40).fill("\x7f"))
  await a.h.type(name)
}
const toCard = async (a: GitApp, description?: string) => {
  await form(a)
  await keys(a.h, "\t", "\t")
  if (description) await a.h.type(description)
  await keys(a.h, "\r")
}

describe("the empty state of the PR tab", () => {
  test("with the switch on, a repository with no remote says so and offers one action; there is no push hint and gh is not started", async () => {
    const b = local()
    const a = await app(b)
    await open(a)
    const text = frame(a.h)
    expect(text).toContain("main has no remote: there is nothing to push and no pull request yet.")
    expect(text).toContain("g publish to GitHub · r refresh · esc back")
    expect(text).toContain("Publishing creates a private repository with your gh login and adds it as origin. Pushing stays a separate step.")
    expect(text).not.toMatch(/u push|P create/)
    const chip = a.h.frames.at(-1)!.flat().find((span) => span.text === " Publish to GitHub (private) ")
    expect(chip).toMatchObject({ fg: "text", bg: "element", bold: true })
    expect(b.ghCalls()).toEqual([])
    expect(sentOf(a, "git.publish")).toHaveLength(0)
  })

  test("with the switch off the tab is the one line it was, g and u do nothing and nothing is sent or started", async () => {
    const b = local()
    const a = await gitApp({ bench: b, height: 30 })
    await open(a)
    expect(frame(a.h)).toContain("Off: this tab uses the network · /experimental git_actions on")
    await keys(a.h, "g", "u", "r")
    expect(sentOf(a, "git.publish")).toHaveLength(0)
    expect(sentOf(a, "git.pr.view")).toHaveLength(0)
    expect(b.ghCalls()).toEqual([])
    expect(frame(a.h)).not.toMatch(/publish/i)
  })

  test("a repository that has a remote is the PR tab it was: no publish anywhere", async () => {
    const b = local()
    b.sh("remote", "add", "origin", b.remote)
    b.gh.reply({ stderr: 'no pull requests found for branch "main"', exit: 1 })
    const a = await app(b)
    await open(a)
    expect(frame(a.h)).toContain("No pull request for main.")
    expect(frame(a.h)).not.toMatch(/publish/i)
    await keys(a.h, "g")
    expect(sentOf(a, "git.publish")).toHaveLength(0)
  })
})

describe("the form", () => {
  test("g reads the plan and opens a form with the folder's name and the gh account; only the account was read, nothing created", async () => {
    const b = local()
    const a = await app(b)
    await open(a)
    await keys(a.h, "g")
    const text = frame(a.h)
    expect(a.h.app.page).toBe("git-pr")
    expect(text).toContain("Publish to GitHub")
    expect(text).toContain("me/repo · private")
    expect(text).toContain("private · change visibility on GitHub")
    expect(text).toContain("type the name · enter next field · tab next · esc cancel")
    expect(b.ghCalls()).toEqual([["api", "user", "--jq", ".login"]])
    expect(sentOf(a, "git.publish").map((command) => command.type === "git.publish" && command.preview)).toEqual([true])
    expect(b.hasRemote("origin")).toBe(false)
  })

  test("there is no way to choose a visibility: no field, no key, no word, and no command carries one", async () => {
    const b = local()
    const a = await app(b)
    await form(a)
    const seen = [frame(a.h)]
    for (const key of ["p", "i", "v", "\t", "\x1b[C", " ", "\t"]) { await keys(a.h, key); seen.push(frame(a.h)) }
    // Neither a word for another visibility nor a box to tick: the only thing the form says is that it is private.
    for (const text of seen) expect(text).not.toMatch(/public|internal|\[ \]|\[x\]/i)
    for (const text of seen) expect(text).toContain("private · change visibility on GitHub")
    // Letters typed in the name are text: they changed the name and nothing else.
    expect(seen[1]).toContain("me/widgetsp · private")
    const second = await app(b)
    await toCard(second)
    expect(frame(second.h)).toContain("not done: no push, no public repository, no other remote")
    for (const command of [...sentOf(a, "git.publish"), ...sentOf(second, "git.publish")]) {
      expect(Object.keys(command).sort().filter((key) => !["id", "clientId", "type", "directory", "sessionId", "name", "owner", "description", "preview"].includes(key))).toEqual([])
    }
    expect(b.creates()).toEqual([])
  })

  test("the fields are the app's editors: typing, backspace, tab and shift+tab walk name, owner and description; < and > are text", async () => {
    const b = local()
    const a = await app(b)
    await form(a, "a<b>")
    expect(frame(a.h)).toContain("me/a<b> · private")
    expect(a.h.app.page).toBe("git-pr")
    await keys(a.h, "\t")
    expect(frame(a.h)).toContain("type the owner")
    await keys(a.h, "\t")
    expect(frame(a.h)).toContain("type the description · enter review")
    await keys(a.h, "\x1b[Z", "\x1b[Z", "\x1b[Z")
    expect(frame(a.h)).toContain("type the description")
    await keys(a.h, "\x1b")
    expect(frame(a.h)).toContain("g publish to GitHub")
  })

  test("a click on the action is the key", async () => {
    const b = local()
    const a = await app(b)
    await open(a)
    await click(a.h, "Publish to GitHub (private)")
    expect(frame(a.h)).toContain("type the name")
    await keys(a.h, "\x1b")
    await a.h.app.onKey("\x1b[<0;4;13M")
    await a.h.app.onKey("\x1b[<0;4;13m")
    await settle()
    expect(frame(a.h)).toContain("g publish to GitHub")
  })

  // One repository per refusal: five in one test ran past the 5 s limit.
  test("gh missing is one line on the form", async () => {
    const missing = await app(local(), { actionEnv: local().withoutGh })
    await open(missing)
    await keys(missing.h, "g")
    expect(frame(missing.h)).toContain("gh is not installed or not on PATH")
    expect(frame(missing.h)).toContain("g publish to GitHub")
  })

  test("gh not logged in is one line on the form", async () => {
    const out = await app(local({ user: { stderr: "To get started with GitHub CLI, please run:  gh auth login", exit: 4 } }))
    await open(out)
    await keys(out.h, "g")
    expect(frame(out.h)).toContain("gh is not logged in: run gh auth login in your shell")
  })

  test("an origin that appeared after the page opened is one line on the form", async () => {
    const racing = local()
    const r = await app(racing)
    await open(r)
    racing.sh("remote", "add", "origin", "https://example.test/x/y.git")
    await keys(r.h, "g")
    expect(frame(r.h)).toContain("a remote named origin already exists (https://example.test/x/y.git): the page never replaces or renames a remote")
  })

  test("a permission rule that denies gh repo create is one line on the form, and nothing was created", async () => {
    const denied = local()
    const d = await app(denied, { settings: { ...ON, permission: { bash: { "gh repo create *": "deny" } } } })
    await form(d)
    await keys(d.h, "\t", "\t", "\r")
    expect(frame(d.h)).toContain('your permission rule bash "gh repo create *" denies')
    expect(denied.creates()).toEqual([])
  })

  test("a remote client's refusal is one line on the form", async () => {
    const far = await app(local(), { intercept: (command) => command.type === "git.publish" ? { ok: false, error: { code: "forbidden", message: "[GIT]: push, publish and pull requests run on this machine and are local only" } } : undefined })
    await open(far)
    await keys(far.h, "g")
    expect(frame(far.h)).toContain("push, publish and pull requests run on this machine and are local only")
  })

  test("a name or owner GitHub would not take is one line on the form, and nothing was created", async () => {
    const b = local()
    const a = await app(b)
    await form(a, ".hidden")
    await keys(a.h, "\t", "\t", "\r")
    expect(frame(a.h)).toContain("the repository name cannot start with . or -")
    expect(frame(a.h)).toContain("type the description")
    await keys(a.h, "\x1b[Z", "\x1b[Z", ...Array(40).fill("\x7f"))
    await a.h.type("widgets")
    await keys(a.h, "\t", ...Array(10).fill("\x7f"))
    await a.h.type("a b")
    await keys(a.h, "\t", "\r")
    expect(frame(a.h)).toContain("the owner takes letters, digits, _ and - only, and cannot start with -")
    expect(b.creates()).toEqual([])
  })
})

describe("the card and the publish", () => {
  test("the card is headed as leaving the machine in the warning role, with the exact command, the repository, private, and what is not done", async () => {
    const b = local()
    const a = await app(b)
    await toCard(a, "Small widgets for the shop")
    const text = frame(a.h)
    expect(text).toContain("Confirm · publish")
    expect(text).toContain("leaves this machine")
    expect(text).toContain("gh repo create me/widgets --private --source")
    expect(text).toContain("'--description=Small widgets for the shop'")
    expect(text).toContain("me/widgets · private · change visibility on GitHub")
    expect(text).toContain("main · 1 commit stays on this machine until you push")
    expect(text).toContain("not done: no push, no public repository, no other remote")
    expect(text).toContain("uses your own gh login; if gh would ask, it fails")
    expect(text).toContain("enter publish · esc edit")
    const heading = a.h.frames.at(-1)!.flat().find((span) => span.text === "leaves this machine")
    expect(heading).toMatchObject({ fg: "warning", bold: true })
    expect(b.creates()).toEqual([])
    expect(text).not.toMatch(/--public|--internal|--push/)
    // esc goes back to the form with what was typed.
    await keys(a.h, "\x1b")
    expect(frame(a.h)).toContain("me/widgets · private")
    expect(frame(a.h)).toContain("Small widgets for the shop")
  })

  test("enter creates the repository and adds origin: one create with --private, no push at all, a note on the page, and the tab offers the push", async () => {
    const b = local()
    const a = await app(b)
    await toCard(a)
    await keys(a.h, "\r")
    await settle()
    await settle()
    a.h.app.render()
    expect(b.creates()).toEqual([["repo", "create", "me/widgets", "--private", "--source", b.dir, "--remote", "origin"]])
    expect(b.hasRemote("origin")).toBe(true)
    expect(b.pushes()).toEqual([])
    expect(sentOf(a, "git.push")).toHaveLength(0)
    const text = frame(a.h)
    expect(text).toContain("published me/widgets, private · origin added · u pushes the branch when you are ready")
    expect(text).toContain("u push · P create PR")
    expect(text).not.toContain("No remote")
    // The push is a step of its own: u shows its card, and nothing is pushed until enter on that card.
    await keys(a.h, "u")
    expect(frame(a.h)).toContain("Confirm · push")
    expect(b.pushes()).toEqual([])
  })

  test("a repository with no commit yet is published as an empty repository, and the page says the first commit comes before the push", async () => {
    const b = local({ unborn: true })
    const a = await app(b)
    await toCard(a)
    expect(frame(a.h)).toContain("no commit yet: this creates an empty repository, the first commit comes before the push")
    await keys(a.h, "\r")
    await settle()
    expect(frame(a.h)).toContain("origin added · commit first, then push")
  })

  test("a failure of gh is its first line in the error role and the card stays; nothing is retried", async () => {
    const b = local({ add: false, reply: { stderr: "GraphQL: Name already exists on this account (createRepository)", exit: 1 } })
    const a = await app(b)
    await toCard(a)
    await keys(a.h, "\r")
    await settle()
    a.h.app.render()
    expect(frame(a.h)).toContain("Confirm · publish")
    expect(frame(a.h)).toContain("gh could not create the repository: GraphQL: Name already exists on this account (createRepository)")
    const notice = a.h.frames.at(-1)!.flat().find((span) => span.text.startsWith("gh could not create"))
    expect(notice).toMatchObject({ fg: "error" })
    await Bun.sleep(100)
    expect(b.creates()).toHaveLength(1)
    expect(b.hasRemote("origin")).toBe(false)
  })

  test("a partial failure says what exists now and what to run, keeps the command, and neither deletes nor retries", async () => {
    const b = local({ add: false, reply: { stdout: URL, stderr: 'X Unable to add remote "origin"', exit: 1 } })
    const a = await app(b)
    await toCard(a)
    await keys(a.h, "\r")
    await settle()
    await settle()
    a.h.app.render()
    const text = frame(a.h)
    expect(text).toContain("gh repo create me/widgets --private --source")
    expect(text).toContain("now: this repository has no remote named origin")
    expect(text).toContain(`on GitHub: ${URL}`)
    expect(text).toContain(`run: git remote add origin ${URL}`)
    expect(text).toContain("nothing was deleted and nothing is retried")
    expect(text).toContain('X Unable to add remote "origin"')
    expect(text).toContain("publish incomplete: me/widgets was created, gh failed (exit 1)")
    const notice = a.h.frames.at(-1)!.flat().find((span) => span.text.startsWith("publish incomplete"))
    expect(notice).toMatchObject({ fg: "error" })
    await Bun.sleep(150)
    expect(b.creates()).toHaveLength(1)
    expect(b.ghCalls().some((call) => call.includes("delete"))).toBe(false)
  })

  test("the page's own keys: u or g on the empty state, enter on the card are the only ways to a create; a key on the running stage does nothing", () => {
    const state = { ...createGitPrState(), body: { kind: "noremote" as const, branch: "main" } }
    for (const key of ["x", "P", "o", "p", "\r", "c"]) expect(gitPrKey(state, key).action).toEqual({ type: "none" })
    expect(gitPrKey(state, "g").action).toEqual({ type: "publish" })
    expect(gitPrKey(state, "u").action).toEqual({ type: "publish" })
    expect(gitPrKey({ ...state, stage: "running" }, "g").action).toEqual({ type: "none" })
    expect(renderGitPrPage({ state, width: 80, height: 20 }).length).toBe(20)
  })

  test("it fits 80 and 60 columns at every stage", async () => {
    for (const [width, height] of [[80, 26], [60, 24]] as const) {
      const b = local({ add: false, reply: { stdout: URL, stderr: 'X Unable to add remote "origin"', exit: 1 } })
      const a = await app(b, { width, height })
      await open(a)
      const stages = [frame(a.h)]
      await keys(a.h, "g")
      stages.push(frame(a.h))
      await keys(a.h, "\t", "\t", "\r")
      stages.push(frame(a.h))
      await keys(a.h, "\r")
      await settle()
      stages.push(frame(a.h))
      for (const text of stages) for (const row of text.split("\n")) expect(row.length).toBeLessThanOrEqual(width)
    }
  })
})
