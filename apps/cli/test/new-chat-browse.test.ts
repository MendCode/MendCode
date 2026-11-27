import { afterAll, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createNewChatPicker, type PickRequest } from "../src/ui/app/new-chat-picker"
import type { Line } from "../src/ui/theme"
import { completeTab, eraseBack, expandTyped, goUp, looksLikePath, MAX_DIRECTORIES, nameToCreate, parseBrowse, rankNames, readDirectories, usualRoot } from "../src/view/new-chat-browse"
import { folderChoices, renderNewChatPicker } from "../src/view/new-chat-picker"

const plain = (row: Line) => row.map((span) => span.text).join("")
const HOME = "/Users/me"

describe("what a typed path means", () => {
  test("`~`, `/`, `./`, `../` and anything with a slash browse; a plain name filters the known folders", () => {
    for (const query of ["~", "~/", "/", "/usr/lo", "./x", "..", "../y", "code/api", " ~/c "]) expect(looksLikePath(query), query).toBe(true)
    for (const query of ["", "api", ".hidden", "two words"]) expect(looksLikePath(query), query).toBe(false)
  })

  test("the typed path splits at its last slash; `~`, `.` and `..` alone name a directory", () => {
    expect(parseBrowse("~/Code/Sy")).toEqual({ head: "~/Code/", partial: "Sy" })
    expect(parseBrowse("~/Code/")).toEqual({ head: "~/Code/", partial: "" })
    expect(parseBrowse("/us")).toEqual({ head: "/", partial: "us" })
    expect(parseBrowse("~")).toEqual({ head: "~/", partial: "" })
    expect(parseBrowse("..")).toEqual({ head: "../", partial: "" })
    expect(parseBrowse("a/b")).toEqual({ head: "a/", partial: "b" })
    expect(expandTyped({ typed: "~/Code", base: "/work", home: HOME })).toBe("/Users/me/Code")
    expect(expandTyped({ typed: "~", base: "/work", home: HOME })).toBe(HOME)
    expect(expandTyped({ typed: "../x", base: "/work/app", home: HOME })).toBe("/work/x")
  })

  test("names rank by prefix, then substring, then fuzzy; hidden ones only for a dotted name", () => {
    const names = ["zeta-app", "App", "my-app", "alpha", "a-p-p", ".git", ".agents", "Apple"]
    expect(rankNames({ names, partial: "app" })).toEqual({ ranked: ["App", "Apple", "my-app", "zeta-app", "a-p-p"], prefixCount: 2 })
    expect(rankNames({ names, partial: "" }).ranked).toEqual(["a-p-p", "alpha", "App", "Apple", "my-app", "zeta-app"])
    expect(rankNames({ names, partial: ".a" }).ranked).toEqual([".agents"])
    expect(rankNames({ names, partial: "qq" }).ranked).toEqual([])
  })

  test("Tab completes one match and enters it, several to their common prefix, then enters the picked one", () => {
    const head = "~/Code/"
    expect(completeTab({ head, partial: "Sym", prefixed: ["Symbex-1"] })).toBe("~/Code/Symbex-1/")
    expect(completeTab({ head, partial: "Me", prefixed: ["MendCodeV2", "MendCodeSpaceNext", "Mend-old"] })).toBe("~/Code/Mend")
    expect(completeTab({ head, partial: "Mend", prefixed: ["MendCodeV2", "MendCodeSpaceNext"], picked: "MendCodeSpaceNext" })).toBe("~/Code/MendCode") // one more letter in common
    expect(completeTab({ head, partial: "MendCode", prefixed: ["MendCodeV2", "MendCodeSpaceNext"], picked: "MendCodeSpaceNext" })).toBe("~/Code/MendCodeSpaceNext/")
    expect(completeTab({ head, partial: "", prefixed: [], picked: "App" })).toBe("~/Code/App/")
    expect(completeTab({ head, partial: "", prefixed: [] })).toBeUndefined()
  })

  test("← goes to the parent of a directory, Backspace takes its last name; the first slash goes alone", () => {
    expect(goUp({ typed: "~/Code/App/", home: HOME })).toBe("~/Code/")
    expect(goUp({ typed: "/usr/", home: HOME })).toBe("/")
    expect(goUp({ typed: "~/", home: HOME })).toBe("/Users/")
    expect(goUp({ typed: "./", home: HOME })).toBe("../")
    expect(goUp({ typed: "../", home: HOME })).toBe("../../")
    expect(goUp({ typed: "/", home: HOME })).toBeUndefined()
    expect(goUp({ typed: "~/Code/Ap", home: HOME })).toBeUndefined()
    expect(eraseBack({ typed: "~/Code/App/", home: HOME })).toBe("~/Code/")
    for (const typed of ["~/", "/", "./", "../", "../../", "~/Code/Ap"]) expect(eraseBack({ typed, home: HOME }), typed).toBeUndefined()
  })

  test("the usual root is the parent most known folders share under home, else home; a name to create needs a real last name", () => {
    expect(usualRoot({ folders: [`${HOME}/Code/a`, `${HOME}/Code/b`, `${HOME}/other/c`, "/srv/x"], home: HOME })).toBe("~/Code/")
    expect(usualRoot({ folders: ["/srv/x"], home: HOME })).toBe("~/")
    expect(usualRoot({ folders: [`${HOME}/solo`], home: HOME })).toBe("~/")
    expect(nameToCreate("~/Code/new")).toBe("new")
    expect(nameToCreate("~/Code/new/")).toBe("new")
    for (const typed of ["~", "..", "./", "/"]) expect(nameToCreate(typed), typed).toBeUndefined()
  })
})

