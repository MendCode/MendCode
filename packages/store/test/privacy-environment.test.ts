import { afterEach, expect, spyOn, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync, linkSync, symlinkSync } from "node:fs"
import * as fs from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { openStore } from "../src"
import { openPrivateDatabase } from "../src/private-database"
import { createBlobFiles } from "../src/blobs"
import { createPrivateFiles } from "../src/private-files"
import { atomicPrivateWrite, createSealedFiles } from "../src/sealed-file"
import type { SessionId } from "@mendcode/protocol"

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })
function setup() {
  const dir = mkdtempSync(path.join(tmpdir(), "mend-privacy-")); dirs.push(dir)
  const store = openStore({ dir })
  const sessionId = "ses_01J00000000000000000000000" as SessionId
  store.createSession({ id: sessionId, directory: "/project", title: "private-title" })
  return { dir, store, sessionId }
}

test("encryption is opt-in, reversible, durable, and includes blobs, drafts and titles", () => {
  const { dir, store, sessionId } = setup()
  const file = path.join(dir, "mendd.db")
  const blob = store.putBlob(Buffer.from("private-attachment"), "text/plain")
  expect(store.privacy.enabled()).toBe(false)
  const transcripts = path.join(dir, "session-transcripts")
  mkdirSync(transcripts)
  const transcript = path.join(transcripts, "session-g1.md")
  writeFileSync(transcript, "private-transcript")
  store.privacy.set(true)
  expect(readFileSync(transcript).includes(Buffer.from("private-transcript"))).toBe(false)
  expect(store.readStoredFile(transcript)?.toString()).toBe("private-transcript")
  store.writeStoredFile(transcript, Buffer.from("updated-private-transcript"))
  expect(readFileSync(transcript).includes(Buffer.from("updated-private-transcript"))).toBe(false)
  expect(readFileSync(file).includes(Buffer.from("private-title"))).toBe(false)
  expect(readFileSync(store.blobPath(blob.sha256)).includes(Buffer.from("private-attachment"))).toBe(false)
  expect(store.readBlob(blob.sha256).toString()).toBe("private-attachment")
  store.renameSession(sessionId, "renamed-private")
  store.drafts.set(sessionId, "private-draft", [])
  expect(readFileSync(file).includes(Buffer.from("private-draft"))).toBe(false)
  expect(existsSync(`${file}-wal`)).toBe(false)
  store.close()
  const abandoned = `${file}.00000000-0000-0000-0000-000000000000.tmp`
  writeFileSync(abandoned, "uncommitted-plaintext-snapshot")
  const reopened = openStore({ dir })
  expect(existsSync(abandoned)).toBe(false)
  expect(reopened.privacy.enabled()).toBe(true)
  expect(reopened.sessionSummary(sessionId)?.title).toBe("renamed-private")
  expect(reopened.drafts.get(sessionId)?.text).toBe("private-draft")
  reopened.privacy.set(false)
  expect(readFileSync(transcript).toString()).toBe("updated-private-transcript")
  expect(readFileSync(reopened.blobPath(blob.sha256)).toString()).toBe("private-attachment")
  reopened.close()
  const plain = new Database(file, { readonly: true })
  expect(plain.query<{ title: string }, []>("SELECT title FROM sessions").get()?.title).toBe("renamed-private")
  plain.close()
})

test("missing or wrong encryption key fails closed, never resets the database", () => {
  const { dir, store } = setup()
  store.privacy.set(true); store.close()
  const key = path.join(dir, "keys", "chats.key")
  const original = readFileSync(key)
  rmSync(key)
  expect(() => openStore({ dir })).toThrow("missing")
  writeFileSync(key, Buffer.alloc(32, 1))
  expect(() => openStore({ dir })).toThrow("authentication")
  writeFileSync(key, original)
  openStore({ dir }).close()
})

