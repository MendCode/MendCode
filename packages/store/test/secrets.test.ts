import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createIdFactory, type SessionId } from "@mendcode/protocol"
import { MAX_SECRETS_PER_SESSION, openStore, SecretsError, secretsKeyPath, secretTail } from "../src"

const dirs: string[] = []
function tempDir() {
  const dir = mkdtempSync(path.join(tmpdir(), "mend-secrets-"))
  dirs.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const ids = createIdFactory()
const VALUE = "hunter2-" + "fake-value-for-tests"

function open(dir: string) {
  const store = openStore({ dir })
  const sessionId = ids("session")
  store.createSession({ id: sessionId, directory: "/repo", title: "t" })
  return { store, sessionId }
}

/** Every byte the store keeps on disk (database, WAL, blobs, key folder excluded) as one buffer. */
function databaseBytes(dir: string) {
  return Buffer.concat(readdirSync(dir).filter((name) => name.startsWith("mendd.db")).map((name) => readFileSync(path.join(dir, name))))
}

describe("secrets store", () => {
  test("the same value in a session is the same number and another value gets the next one", () => {
    const { store, sessionId } = open(tempDir())
    expect(store.secrets.add({ sessionId, kind: "password", value: VALUE })).toEqual({ n: 1, created: true })
    expect(store.secrets.add({ sessionId, kind: "password", value: VALUE })).toEqual({ n: 1, created: false })
    expect(store.secrets.add({ sessionId, kind: "token", value: `${VALUE}-2` })).toEqual({ n: 2, created: true })
    expect(store.secrets.list(sessionId)).toMatchObject([
      { n: 1, kind: "password", tail: "ests" },
      { n: 2, kind: "token", tail: "ts-2" },
    ])
    store.close()
  })

  test("numbers are per session", () => {
    const { store, sessionId } = open(tempDir())
    const other = ids("session")
    store.createSession({ id: other, directory: "/repo", title: "t" })
    store.secrets.add({ sessionId, kind: "password", value: VALUE })
    expect(store.secrets.add({ sessionId: other, kind: "password", value: `${VALUE}-other` }).n).toBe(1)
    store.close()
  })

  test("the value is nowhere in the database files and survives a restart", () => {
    const dir = tempDir()
    const first = open(dir)
    first.store.secrets.add({ sessionId: first.sessionId, kind: "password", value: VALUE })
    // Before the checkpoint the value could sit in the WAL; after it, in the main file.
    expect(databaseBytes(dir).includes(VALUE)).toBe(false)
    first.store.close()
    expect(databaseBytes(dir).includes(VALUE)).toBe(false)

    const store = openStore({ dir })
    expect(store.secrets.values(first.sessionId)).toEqual([{ n: 1, kind: "password", value: VALUE }])
    expect(store.secrets.reveal(first.sessionId, 1)).toBe(VALUE)
    expect(store.secrets.reveal(first.sessionId, 2)).toBeUndefined()
    store.close()
  })

  test("the key is 32 random bytes in keys/secrets.key, mode 0600 in a 0700 folder, created on first use", () => {
    const dir = tempDir()
    const { store, sessionId } = open(dir)
    expect(existsSync(secretsKeyPath(dir))).toBe(false)
    store.secrets.add({ sessionId, kind: "password", value: VALUE })
    expect(statSync(secretsKeyPath(dir)).mode & 0o777).toBe(0o600)
    expect(statSync(path.dirname(secretsKeyPath(dir))).mode & 0o777).toBe(0o700)
    expect(readFileSync(secretsKeyPath(dir)).length).toBe(32)
    store.close()
  })

  test("a key file someone else could read is tightened to 0600 when it is used", () => {
    const dir = tempDir()
    const first = open(dir)
    first.store.secrets.add({ sessionId: first.sessionId, kind: "password", value: VALUE })
    first.store.close()
    Bun.spawnSync(["chmod", "644", secretsKeyPath(dir)])
    const store = openStore({ dir })
    store.secrets.values(first.sessionId)
    expect(statSync(secretsKeyPath(dir)).mode & 0o777).toBe(0o600)
    store.close()
  })

  test("a wrong key file is a clear error, not garbage and not a new key", () => {
    const dir = tempDir()
    const first = open(dir)
    first.store.secrets.add({ sessionId: first.sessionId, kind: "password", value: VALUE })
    first.store.close()
    const original = readFileSync(secretsKeyPath(dir))
    writeFileSync(secretsKeyPath(dir), Buffer.alloc(32, 7))

    const store = openStore({ dir })
    expect(() => store.secrets.values(first.sessionId)).toThrow(SecretsError)
    expect(() => store.secrets.reveal(first.sessionId, 1)).toThrow(/does not decrypt with .*secrets\.key/)
    expect(() => store.secrets.add({ sessionId: first.sessionId, kind: "token", value: `${VALUE}-2` })).toThrow(SecretsError)
    // Listing needs no key and shows no value.
    expect(store.secrets.list(first.sessionId)).toMatchObject([{ n: 1, kind: "password" }])
    store.close()

    writeFileSync(secretsKeyPath(dir), original)
    const restored = openStore({ dir })
    expect(restored.secrets.reveal(first.sessionId, 1)).toBe(VALUE)
    restored.close()
  })

  test("a key file of the wrong size is refused, and a missing one is never replaced while secrets exist", () => {
    const dir = tempDir()
    const first = open(dir)
    first.store.secrets.add({ sessionId: first.sessionId, kind: "password", value: VALUE })
    first.store.close()

    writeFileSync(secretsKeyPath(dir), Buffer.alloc(5))
    const short = openStore({ dir })
    expect(() => short.secrets.values(first.sessionId)).toThrow(/holds 5 bytes, not 32/)
    short.close()

    rmSync(secretsKeyPath(dir))
    const missing = openStore({ dir })
    try {
      missing.secrets.values(first.sessionId)
      throw new Error("expected a SecretsError")
    } catch (error) {
      expect(error).toBeInstanceOf(SecretsError)
      expect((error as SecretsError).code).toBe("key_missing")
    }
    expect(() => missing.secrets.add({ sessionId: first.sessionId, kind: "token", value: `${VALUE}-2` })).toThrow(/missing but encrypted secrets exist/)
    expect(existsSync(secretsKeyPath(dir))).toBe(false)
    missing.close()
  })

  test("deleting a session deletes its secrets", () => {
    const dir = tempDir()
    const { store, sessionId } = open(dir)
    store.secrets.add({ sessionId, kind: "password", value: VALUE })
    expect(store.deleteSession(sessionId)).toBe(true)
    expect(store.secrets.list(sessionId)).toEqual([])
    expect(store.secrets.values(sessionId)).toEqual([])
    store.close()
  })

  test("a fork keeps the same numbers and values, re-encrypted for the new session", () => {
    const dir = tempDir()
    const { store, sessionId } = open(dir)
    store.secrets.add({ sessionId, kind: "password", value: VALUE })
    store.secrets.add({ sessionId, kind: "token", value: `${VALUE}-2` })
    store.secrets.forget(sessionId, 1)
    const fork = ids("session")
    store.createSession({ id: fork, directory: "/repo", title: "fork" })
    store.copyConversation(sessionId, fork)
    expect(store.secrets.values(fork)).toEqual([{ n: 2, kind: "token", value: `${VALUE}-2` }])
    // The forgotten number stays taken in the fork too.
    expect(store.secrets.add({ sessionId: fork, kind: "token", value: `${VALUE}-3` }).n).toBe(3)
    store.deleteSession(sessionId)
    expect(store.secrets.reveal(fork, 2)).toBe(`${VALUE}-2`)
    store.close()
  })

  test("forgetting erases the value but never gives its number to another secret", () => {
    const dir = tempDir()
    const { store, sessionId } = open(dir)
    store.secrets.add({ sessionId, kind: "password", value: VALUE })
    expect(store.secrets.forget(sessionId, 1)).toBe(true)
    expect(store.secrets.forget(sessionId, 1)).toBe(false)
    expect(store.secrets.reveal(sessionId, 1)).toBeUndefined()
    expect(store.secrets.list(sessionId)).toEqual([])
    expect(store.secrets.add({ sessionId, kind: "password", value: `${VALUE}-again` }).n).toBe(2)
    // The same value pasted again after a forget is a new secret.
    expect(store.secrets.add({ sessionId, kind: "password", value: VALUE }).n).toBe(3)
    store.close()
  })

  test("a session keeps a bounded number of secrets and an unknown session is refused", () => {
    const { store, sessionId } = open(tempDir())
    for (let i = 0; i < MAX_SECRETS_PER_SESSION; i++) store.secrets.add({ sessionId, kind: "token", value: `value-${i}-padding` })
    expect(() => store.secrets.add({ sessionId, kind: "token", value: "one-too-many-values" })).toThrow(/at most 256/)
    expect(() => store.secrets.add({ sessionId: ids("session"), kind: "token", value: VALUE })).toThrow(/unknown session/)
    store.close()
  })

  test("the tail shows fewer characters of a short value", () => {
    expect(secretTail("abcdefghijkl")).toBe("ijkl")
    expect(secretTail("abcdefgh")).toBe("gh")
  })
})
