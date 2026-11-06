// Isolated SQL experiment: compare text keys against numeric keys translated from the public id.
import { Database } from "bun:sqlite"
import { mkdtempSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

const root = mkdtempSync(path.join(tmpdir(), "mend-session-key-"))
const results = []
for (const numeric of [false, true]) {
  const file = path.join(root, numeric ? "numeric.db" : "text.db"), db = new Database(file)
  db.run("PRAGMA journal_mode=WAL")
  db.run("CREATE TABLE sessions(id INTEGER PRIMARY KEY, public_id TEXT UNIQUE)")
  db.run(`CREATE TABLE events(session_id ${numeric ? "INTEGER" : "TEXT"}, seq INTEGER, payload TEXT, PRIMARY KEY(session_id,seq)) WITHOUT ROWID`)
  if (numeric && process.argv.includes("--view")) {
    db.run("ALTER TABLE events RENAME TO events_numeric")
    db.run("CREATE VIEW events AS SELECT s.public_id AS session_id,e.seq,e.payload FROM events_numeric e JOIN sessions s ON s.id=e.session_id")
    db.run("CREATE TRIGGER insert_events INSTEAD OF INSERT ON events BEGIN INSERT INTO events_numeric VALUES ((SELECT id FROM sessions WHERE public_id=NEW.session_id),NEW.seq,NEW.payload); END")
  }
  const putSession = db.query("INSERT INTO sessions VALUES (?,?)")
  const direct = numeric && !process.argv.includes("--view")
  const insert = db.query(direct ? "INSERT INTO events VALUES ((SELECT id FROM sessions WHERE public_id=?),?,?)" : "INSERT INTO events VALUES (?,?,?)")
  const read = db.query(direct ? "SELECT payload FROM events WHERE session_id=(SELECT id FROM sessions WHERE public_id=?) AND seq>? ORDER BY seq LIMIT 100" : "SELECT payload FROM events WHERE session_id=? AND seq>? ORDER BY seq LIMIT 100")
  const ids = Array.from({ length: 100 }, (_, i) => `ses_${String(i).padStart(26, "0")}`)
  const writes: number[] = []
  const startCpu = process.cpuUsage()
  for (const [i, id] of ids.entries()) {
    putSession.run(i + 1, id)
    const begin = performance.now()
    db.transaction(() => { for (let seq = 1; seq <= 1000; seq++) insert.run(id, seq, JSON.stringify({ type: "item.completed", text: `message ${seq}` })) })()
    writes.push(performance.now() - begin)
  }
  const cpu = process.cpuUsage(startCpu)
  const reads: number[] = []
  for (let n = 0; n < 500; n++) {
    const begin = performance.now()
    read.all(ids[n % ids.length]!, 500)
    reads.push(performance.now() - begin)
  }
  db.run("PRAGMA wal_checkpoint(TRUNCATE)")
  db.close()
  writes.sort((a,b)=>a-b); reads.sort((a,b)=>a-b)
  results.push({ numeric, bytes: statSync(file).size, writeP50Ms: writes[50], readP50Ms: reads[250], cpuUs: cpu.user + cpu.system })
}
console.log(JSON.stringify({ root, scope: "SQL microbenchmark only; not integrated daemon acceptance", results }, null, 2))