test("vault scopes, overwrite, remove and persistence without plaintext credentials", () => {
  const { dir, store, sessionId } = setup()
  for (const scope of ["global", "project", "session"] as const) store.environment.set({ sessionId, directory: "/project", name: "VOICE_API_KEY", value: `${scope}-private-value`, scope })
  expect(store.environment.values(sessionId, "/project").VOICE_API_KEY).toBe("session-private-value")
  expect(store.environment.values("another", "/project").VOICE_API_KEY).toBe("project-private-value")
  expect(store.environment.values("another", "/other").VOICE_API_KEY).toBe("global-private-value")
  expect(JSON.stringify(store.environment.list(sessionId, "/project"))).not.toContain("private-value")
  expect(readFileSync(path.join(dir, "environment.enc")).includes(Buffer.from("private-value"))).toBe(false)
  expect(() => store.environment.set({ sessionId, directory: "/project", name: "BASH_ENV", value: "malicious", scope: "project" })).toThrow()
  store.environment.remove("VOICE_API_KEY", "session", sessionId, "/project")
  store.close()
  const reopened = openStore({ dir })
  expect(reopened.environment.values(sessionId, "/project").VOICE_API_KEY).toBe("project-private-value")
  reopened.close()
})

test("vault bulk validation is atomic and a missing vault key never becomes an empty vault", () => {
  const { dir, store, sessionId } = setup()
  store.environment.set({ sessionId, directory: "/project", name: "API_KEY", value: "original-private-value", scope: "project" })
  expect(() => store.environment.setMany({ API_KEY: "replacement", NEW_API_KEY: "new-value", BASH_ENV: "unsafe" }, { sessionId, directory: "/project", scope: "project" })).toThrow()
  expect(store.environment.values(sessionId, "/project")).toEqual({ API_KEY: "original-private-value" })
  store.close()
  const file = path.join(dir, "environment.enc"), key = path.join(dir, "keys", "environment.key")
  const original = readFileSync(key), before = readFileSync(file)
  rmSync(key)
  const reopened = openStore({ dir })
  expect(() => reopened.environment.list(sessionId, "/project")).toThrow("missing")
  expect(existsSync(key)).toBe(false)
  expect(readFileSync(file)).toEqual(before)
  writeFileSync(key, original)
  expect(reopened.environment.values(sessionId, "/project").API_KEY).toBe("original-private-value")
  reopened.close()
})


test("opening and converting ignores foreign blob entries, links and unfinished writes", () => {
  const { dir, store } = setup()
  const blob = store.putBlob(Buffer.from("attachment"), "text/plain")
  const target = store.blobPath(blob.sha256)
  store.close()
  const root = path.join(dir, "blobs")
  const foreign = path.join(root, "foreign")
  mkdirSync(foreign)
  writeFileSync(path.join(foreign, "f".repeat(64)), "foreign blob")
  const untouched = [path.join(root, "attachment"), path.join(root, "aa"), `${target}.interrupted.tmp`, path.join(foreign, "notes.tmp")]
  for (const file of untouched) writeFileSync(file, "keep")
  const shard = path.dirname(target)
  mkdirSync(path.join(shard, blob.sha256.slice(0, 2) + "0".repeat(62)))
  writeFileSync(path.join(shard, "ff" + "1".repeat(62)), "wrong shard")
  const linked = path.join(shard, blob.sha256.slice(0, 2) + "2".repeat(62))
  symlinkSync(untouched[0]!, linked)
  linkSync(untouched[0]!, path.join(shard, blob.sha256.slice(0, 2) + "3".repeat(62)))
  symlinkSync(foreign, path.join(root, "bb"))
  const reopened = openStore({ dir })
  try {
    reopened.privacy.set(true)
    expect(reopened.readBlob(blob.sha256).toString()).toBe("attachment")
    reopened.privacy.set(false)
    expect(readFileSync(target).toString()).toBe("attachment")
    for (const file of untouched) expect(readFileSync(file).toString()).toBe("keep")
    expect(readFileSync(linked).toString()).toBe("keep")
    expect(readFileSync(path.join(shard, "ff" + "1".repeat(62))).toString()).toBe("wrong shard")
  } finally { reopened.close() }
})

test("private file conversion ignores non-directory roots, foreign directories, links and tmp files", () => {
  const { dir, store } = setup()
  writeFileSync(path.join(dir, "session-transcripts"), "foreign root")
  const root = path.join(dir, "tool-output")
  mkdirSync(root)
  mkdirSync(path.join(root, "foreign.tmp"))
  const file = path.join(root, "output.txt")
  const temp = `${file}.interrupted.tmp`
  writeFileSync(file, "output")
  writeFileSync(temp, "unfinished")
  symlinkSync(file, path.join(root, "link"))
  symlinkSync(root, path.join(dir, "goals"))
  try {
    store.privacy.set(true)
    expect(store.readStoredFile(file)?.toString()).toBe("output")
    expect(readFileSync(temp).toString()).toBe("unfinished")
    expect(readFileSync(path.join(dir, "session-transcripts")).toString()).toBe("foreign root")
    store.privacy.set(false)
    expect(readFileSync(file).toString()).toBe("output")
  } finally { store.close() }
})


