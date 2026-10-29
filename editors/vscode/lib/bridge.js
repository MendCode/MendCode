"use strict"
// Pure helpers of the MendCode VS Code extension: where the editor context is published and what it looks like.
// No `vscode` import here, so the daemon's tests can exercise the exact files the extension writes.
const crypto = require("node:crypto")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")

const FORMAT_VERSION = 1
const MAX_TOTAL_CHARS = 1024 * 1024

/** Same default as the daemon and the CLI. */
function defaultDataDir() {
  return path.join(os.homedir(), ".mendcode-v2")
}

function realOr(target) {
  try { return fs.realpathSync(target) } catch { return target }
}

/** `<data dir>/ide/vscode/<sha256 of the real workspace folder>.json`, the file the daemon reads for that project. */
function bridgeFile(dataDir, workspace) {
  const hash = crypto.createHash("sha256").update(realOr(workspace)).digest("hex")
  return path.join(dataDir || defaultDataDir(), "ide", "vscode", `${hash}.json`)
}

/** One-based positions from VS Code's zero-based ones. */
function position(value) {
  return { line: value.line + 1, character: value.character + 1 }
}

/**
 * The published record. `ranges` are `{ text, start, end }` with zero-based positions (empty text for a bare cursor);
 * without a file the record is only a heartbeat, which the daemon reports as "no selection".
 */
function buildRecord({ app, workspace, filePath, ranges, now }) {
  const record = { v: FORMAT_VERSION, workspace, updatedAt: now }
  if (app) record.app = app
  if (!filePath || !ranges || !ranges.length) return record
  const total = ranges.reduce((sum, range) => sum + range.text.length, 0)
  // An enormous selection is not copied into a file; the daemon then sees the open file only.
  const kept = total > MAX_TOTAL_CHARS ? ranges.map((range) => ({ ...range, text: "", end: range.start })) : ranges
  record.filePath = filePath
  record.ranges = kept.map((range) => ({ text: range.text, selection: { start: position(range.start), end: position(range.end) } }))
  return record
}

/** Written whole through a temporary file with private modes, so the daemon never reads half a record. */
function writeRecord(file, record) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const temp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(temp, JSON.stringify(record), { mode: 0o600 })
  fs.renameSync(temp, file)
}

function removeRecord(file) {
  try { fs.rmSync(file, { force: true }) } catch { /* nothing published */ }
}

/** `@path` mention as the prompt understands it: quoted when the path has spaces, `?start=&end=` for a line range. */
function mention(relativePath, range) {
  const slashed = relativePath.split(path.sep).join("/")
  const token = range ? `${slashed}?start=${range.start}${range.end > range.start ? `&end=${range.end}` : ""}` : slashed
  return /\s|"/.test(token) ? `@${JSON.stringify(token)}` : `@${token}`
}

module.exports = { FORMAT_VERSION, defaultDataDir, bridgeFile, buildRecord, writeRecord, removeRecord, mention }
