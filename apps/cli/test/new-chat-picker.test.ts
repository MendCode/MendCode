import { afterEach, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createNewChatPicker, type PickRequest } from "../src/ui/app/new-chat-picker"
import type { AppContext } from "../src/ui/app/context"

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })
const temp = () => { const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "mend-picker-"))); dirs.push(dir); return dir }

function setup(folders: string[], over: Partial<PickRequest> = {}) {
  const started: string[] = []
  const state = { sidebarFocus: true, page: "chat" } as Record<string, unknown>
  const ctx = { state, requestFrame() {}, say() {} } as unknown as AppContext
  const picker = createNewChatPicker(ctx)
  const request: PickRequest = { title: "New chat in…", folders, base: folders[0] ?? "/", home: "/nonexistent-home", remote: false, async start(directory) { started.push(directory) }, ...over }
  return { picker, request, started }
}

test("Enter right after a pasted path starts in the pasted folder, not in the row of the query before it", async () => {
  const open = temp()
  const target = temp()
  const { picker, request, started } = setup([open])
  picker.show(request)
  await picker.key("\x0e")
  picker.paste(target)
  await picker.key("\r")
  expect(started).toEqual([target])
})

test("clicking a creation row that is not the picked one picks it first, so its confirmation shows and the next click makes the folder", async () => {
  const root = temp()
  mkdirSync(path.join(root, "api"))
  const { picker, request, started } = setup([root])
  picker.show(request)
  picker.paste(`${root}/ap`)
  await picker.key("\x0e")
  await picker.key("\x10")
  const index = picker.choices().findIndex((choice) => choice.kind === "create")
  expect(index).toBeGreaterThan(0)
  await picker.activate(`pick:${index}`)
  expect(started).toEqual([])
  await picker.activate(`pick:${index}`)
  expect(started).toEqual([path.join(root, "ap")])
})

test("only folders that hold a chat the hub owns are marked with the hub's name, and only when they are missing here", async () => {
  const here = temp()
  const gone = path.join(temp(), "deleted-project")
  const mirrored = path.join(temp(), "hub-project")
  const { picker, request } = setup([here, gone, mirrored], { hubFolders: new Set([mirrored]), hubName: async () => "vps" })
  picker.show(request)
  await Bun.sleep(30)
  const rows = picker.choices()
  expect(rows.find((choice) => choice.directory === mirrored)?.hub).toBe("vps")
  expect(rows.find((choice) => choice.directory === gone)?.hub).toBeFalsy()
})