test("failed authentication preserves each stored file and partial conversion can resume", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "mend-convert-")); dirs.push(dir)
  let enabled = true
  const privacy = { enabled: () => enabled, sealed: createSealedFiles(dir, "chats", () => false) }
  const blobs = createBlobFiles(path.join(dir, "blobs"), privacy)
  const first = blobs.write(Buffer.from("first"), "text/plain")
  const second = blobs.write(Buffer.from("second"), "text/plain")
  const root = path.join(dir, "tool-output")
  mkdirSync(root)
  const file = path.join(root, "output.txt")
  const files = createPrivateFiles(dir, privacy)
  files.write(file, Buffer.from("output"))
  const originals = [blobs.pathOf(first.sha256), blobs.pathOf(second.sha256), file].map((file) => [file, readFileSync(file)] as const)
  enabled = false
  const wrongDir = path.join(dir, "wrong")
  const wrong = { enabled: () => enabled, sealed: createSealedFiles(wrongDir, "chats", () => false) }
  const damagedBlobs = createBlobFiles(path.join(dir, "blobs"), wrong)
  const damagedFiles = createPrivateFiles(dir, wrong)
  damagedBlobs.convert()
  damagedFiles.convert()
  expect(damagedBlobs.unreadable.size).toBe(2)
  expect(damagedFiles.unreadable.size).toBe(1)
  expect(() => damagedBlobs.read(first.sha256)).toThrow("authentication")
  for (const [file, bytes] of originals) expect(readFileSync(file)).toEqual(bytes)
  // A stopped conversion may have committed one file while the others are still sealed.
  atomicPrivateWrite(blobs.pathOf(first.sha256), Buffer.from("first"))
  blobs.convert()
  files.convert()
  expect(blobs.read(first.sha256).toString()).toBe("first")
  expect(blobs.read(second.sha256).toString()).toBe("second")
  expect(readFileSync(file).toString()).toBe("output")
})

test("a replacement that cannot be renamed leaves the original target intact", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "mend-atomic-")); dirs.push(dir)
  const target = path.join(dir, "target")
  mkdirSync(target)
  writeFileSync(path.join(target, "original"), "keep")
  expect(() => atomicPrivateWrite(target, Buffer.from("replacement"))).toThrow()
  expect(readFileSync(path.join(target, "original")).toString()).toBe("keep")
})


test("an unreadable blob is not replaced or discarded by conversion", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "mend-unreadable-")); dirs.push(dir)
  let enabled = false
  const privacy = { enabled: () => enabled, sealed: createSealedFiles(dir, "chats", () => false) }
  const blobs = createBlobFiles(path.join(dir, "blobs"), privacy)
  const blob = blobs.write(Buffer.from("original"), "text/plain")
  const file = blobs.pathOf(blob.sha256)
  enabled = true
  const read = fs.readFileSync
  const blocked = spyOn(fs, "readFileSync").mockImplementation(((...args: Parameters<typeof read>) => {
    if (args[0] === file) throw Object.assign(new Error("cannot open blob"), { code: "EACCES" })
    return read(...args)
  }) as typeof read)
  try { blobs.convert(true); expect(blobs.unreadable.has(file)).toBe(true) }
  finally { blocked.mockRestore() }
  expect(readFileSync(file).toString()).toBe("original")
})