describe("the rows of a typed path and of the known folders", () => {
  const FOLDERS = ["/work/app", `${HOME}/Code/api`, "/home/dev/hub-only"]

  test("`Browse folders…` follows the open folder, shows the root, and goes once something is typed; a hub folder carries its hub", () => {
    const rows = folderChoices({ folders: FOLDERS, opened: "/work/app", query: "", home: HOME, browseRoot: "~/Code/", hub: { name: "my-hub", folders: new Set(["/home/dev/hub-only"]) } })
    expect(rows.map((row) => [row.label, row.kind, row.hub])).toEqual([["app", "open", undefined], ["Browse folders…", "browse", undefined], ["api", "known", undefined], ["hub-only", "known", "my-hub"]])
    expect(rows[1]).toMatchObject({ typed: "~/Code/", detail: "~/Code/" })
    expect(folderChoices({ folders: FOLDERS, opened: "/work/app", query: "a", home: HOME, browseRoot: "~/Code/" }).some((row) => row.kind === "browse")).toBe(false)
    expect(folderChoices({ folders: FOLDERS, query: "", home: HOME, browseRoot: "~/Code/" })[0]!.kind).toBe("browse")
  })

  test("a path lists its directory first, the names that start with the typed one, then the folder to create, then the looser matches", () => {
    const rows = folderChoices({
      folders: FOLDERS, query: "~/Code/ap", home: HOME,
      completions: [{ directory: `${HOME}/Code/api`, typed: "~/Code/api/", git: true }, { directory: `${HOME}/Code/zap`, typed: "~/Code/zap/" }],
      prefixCount: 1, create: `${HOME}/Code/ap`,
    })
    expect(rows.map((row) => [row.label, row.kind, row.git ?? false])).toEqual([["api/", "path", true], ["+ create folder ap", "create", false], ["zap/", "path", false]])
    const here = folderChoices({ folders: [], query: "~/Code", home: HOME, typedDirectory: `${HOME}/Code`, typedGit: true, completions: [{ directory: `${HOME}/Code`, typed: "~/Code/" }] })
    expect(here.map((row) => [row.label, row.here, row.git])).toEqual([["~/Code", true, true]])
  })

  test("with nothing that starts like the name, the folder to create is the first row", () => {
    const rows = folderChoices({ folders: [], query: "~/Code/xy", home: HOME, completions: [{ directory: `${HOME}/Code/oxygen`, typed: "~/Code/oxygen/" }], prefixCount: 0, create: `${HOME}/Code/xy` })
    expect(rows.map((row) => row.kind)).toEqual(["create", "path"])
  })

  test("the tags at the right end name the hub, the git repositories and the folder to create; the detail line names the hub too", () => {
    const choices = folderChoices({ folders: ["/work/app", "/home/dev/hub-only"], opened: "/work/app", query: "", home: HOME, hub: { name: "my-hub", folders: new Set(["/home/dev/hub-only"]) } })
    const drawn = renderNewChatPicker({ title: "New chat in…", query: "", choices, selected: 1, width: 38, height: 16 }).rows.map(plain)
    expect(drawn.find((row) => row.includes("hub-only"))).toMatch(/hub-only +· my-hub +│$/)
    expect(drawn.join("\n")).toContain("my-hub: /home/dev/hub-only")
    const browsed = folderChoices({ folders: [], query: "~/c/", home: HOME, completions: [{ directory: `${HOME}/c/repo`, typed: "~/c/repo/", git: true }], create: `${HOME}/c/` })
    const text = renderNewChatPicker({ title: "New chat in…", query: "~/c/", choices: browsed, selected: 0, width: 38, height: 16 }).rows.map(plain)
    expect(text.find((row) => row.includes("repo/"))).toMatch(/repo\/ +git +│$/)
    expect(text.find((row) => row.includes("create folder"))).toMatch(/\+ create folder c +new +│$/)
  })

  test("the hint says how to browse until a path is typed, then how to move through folders, and asks for the second Enter", () => {
    const draw = (over: Partial<Parameters<typeof renderNewChatPicker>[0]>) => renderNewChatPicker({ title: "New chat in…", query: "", choices: [], selected: 0, width: 38, height: 16, ...over }).rows.map(plain).join("\n")
    expect(draw({})).toContain("type ~/ or a path to browse")
    expect(draw({})).toContain("tab completes")
    expect(draw({ query: "~/" })).toContain("↵ start  tab complete  → in")
    expect(draw({ query: "~/" })).toContain("← up")
    expect(draw({ query: "~/x", confirming: true })).toContain("↵ again makes the folder")
  })
})

