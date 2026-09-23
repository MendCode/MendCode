import { test } from "node:test"
import assert from "node:assert/strict"
import { digest, makeIndex, migrationEntry, releaseChannel } from "./release-index.mjs"

test("channels are disjoint and reject unrecognized prereleases", () => {
  assert.equal(releaseChannel("0.1.44"), "stable")
  assert.equal(releaseChannel("0.1.44-beta.2"), "beta")
  assert.equal(releaseChannel("0.1.44-nightly.20260904.123"), "nightly")
  for (const version of ["v0.1.44", "0.1.44-rc.1", "0.1.44+dirty", "0.1.44-beta.0"])
    assert.throws(() => releaseChannel(version))
})

const input = () => ({
  version: "0.1.44-beta.1", commit: "a".repeat(40), repository: "MendCode/MendCode", runID: "42",
  journal: [migrationEntry("20260803032053_dynamic_workflows", "CREATE TABLE sample(id TEXT);")],
  assets: [{ name: "mendcode-linux-x64-baseline-musl.tar.gz", size: 123, sha256: "b".repeat(64) }],
  installer: { sha256: "c".repeat(64) },
  windowsInstaller: { sha256: "d".repeat(64) },
})

test("index binds installer, platform and schema to exact source", () => {
  const value = makeIndex(input())
  assert.equal(value.installer.commit, value.commit)
  assert.equal(value.assets[0].platform, "linux-x64-baseline-musl")
  assert.equal(value.schema.fingerprint, digest(JSON.stringify(value.schema.journal)))
  assert.equal(value.schema.journal[0].timestamp, Date.UTC(2026, 7, 3, 3, 20, 53))
  const changed = input()
  changed.journal[0] = migrationEntry(changed.journal[0].name, "different SQL")
  assert.notEqual(makeIndex(changed).schema.fingerprint, value.schema.fingerprint)
})

test("index rejects untrusted source and unsafe asset metadata", () => {
  for (const override of [{ commit: "main" }, { repository: "other/repo" }, { runID: "0" }])
    assert.throws(() => makeIndex({ ...input(), ...override }))
  const duplicate = input()
  duplicate.assets.push(duplicate.assets[0])
  assert.throws(() => makeIndex(duplicate))
  const traversal = input()
  traversal.assets[0].name = "../mendcode-linux-x64.tar.gz"
  assert.throws(() => makeIndex(traversal))
  const unordered = input()
  unordered.journal.push(migrationEntry("20260722100000_subagent_orchestration", "SELECT 1;"))
  assert.throws(() => makeIndex(unordered))
  assert.throws(() => makeIndex({ ...input(), journal: [] }))
})