test("damaged blobs and private files do not block open or conversion and warn once per file", () => {
  const { dir, store } = setup()
  const bad = store.putBlob(Buffer.from("damaged attachment"), "text/plain")
  const good = store.putBlob(Buffer.from("healthy attachment"), "text/plain")
  const root = path.join(dir, "tool-output")
  mkdirSync(root)
  const file = path.join(root, "damaged.txt"), healthy = path.join(root, "healthy.txt")
  writeFileSync(file, "damaged output"); writeFileSync(healthy, "healthy output")
  store.privacy.set(true)
  const broken = [store.blobPath(bad.sha256), file]
  const originals = broken.map((file) => {
    const bytes = readFileSync(file); bytes[bytes.length - 1]! ^= 1; writeFileSync(file, bytes)
    return bytes
  })
  store.privacy.set(true)
  store.close()
  const warnings: string[] = []
  const reopened = openStore({ dir, warn: (message) => warnings.push(message) })
  try {
    expect(reopened.privacy.status()).toEqual({ enabled: false, target: true, pending: 2, unreadable: broken })
    expect(warnings).toEqual(broken.map((file) => `[PRIVACY]: unreadable ${JSON.stringify(file)}`))
    expect(() => reopened.readBlob(bad.sha256)).toThrow("authentication")
    expect(reopened.readBlob(good.sha256).toString()).toBe("healthy attachment")
    reopened.privacy.set(false)
    expect(reopened.privacy.status().pending).toBe(2)
    expect(readFileSync(healthy).toString()).toBe("healthy output")
    expect(readFileSync(reopened.blobPath(good.sha256)).toString()).toBe("healthy attachment")
    for (const [index, file] of broken.entries()) expect(readFileSync(file)).toEqual(originals[index]!)
  } finally { reopened.close() }
})

test("open isolates injected read failures in blobs and private files without changing bytes", () => {
  const { dir, store } = setup()
  const blob = store.putBlob(Buffer.from("keep attachment"), "text/plain")
  const file = path.join(dir, "tool-output", "output.txt")
  mkdirSync(path.dirname(file)); writeFileSync(file, "keep output")
  store.privacy.set(true)
  const files = [store.blobPath(blob.sha256), file]
  const originals = files.map((file) => readFileSync(file))
  const read = fs.readFileSync
  const blocked = spyOn(fs, "readFileSync").mockImplementation(((...args: Parameters<typeof read>) => {
    if (files.includes(String(args[0]))) throw Object.assign(new Error("cannot read stored file"), { code: "EACCES" })
    return read(...args)
  }) as typeof read)
  let reopened: ReturnType<typeof openStore> | undefined
  try {
    store.privacy.set(true)
    store.close()
    reopened = openStore({ dir })
    expect(reopened.privacy.status().unreadable).toEqual(files)
    expect(() => reopened!.readBlob(blob.sha256)).toThrow("cannot read stored file")
  } finally { blocked.mockRestore(); reopened?.close() }
  for (const [index, file] of files.entries()) expect(readFileSync(file)).toEqual(originals[index]!)
})

for (const enabled of [true, false]) test(`failed file replacements resume on open toward ${enabled ? "encrypted" : "plain"}`, () => {
  const { dir, store } = setup()
  const blob = store.putBlob(Buffer.from("resume attachment"), "text/plain")
  const file = path.join(dir, "tool-output", "output.txt")
  mkdirSync(path.dirname(file)); writeFileSync(file, "resume output")
  if (!enabled) store.privacy.set(true)
  const files = [store.blobPath(blob.sha256), file]
  const originals = files.map((file) => readFileSync(file))
  const rename = fs.renameSync
  const blocked = spyOn(fs, "renameSync").mockImplementation((...args) => {
    if (files.includes(String(args[1]))) throw new Error("replacement blocked")
    return rename(...args)
  })
  try {
    store.privacy.set(enabled)
    expect(store.privacy.status()).toEqual({ enabled: false, target: enabled, pending: 2, unreadable: [] })
  } finally { blocked.mockRestore() }
  for (const [index, file] of files.entries()) expect(readFileSync(file)).toEqual(originals[index]!)
  store.close()
  const reopened = openStore({ dir })
  try {
    expect(reopened.privacy.status()).toEqual({ enabled, target: enabled, pending: 0, unreadable: [] })
    expect(reopened.readBlob(blob.sha256).toString()).toBe("resume attachment")
    expect(reopened.readStoredFile(file)?.toString()).toBe("resume output")
  } finally { reopened.close() }
})

test("magic-prefixed plaintext blobs remain readable and convert both ways", () => {
  const { dir, store } = setup()
  const bytes = Buffer.from("MENDENC1plaintext, not a sealed file")
  const blob = store.putBlob(bytes, "text/plain")
  expect(store.readBlob(blob.sha256)).toEqual(bytes)
  store.close()
  const reopened = openStore({ dir })
  try {
    expect(reopened.readBlob(blob.sha256)).toEqual(bytes)
    reopened.privacy.set(true)
    expect(reopened.privacy.status().pending).toBe(0)
    expect(reopened.readBlob(blob.sha256)).toEqual(bytes)
    expect(readFileSync(reopened.blobPath(blob.sha256))).not.toEqual(bytes)
    reopened.privacy.set(false)
    expect(readFileSync(reopened.blobPath(blob.sha256))).toEqual(bytes)
    expect(reopened.readBlob(blob.sha256)).toEqual(bytes)
  } finally { reopened.close() }
})

