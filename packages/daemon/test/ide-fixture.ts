import { Database } from "bun:sqlite"
import { mkdirSync, writeFileSync } from "node:fs"
import path from "node:path"

/** Local Zed schema and projects; no installed editor or user database. */
export function zedFixture(dir: string) {
  const directory = path.join(dir, "project")
  mkdirSync(directory, { recursive: true })
  const file = path.join(directory, "app.ts")
  writeFileSync(file, "disk content\n")
  const dbPath = path.join(dir, "zed.sqlite")
  const db = new Database(dbPath)
  db.exec(`create table workspaces (workspace_id integer, paths text, timestamp text);
    create table panes (pane_id integer, workspace_id integer, active integer);
    create table items (item_id integer, pane_id integer, workspace_id integer, kind text, active integer);
    create table editors (item_id integer, workspace_id integer, buffer_path text, contents text);
    create table editor_selections (editor_id integer, workspace_id integer, start integer, end integer);`)
  function editor(id: number, root: string, target: string, contents: string | null, timestamp = "2026-10-02", kind = "Editor") {
    db.query("insert into workspaces values (?, ?, ?)").run(id, JSON.stringify([root]), timestamp)
    db.query("insert into panes values (?, ?, 1)").run(id, id)
    db.query("insert into items values (?, ?, ?, ?, 1)").run(id, id, id, kind)
    db.query("insert into editors values (?, ?, ?, ?)").run(id, id, target, contents)
  }
  editor(1, directory, file, "aé🙂\nhello\nworld")
  db.query("insert into editor_selections values (1, 1, 7, 1)").run()
  db.query("insert into editor_selections values (1, 1, 14, 19)").run()
  return { directory, file, dbPath, db, editor }
}
