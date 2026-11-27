import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createUploads, uploadsDir } from "../src/sync/uploads"

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

const put = (uploads: ReturnType<typeof createUploads>, holder: string, body: string, offset: number, size: number) =>
  uploads.put(holder, { op: "file-put", sessionId: "ses_a" as never, name: "notes.txt", size, offset, data: Buffer.from(body).toString("base64") } as never)

test("two devices sending the same name at the same time each get their own complete file", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "mendtest-uploads-"))
  dirs.push(dir)
  const uploads = createUploads(dir)
  // A and B start together; B's first piece arrives between A's two.
  await put(uploads, "laptop", "AAAA", 0, 8)
  await put(uploads, "phone", "BBBB", 0, 8)
  const a = await put(uploads, "laptop", "aaaa", 4, 8)
  const b = await put(uploads, "phone", "bbbb", 4, 8)
  expect(a.stored && b.stored).toBe(true)
  expect(readFileSync(a.path!, "utf8")).toBe("AAAAaaaa")
  expect(readFileSync(b.path!, "utf8")).toBe("BBBBbbbb")
  expect(a.path).not.toBe(b.path)
  expect(readdirSync(uploadsDir(dir, "ses_a")).filter((entry) => entry.endsWith(".part"))).toEqual([])
})