test("plain opens and ordinary blob reads do not add full file reads, hashes or replacements", () => {
  const { dir, store } = setup()
  const blob = store.putBlob(Buffer.from("plain attachment"), "text/plain")
  const file = path.join(dir, "tool-output", "output.txt")
  mkdirSync(path.dirname(file)); writeFileSync(file, "plain output")
  const files = [store.blobPath(blob.sha256), file]
  store.close()
  const read = fs.readFileSync, rename = fs.renameSync
  const reads: string[] = [], replacements: string[] = []
  const readSpy = spyOn(fs, "readFileSync").mockImplementation(((...args: Parameters<typeof read>) => { reads.push(String(args[0])); return read(...args) }) as typeof read)
  const renameSpy = spyOn(fs, "renameSync").mockImplementation((...args) => { replacements.push(String(args[1])); return rename(...args) })
  const hash = spyOn(Bun.CryptoHasher.prototype, "update")
  let reopened: ReturnType<typeof openStore> | undefined
  try {
    reopened = openStore({ dir })
    expect(reads.filter((file) => files.includes(file))).toEqual([])
    expect(replacements).toEqual([])
    expect(hash).not.toHaveBeenCalled()
    expect(reopened.readBlob(blob.sha256).toString()).toBe("plain attachment")
    expect(hash).not.toHaveBeenCalled()
  } finally { readSpy.mockRestore(); renameSpy.mockRestore(); hash.mockRestore(); reopened?.close() }
})

test("encrypted clean opens read only file headers, do not hash or write meta; normal reads do not hash", () => {
  const { dir, store } = setup()
  const blob = store.putBlob(Buffer.from("encrypted attachment"), "text/plain")
  const file = path.join(dir, "tool-output", "output.txt")
  mkdirSync(path.dirname(file)); writeFileSync(file, "encrypted output")
  store.privacy.set(true)
  const files = [store.blobPath(blob.sha256), file]
  store.close()
  expect(conversionMarker(dir)).toBeUndefined()
  const read = fs.readFileSync, run = Database.prototype.run
  const reads: string[] = [], metaWrites: string[] = []
  const readSpy = spyOn(fs, "readFileSync").mockImplementation(((...args: Parameters<typeof read>) => {
    reads.push(String(args[0])); return read(...args)
  }) as typeof read)
  const runSpy = spyOn(Database.prototype, "run").mockImplementation(function(this: Database, ...args: Parameters<typeof run>) {
    const result = run.apply(this, args)
    if (/^(INSERT|UPDATE|DELETE).*\bmeta\b/i.test(String(args[0])) && this.query<{ count: number }, []>("SELECT changes() AS count").get()!.count) metaWrites.push(String(args[0]))
    return result
  })
  const hash = spyOn(Bun.CryptoHasher.prototype, "update")
  let reopened: ReturnType<typeof openStore> | undefined
  try {
    reopened = openStore({ dir })
    expect(reads.filter((file) => files.includes(file))).toEqual([])
    expect(hash).not.toHaveBeenCalled()
    expect(metaWrites).toEqual([])
    expect(reopened.privacy.status()).toEqual({ enabled: true, target: true, pending: 0, unreadable: [] })
    expect(reopened.readBlob(blob.sha256).toString()).toBe("encrypted attachment")
    expect(hash).not.toHaveBeenCalled()
  } finally { readSpy.mockRestore(); runSpy.mockRestore(); hash.mockRestore(); reopened?.close() }
})

test("ON reads fall back to hashes for plaintext and reject damaged headers", () => {
  const { dir, store } = setup()
  const bytes = Buffer.from("MENDENC1plaintext long enough to attempt authentication")
  const blob = store.putBlob(bytes, "text/plain")
  store.privacy.set(true)
  const file = store.blobPath(blob.sha256), sealed = readFileSync(file)
  try {
    writeFileSync(file, bytes)
    expect(store.readBlob(blob.sha256)).toEqual(bytes)
    const damaged = Buffer.from(sealed); damaged[0]! ^= 1
    writeFileSync(file, damaged)
    expect(() => store.readBlob(blob.sha256)).toThrow("authentication")
  } finally { writeFileSync(file, sealed); store.close() }
})