describe("reading a directory", () => {
  const root = mkdtempSync(join(tmpdir(), "mc-browse-"))
  afterAll(() => rmSync(root, { recursive: true, force: true }))

  test("lists folders and links to folders, not files, and nothing for a path that cannot be read", async () => {
    mkdirSync(join(root, "one/sub"), { recursive: true })
    mkdirSync(join(root, "two"))
    writeFileSync(join(root, "file.txt"), "x")
    symlinkSync(join(root, "two"), join(root, "link-to-two"))
    symlinkSync(join(root, "file.txt"), join(root, "link-to-file"))
    expect((await readDirectories(root)).sort()).toEqual(["link-to-two", "one", "two"])
    expect(await readDirectories(join(root, "missing"))).toEqual([])
    expect(await readDirectories(join(root, "file.txt"))).toEqual([])
  })

  test("keeps at most the bound of folders from a very large directory", async () => {
    const big = join(root, "big")
    mkdirSync(big)
    for (let n = 0; n < MAX_DIRECTORIES + 40; n++) mkdirSync(join(big, `d${n}`))
    expect((await readDirectories(big)).length).toBe(MAX_DIRECTORIES)
  })
})

describe("the picker's keys", () => {
  const root = mkdtempSync(join(tmpdir(), "mc-picker-"))
  afterAll(() => rmSync(root, { recursive: true, force: true }))
  const code = join(root, "Code")
  for (const name of ["MendCodeV2", "MendCodeSpaceNext", "Symbex-1", "projects", ".hidden"]) mkdirSync(join(code, name), { recursive: true })
  mkdirSync(join(code, "Symbex-1/.git"))

  function open(over: Partial<PickRequest> = {}) {
    const started: string[] = []
    const said: string[] = []
    const frames = { count: 0 }
    const state = { sidebarFocus: false, sidebarSelected: undefined as string | undefined, page: "chat" }
    const ctx = { state, requestFrame: () => { frames.count++ }, say: (message: string) => { said.push(message) } }
    const picker = createNewChatPicker(ctx as never)
    picker.show({ title: "New chat in…", folders: [join(code, "MendCodeSpaceNext"), "/home/dev/hub-only"], base: root, home: root, remote: false, start: async (directory) => { started.push(directory) }, ...over })
    const type = async (text: string) => { for (const letter of text) await picker.key(letter) }
    const labels = () => picker.choices().map((choice) => choice.label)
    return { picker, started, said, type, labels, state }
  }

  test("a path switches to browsing the directory: subfolders fuzzy-filtered, hidden ones only for a dotted name, git repositories marked", async () => {
    const { picker, type, labels } = open()
    await type("~/Code/")
    expect(labels()).toEqual(["~/Code", "MendCodeSpaceNext/", "MendCodeV2/", "projects/", "Symbex-1/"])
    expect(picker.choices().find((choice) => choice.label === "Symbex-1/")!.git).toBe(true)
    await type("mcv")
    expect(labels()).toEqual(["+ create folder mcv", "MendCodeV2/"])
    await type("\x15")
    await type("~/Code/.")
    expect(labels()).toContain(".hidden/")
  })

  test("Tab completes the common prefix, then the picked folder; → enters it; ← and Backspace go up", async () => {
    const { picker, type } = open()
    await type("~/Co")
    await picker.key("\t")
    expect(picker.query()).toBe("~/Code/")
    await type("Me")
    await picker.key("\t")
    expect(picker.query()).toBe("~/Code/MendCode")
    expect(picker.choices().map((choice) => choice.label)).toEqual(["MendCodeSpaceNext/", "MendCodeV2/", "+ create folder MendCode"])
    await picker.key("\x1b[B")
    await picker.key("\x1b[C")
    expect(picker.query()).toBe("~/Code/MendCodeV2/")
    await picker.key("\x1b[D")
    expect(picker.query()).toBe("~/Code/")
    expect(picker.choices()[picker.choices().findIndex((choice) => choice.label === "MendCodeV2/")]).toBeDefined()
    await type("projects/")
    await picker.key("\x7f")
    expect(picker.query()).toBe("~/Code/")
    await picker.key("\x7f")
    expect(picker.query()).toBe("~/")
    await picker.key("\x7f")
    expect(picker.query()).toBe("~")
  })

  test("Enter starts the chat in the highlighted folder, or in the typed one", async () => {
    const first = open()
    await first.type("~/Code/Sy")
    await first.picker.key("\r")
    expect(first.started).toEqual([join(code, "Symbex-1")])
    expect(first.picker.isOpen()).toBe(false)
    const second = open()
    await second.type("~/Code/projects")
    expect(second.picker.choices()[0]!.here).toBe(true)
    await second.picker.key("\r")
    expect(second.started).toEqual([join(code, "projects")])
  })

  test("a path that does not exist offers `create folder`: the first Enter only asks, any other key cancels, the second makes it and starts there", async () => {
    const { picker, type, started } = open()
    await type("~/Code/fresh/deep")
    expect(picker.choices().map((choice) => choice.kind)).toEqual(["create"])
    await picker.key("\r")
    expect(existsSync(join(code, "fresh"))).toBe(false)
    expect(started).toEqual([])
    await picker.key("\x1b[B")
    await picker.key("\r")
    expect(existsSync(join(code, "fresh"))).toBe(false)
    await picker.key("\r")
    expect(existsSync(join(code, "fresh/deep"))).toBe(true)
    expect(started).toEqual([join(code, "fresh/deep")])
    expect(picker.isOpen()).toBe(false)
  })

  test("Esc while a creation waits only cancels it; a typed name nothing starts like offers the creation before looser matches", async () => {
    const { picker, type, started } = open()
    await type("~/Code/pj")
    expect(picker.choices()[0]!.kind).toBe("create")
    await picker.key("\r")
    await picker.key("\x1b")
    expect(picker.isOpen()).toBe(true)
    expect(existsSync(join(code, "pj"))).toBe(false)
    expect(started).toEqual([])
    await picker.key("\x1b")
    expect(picker.isOpen()).toBe(false)
  })

  test("`Browse folders…` drops into the usual root of the known folders; the hub's folder is marked and starts there; a remote terminal browses nothing", async () => {
    const { picker, started, labels } = open({ hubName: async () => "my-hub" })
    expect(labels().slice(0, 2)).toEqual(["MendCodeSpaceNext", "Browse folders…"])
    for (let turn = 0; turn < 100 && !picker.choices().some((choice) => choice.hub); turn++) await Bun.sleep(10)
    expect(picker.choices().find((choice) => choice.label === "hub-only")!.hub).toBe("my-hub")
    await picker.key("\x1b[B")
    await picker.key("\r")
    expect(picker.query()).toBe("~/Code/")
    expect(picker.choices().map((choice) => choice.label)).toContain("projects/")
    await picker.key("\x15")
    await picker.key("\x1b[B")
    await picker.key("\x1b[B")
    await picker.key("\r")
    expect(started).toEqual(["/home/dev/hub-only"])
    const remote = open({ remote: true })
    expect(remote.labels().some((label) => label.startsWith("Browse"))).toBe(false)
    await remote.type("~/Code/")
    expect(remote.labels()).toEqual([])
  })

  test("no hub is asked about while every listed folder is here", async () => {
    let asked = 0
    open({ folders: [join(code, "projects")], hubName: async () => { asked++; return "never" } })
    await Bun.sleep(20)
    expect(asked).toBe(0)
  })
})