test("a mismatched header on ON open starts conversion and checks earlier damaged files", () => {
  const { dir, store } = setup()
  const blob = store.putBlob(Buffer.from("attachment"), "text/plain")
  const file = path.join(dir, "tool-output", "output.txt")
  mkdirSync(path.dirname(file)); writeFileSync(file, "output")
  store.privacy.set(true)
  const blobFile = store.blobPath(blob.sha256), damaged = readFileSync(blobFile)
  damaged[damaged.length - 1]! ^= 1
  writeFileSync(blobFile, damaged)
  writeFileSync(file, "late plaintext")
  store.close()
  const reopened = openStore({ dir })
  try {
    expect(reopened.privacy.status().unreadable).toEqual([blobFile])
    expect(reopened.readStoredFile(file)?.toString()).toBe("late plaintext")
    expect(readFileSync(file).subarray(0, 8).toString()).toBe("MENDENC1")
    expect(readFileSync(blobFile)).toEqual(damaged)
  } finally { reopened.close() }
  expect(conversionMarker(dir)).toEqual({ target: true, scanned: true, blobs: [blob.sha256], files: [] })
})

for (const enabled of [false, true]) test(`conversion markers restore every synchronous mode with encryption ${enabled}`, () => {
  const { store } = setup()
  const run = Database.prototype.run
  let connection: Database | undefined
  const spy = spyOn(Database.prototype, "run").mockImplementation(function(this: Database, ...args: Parameters<typeof run>) {
    connection = this
    return run.apply(this, args)
  })
  try {
    store.privacy.set(enabled)
    for (const mode of [0, 1, 2, 3]) {
      connection!.run(`PRAGMA synchronous = ${mode}`)
      store.privacy.set(enabled)
      expect(connection!.query<{ synchronous: number }, []>("PRAGMA synchronous").get()!.synchronous).toBe(mode)
    }
  } finally { spy.mockRestore(); store.close() }
})

test("open removes only owned single-link temporaries with readable final files", () => {
  const { dir, store } = setup()
  const blob = store.putBlob(Buffer.from("valid attachment"), "text/plain")
  const file = path.join(dir, "tool-output", "output.txt")
  mkdirSync(path.dirname(file)); writeFileSync(file, "valid output")
  store.privacy.set(true)
  const valid = [store.blobPath(blob.sha256), file, path.join(dir, "mendd.db")]
  store.close()
  const uuid = "01234567-89ab-cdef-0123-456789abcdef"
  const removed: string[] = [], kept: string[] = []
  for (const target of valid) {
    const own = `${target}.${uuid}.tmp`; writeFileSync(own, "partial"); removed.push(own)
    const foreign = `${target}.notes.tmp`; writeFileSync(foreign, "keep"); kept.push(foreign)
    const malformed = `${target}.${"-".repeat(36)}.tmp`; writeFileSync(malformed, "keep"); kept.push(malformed)
    const linked = `${target}.11111111-1111-1111-1111-111111111111.tmp`
    linkSync(foreign, linked); kept.push(linked)
    const symlink = `${target}.22222222-2222-2222-2222-222222222222.tmp`
    symlinkSync(foreign, symlink); kept.push(symlink)
    mkdirSync(`${target}.33333333-3333-3333-3333-333333333333.tmp`)
  }
  const missing = path.join(path.dirname(file), `missing.txt.${uuid}.tmp`)
  writeFileSync(missing, "keep"); kept.push(missing)
  const damaged = path.join(path.dirname(file), "damaged.txt")
  writeFileSync(damaged, "MENDENC1invalid")
  const damagedTemp = `${damaged}.${uuid}.tmp`; writeFileSync(damagedTemp, "keep"); kept.push(damagedTemp)
  const missingBlob = path.join(path.dirname(valid[0]!), `${blob.sha256.slice(0, 2)}${"0".repeat(62)}.${uuid}.tmp`)
  writeFileSync(missingBlob, "keep"); kept.push(missingBlob)
  const reopened = openStore({ dir })
  try {
    for (const file of removed) expect(existsSync(file)).toBe(false)
    for (const file of kept) expect(readFileSync(file).toString()).toBe("keep")
    expect(readFileSync(damaged).toString()).toBe("MENDENC1invalid")
    for (const target of valid) expect(fs.lstatSync(`${target}.33333333-3333-3333-3333-333333333333.tmp`).isDirectory()).toBe(true)
  } finally { reopened.close() }
})

test("database temporaries survive when the existing database cannot authenticate", () => {
  const { dir, store } = setup()
  store.privacy.set(true); store.close()
  const file = path.join(dir, "mendd.db")
  const damaged = readFileSync(file); damaged[damaged.length - 1]! ^= 1; writeFileSync(file, damaged)
  const temp = `${file}.01234567-89ab-cdef-0123-456789abcdef.tmp`
  writeFileSync(temp, "recoverable snapshot")
  expect(() => openStore({ dir })).toThrow("authentication")
  expect(readFileSync(file)).toEqual(damaged)
  expect(readFileSync(temp).toString()).toBe("recoverable snapshot")
})

test("a failed temporary fsync leaves original bytes intact", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "mend-fsync-")); dirs.push(dir)
  const file = path.join(dir, "output.txt")
  writeFileSync(file, "original")
  const blocked = spyOn(fs, "fsyncSync").mockImplementation(() => { throw new Error("fsync failed") })
  try { expect(() => atomicPrivateWrite(file, Buffer.from("replacement"))).toThrow("fsync failed") }
  finally { blocked.mockRestore() }
  expect(readFileSync(file).toString()).toBe("original")
})

test("conversion does not follow a linked blobs root", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "mend-linked-")); dirs.push(dir)
  const foreign = createBlobFiles(path.join(dir, "foreign"))
  const blob = foreign.write(Buffer.from("foreign"), "text/plain")
  const root = path.join(dir, "blobs")
  symlinkSync(path.join(dir, "foreign"), root)
  createBlobFiles(root, { enabled: () => true, sealed: createSealedFiles(dir, "chats", () => false) }).convert()
  expect(readFileSync(foreign.pathOf(blob.sha256)).toString()).toBe("foreign")
})

function conversionMarker(dir: string) {
  const { db } = openPrivateDatabase(dir, path.join(dir, "mendd.db"))
  try {
    const row = db.query<{ value: string }, []>("SELECT value FROM meta WHERE key = 'privacy_conversion'").get()
    return row ? JSON.parse(row.value) : undefined
  } finally { db.close() }
}

for (const repair of [true, false]) test(`damaged blob header stays pending across OFF opens until ${repair ? "repaired" : "removed"}`, () => {
  const { dir, store } = setup()
  const bytes = Buffer.from("recover my attachment")
  const blob = store.putBlob(bytes, "text/plain")
  const good = store.putBlob(Buffer.from("healthy attachment"), "text/plain")
  store.privacy.set(true)
  const file = store.blobPath(blob.sha256), healthy = store.blobPath(good.sha256)
  const sealed = readFileSync(file)
  const damaged = Buffer.from(sealed); damaged[0]! ^= 1; writeFileSync(file, damaged)
  store.privacy.set(false)
  expect(store.privacy.status()).toEqual({ enabled: false, target: false, pending: 1, unreadable: [file] })
  store.close()
  expect(conversionMarker(dir)).toEqual({ target: false, scanned: true, blobs: [blob.sha256], files: [] })
  for (let attempt = 0; attempt < 2; attempt++) {
    const read = fs.readFileSync, reads: string[] = []
    const spy = spyOn(fs, "readFileSync").mockImplementation(((...args: Parameters<typeof read>) => {
      reads.push(String(args[0])); return read(...args)
    }) as typeof read)
    let reopened: ReturnType<typeof openStore> | undefined
    try {
      reopened = openStore({ dir })
      expect(reopened.privacy.status().pending).toBe(1)
      expect(reopened.privacy.status().unreadable).toEqual([file])
      expect(reads.filter((name) => name === file)).toHaveLength(1)
      expect(reads).not.toContain(healthy)
      expect(() => reopened!.readBlob(blob.sha256)).toThrow("authentication")
    } finally { spy.mockRestore(); reopened?.close() }
    expect(readFileSync(file)).toEqual(damaged)
  }
  if (repair) writeFileSync(file, sealed)
  else rmSync(file)
  const resolved = openStore({ dir })
  try {
    expect(resolved.privacy.status()).toEqual({ enabled: false, target: false, pending: 0, unreadable: [] })
    if (repair) expect(readFileSync(file)).toEqual(bytes)
  } finally { resolved.close() }
  expect(conversionMarker(dir)).toBeUndefined()
})

for (const target of [true, false]) for (const phase of ["before-files", "before-clear"]) test(`crash ${phase} resumes conversion to ${target}`, () => {
  const { dir, store } = setup()
  const blob = store.putBlob(Buffer.from("crash-safe attachment"), "text/plain")
  const file = path.join(dir, "tool-output", "output.txt")
  mkdirSync(path.dirname(file)); writeFileSync(file, "crash-safe output")
  if (!target) store.privacy.set(true)
  const blobFile = store.blobPath(blob.sha256)
  const originals = [blobFile, file].map((name) => readFileSync(name))
  store.close()
  const child = Bun.spawnSync([process.execPath, "-e", `
    import { Database } from "bun:sqlite"
    import { openStore } from ${JSON.stringify(path.resolve(import.meta.dir, "../src/store.ts"))}
    const store = openStore({ dir: ${JSON.stringify(dir)} })
    const run = Database.prototype.run
    let marked = false
    Database.prototype.run = function(sql, ...args) {
      if (${JSON.stringify(phase)} === "before-clear" && sql === "DELETE FROM meta WHERE key = 'privacy_conversion'") process.exit(77)
      if (${JSON.stringify(phase)} === "before-files" && marked && /^PRAGMA synchronous = [0-3]$/.test(sql)) process.exit(77)
      const result = run.call(this, sql, ...args)
      if (sql.startsWith("INSERT OR REPLACE INTO meta(key, value) VALUES ('privacy_conversion'")) marked = true
      return result
    }
    store.privacy.set(${target})
    process.exit(1)
  `], { stdout: "pipe", stderr: "pipe" })
  expect(child.exitCode).toBe(77)
  expect(conversionMarker(dir)).toEqual({ target, scanned: false, blobs: [], files: [] })
  if (phase === "before-files") for (const [i, name] of [blobFile, file].entries()) expect(readFileSync(name)).toEqual(originals[i]!)
  else for (const name of [blobFile, file]) expect(readFileSync(name).subarray(0, 8).toString() === "MENDENC1").toBe(target)
  const reopened = openStore({ dir })
  try {
    expect(reopened.privacy.status()).toEqual({ enabled: target, target, pending: 0, unreadable: [] })
    expect(reopened.readBlob(blob.sha256).toString()).toBe("crash-safe attachment")
    expect(reopened.readStoredFile(file)?.toString()).toBe("crash-safe output")
  } finally { reopened.close() }
  expect(conversionMarker(dir)).toBeUndefined()
})

test("listed private files retry without reading healthy files and leave the marker after repair", () => {
  const { dir, store } = setup()
  const file = path.join(dir, "tool-output", "bad.txt"), healthy = path.join(dir, "tool-output", "good.txt")
  mkdirSync(path.dirname(file)); writeFileSync(file, "bad output"); writeFileSync(healthy, "good output")
  store.privacy.set(true)
  const original = readFileSync(file), broken = Buffer.from(original)
  broken[broken.length - 1]! ^= 1; writeFileSync(file, broken)
  store.privacy.set(false); store.close()
  expect(conversionMarker(dir)).toEqual({ target: false, scanned: true, blobs: [], files: ["tool-output/bad.txt"] })
  const read = fs.readFileSync
  const spy = spyOn(fs, "readFileSync").mockImplementation(((...args: Parameters<typeof read>) => {
    if (String(args[0]) === healthy) throw new Error("healthy file must not be read")
    return read(...args)
  }) as typeof read)
  let reopened: ReturnType<typeof openStore> | undefined
  try {
    reopened = openStore({ dir })
    expect(reopened.privacy.status().unreadable).toEqual([file])
    expect(reopened.privacy.status().pending).toBe(1)
  } finally { spy.mockRestore(); reopened?.close() }
  expect(readFileSync(file)).toEqual(broken)
  writeFileSync(file, original)
  const resolved = openStore({ dir })
  try { expect(resolved.privacy.status().pending).toBe(0); expect(readFileSync(file).toString()).toBe("bad output") }
  finally { resolved.close() }
  expect(conversionMarker(dir)).toBeUndefined()
})
