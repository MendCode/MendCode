/** Schema version 1. Events are small deltas; binary content lives in the blob store (P11). */
export const SCHEMA_VERSION = 1

/** Page size of a database created from now on (an existing database keeps its own: WAL mode cannot change it). */
export const DEFAULT_PAGE_SIZE = 16384

/** Must run before any table exists: auto_vacuum only applies to a fresh database. */
export const PRAGMAS = [
  "PRAGMA auto_vacuum = INCREMENTAL",
  "PRAGMA journal_mode = WAL",
  "PRAGMA synchronous = NORMAL",
  "PRAGMA foreign_keys = ON",
  "PRAGMA busy_timeout = 2000",
  // 8 MiB page cache, not OpenCode's 64 MiB (oc#16697).
  "PRAGMA cache_size = -8000",
  "PRAGMA temp_store = MEMORY",
]

export const DDL = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS limit_checkpoints (
  session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  payload BLOB NOT NULL
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS limit_checkpoint_state (
  session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  payload TEXT NOT NULL
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  directory TEXT NOT NULL,
  title TEXT NOT NULL,
  parent_id TEXT,
  created_at INTEGER NOT NULL,
  last_seq INTEGER NOT NULL DEFAULT 0,
  active_turn TEXT,
  updated_at INTEGER NOT NULL DEFAULT 0,
  permission_mode TEXT NOT NULL DEFAULT 'ask',
  model TEXT,
  effort TEXT,
  model_options TEXT,
  agent TEXT,
  archived_at INTEGER,
  pinned_at INTEGER,
  lifecycle TEXT,
  fanout TEXT
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS events (
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  type TEXT NOT NULL,
  at INTEGER NOT NULL,
  payload TEXT NOT NULL,
  PRIMARY KEY (session_id, seq)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS queue_items (
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  queue_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  text TEXT NOT NULL,
  attachments TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'message',
  PRIMARY KEY (session_id, queue_id)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL,
  directory TEXT,
  text TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL,
  source TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  kind TEXT NOT NULL DEFAULT 'new',
  target_id TEXT,
  reason TEXT NOT NULL DEFAULT '',
  profile TEXT NOT NULL DEFAULT '',
  session_id TEXT,
  pinned INTEGER NOT NULL DEFAULT 0
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS memories_scope ON memories(scope, directory, status);
CREATE TABLE IF NOT EXISTS memory_links (
  from_id TEXT NOT NULL,
  to_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (from_id, to_id)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS memory_links_to ON memory_links(to_id);
CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(memory_id UNINDEXED, text, category);

CREATE TABLE IF NOT EXISTS dream_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  directory TEXT NOT NULL,
  status TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  proposed INTEGER NOT NULL DEFAULT 0,
  notes TEXT,
  error TEXT,
  started_by TEXT,
  report TEXT
);
CREATE INDEX IF NOT EXISTS dream_runs_dir ON dream_runs(directory, id DESC);

-- Short per-session digests Dream reads instead of whole transcripts. A digest is reused while the session's last_seq
-- equals source_seq (and the digest format is the same); deleting the session deletes it.
CREATE TABLE IF NOT EXISTS session_digests (
  session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  source_seq INTEGER NOT NULL,
  version INTEGER NOT NULL,
  payload TEXT NOT NULL,
  updated_at INTEGER NOT NULL
) WITHOUT ROWID;

-- Branch lineage (a fork records where it came from), labels on user messages and the cached recap of a session.
-- parent_id has no foreign key: deleting a parent leaves its branches as roots of their own tree.
CREATE TABLE IF NOT EXISTS session_forks (
  session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  parent_id TEXT NOT NULL,
  at_item_id TEXT,
  at_preview TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS session_forks_parent ON session_forks(parent_id);
CREATE TABLE IF NOT EXISTS session_labels (
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  item_id TEXT NOT NULL,
  label TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (session_id, item_id)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS session_recaps (
  session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  source_seq INTEGER NOT NULL,
  text TEXT NOT NULL,
  updated_at INTEGER NOT NULL
) WITHOUT ROWID;

-- Evolution: corrections and preferences seen repeatedly (text only from suggest mode up, redacted and bounded)
-- and the skill/instruction suggestions built on them.
CREATE TABLE IF NOT EXISTS evolution_evidence (
  id TEXT PRIMARY KEY,
  directory TEXT NOT NULL,
  session_id TEXT NOT NULL,
  source TEXT NOT NULL,
  fingerprint TEXT NOT NULL DEFAULT '',
  text TEXT,
  created_at INTEGER NOT NULL
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS evolution_evidence_dir ON evolution_evidence(directory, created_at DESC);
CREATE TABLE IF NOT EXISTS evolution_suggestions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  directory TEXT NOT NULL,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  content TEXT NOT NULL,
  evidence INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at INTEGER NOT NULL,
  resolved_at INTEGER,
  run_id INTEGER
);
CREATE INDEX IF NOT EXISTS evolution_suggestions_dir ON evolution_suggestions(directory, id DESC);

CREATE TABLE IF NOT EXISTS loops (
  id TEXT PRIMARY KEY,
  payload TEXT NOT NULL,
  updated_at INTEGER NOT NULL
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS workflows (
  id TEXT PRIMARY KEY,
  directory TEXT NOT NULL,
  state TEXT NOT NULL,
  payload TEXT NOT NULL,
  updated_at INTEGER NOT NULL
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS workflows_live ON workflows(state);

CREATE TABLE IF NOT EXISTS settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  payload TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS prompt_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  directory TEXT NOT NULL,
  at INTEGER NOT NULL,
  text TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'sent'
);
CREATE INDEX IF NOT EXISTS prompt_history_dir ON prompt_history(directory, id DESC);

CREATE TABLE IF NOT EXISTS engine_messages (
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  engine TEXT NOT NULL,
  idx INTEGER NOT NULL,
  payload TEXT NOT NULL,
  PRIMARY KEY (session_id, engine, idx)
) WITHOUT ROWID;

-- A fork's model history starts as a reference, not a copy (engine-history.ts): messages 0..upto-1 of this engine are the
-- ones of parent_id. The session's own rows begin at index upto. Deleting the parent hands its rows to a fork first, so
-- the parent_id key (no cascade) refuses a delete that skipped that.
CREATE TABLE IF NOT EXISTS engine_prefix (
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  engine TEXT NOT NULL,
  parent_id TEXT NOT NULL REFERENCES sessions(id),
  upto INTEGER NOT NULL,
  PRIMARY KEY (session_id, engine)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS engine_prefix_parent ON engine_prefix(parent_id, engine);

-- Large tool output shared between a session and its forks (event-objects.ts): the event row keeps its JSON shape and
-- points at the object; every session that has such an event holds a reference, so the object goes with the last one.
CREATE TABLE IF NOT EXISTS event_objects (
  sha256 TEXT PRIMARY KEY,
  bytes INTEGER NOT NULL,
  data BLOB NOT NULL
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS event_object_refs (
  sha256 TEXT NOT NULL REFERENCES event_objects(sha256),
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  PRIMARY KEY (sha256, session_id)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS event_object_refs_session ON event_object_refs(session_id);

CREATE TABLE IF NOT EXISTS engine_bindings (
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  engine TEXT NOT NULL,
  external_id TEXT NOT NULL,
  PRIMARY KEY (session_id, engine)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS global_events (
  gseq INTEGER PRIMARY KEY,
  type TEXT NOT NULL,
  at INTEGER NOT NULL,
  payload TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS usage_daily (
  day TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  input INTEGER NOT NULL DEFAULT 0,
  output INTEGER NOT NULL DEFAULT 0,
  reasoning INTEGER NOT NULL DEFAULT 0,
  cache_read INTEGER NOT NULL DEFAULT 0,
  cache_write INTEGER NOT NULL DEFAULT 0,
  cost_micros INTEGER NOT NULL DEFAULT 0,
  cost_unknown_calls INTEGER NOT NULL DEFAULT 0,
  calls INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, provider, model)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS usage_session_days (
  day TEXT NOT NULL,
  session_id TEXT NOT NULL,
  PRIMARY KEY (day, session_id)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS usage_days (
  day TEXT PRIMARY KEY,
  sessions INTEGER NOT NULL DEFAULT 0
) WITHOUT ROWID;

-- Per local day activity projections, updated in the same transaction as the event (O(1) per event).
-- prompts/words: every queue.added (a user prompt) and its whitespace-separated words, on the day it was queued.
-- ai_ms: model generation time = sum of (item.completed.at - item.started.at) over agent_message and reasoning
--   items, on the day the item completed. Tool time is never included because tools are separate items.
-- tool_ms: same for tool_call items. Open items are tracked in memory, so an item straddling a daemon
--   restart is not counted (recovery closes it as interrupted without a start time).
-- History recorded before this table existed is not backfilled.
CREATE TABLE IF NOT EXISTS usage_activity (
  day TEXT PRIMARY KEY,
  prompts INTEGER NOT NULL DEFAULT 0,
  words INTEGER NOT NULL DEFAULT 0,
  ai_ms INTEGER NOT NULL DEFAULT 0,
  tool_ms INTEGER NOT NULL DEFAULT 0
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS usage_response_peaks (
  day TEXT PRIMARY KEY,
  longest_ms INTEGER NOT NULL DEFAULT 0
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS usage_tools (
  day TEXT NOT NULL,
  tool TEXT NOT NULL,
  calls INTEGER NOT NULL DEFAULT 0,
  ms INTEGER NOT NULL DEFAULT 0,
  errors INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, tool)
) WITHOUT ROWID;

-- Usage insights (usage-insights.ts). Efforts: turns per reasoning effort ("default" when the session has
-- none), counted at turn.started; not backfilled (effort is not in older events). Skills: skill loads per day,
-- from tool_call items titled "skill: <name>". Session stats: turns, tokens (input + output) and active_ms
-- (sum of turn durations) per session. Skills and session stats are backfilled once from the event log.
CREATE TABLE IF NOT EXISTS usage_efforts (
  day TEXT NOT NULL,
  effort TEXT NOT NULL,
  turns INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, effort)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS usage_skills (
  day TEXT NOT NULL,
  skill TEXT NOT NULL,
  runs INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, skill)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS drafts (
  session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  text TEXT NOT NULL,
  attachments_json TEXT NOT NULL DEFAULT '[]',
  updated_at INTEGER NOT NULL
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS usage_session_stats (
  session_id TEXT PRIMARY KEY,
  turns INTEGER NOT NULL DEFAULT 0,
  tokens INTEGER NOT NULL DEFAULT 0,
  active_ms INTEGER NOT NULL DEFAULT 0,
  first_day TEXT NOT NULL DEFAULT '',
  last_day TEXT NOT NULL DEFAULT ''
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS quota_latest (
  provider TEXT PRIMARY KEY,
  fetched_at INTEGER NOT NULL,
  payload TEXT NOT NULL
) WITHOUT ROWID;

-- Secrets the user pasted (secrets.ts): AES-256-GCM, the key is a file outside the database. A forgotten secret keeps
-- its row with empty iv/ciphertext so its number is never reused. The plain value is stored nowhere else.
CREATE TABLE IF NOT EXISTS secrets (
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  n INTEGER NOT NULL,
  kind TEXT NOT NULL,
  iv BLOB NOT NULL,
  ciphertext BLOB NOT NULL,
  tail TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (session_id, n)
) WITHOUT ROWID;

-- One row per turn, kept up to date by every event append (turns.ts), so the timeline, undo and fork read rows instead
-- of scanning the log. item_id is the user message that started the turn (NULL for a compaction turn); preview its first
-- characters. history is JSON {engine: how many model messages that engine had when the turn started}: where an undo or a
-- fork cuts the model history. A compaction rewrites the history and removes its engine from the older turns' marks.
CREATE TABLE IF NOT EXISTS turns (
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  turn_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  at INTEGER NOT NULL,
  item_id TEXT,
  preview TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'running',
  reverted INTEGER NOT NULL DEFAULT 0,
  shell INTEGER NOT NULL DEFAULT 0,
  notice INTEGER NOT NULL DEFAULT 0,
  compacted INTEGER NOT NULL DEFAULT 0,
  shell_tool INTEGER NOT NULL DEFAULT 0,
  history TEXT,
  PRIMARY KEY (session_id, turn_id)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS turns_seq ON turns(session_id, seq);
CREATE INDEX IF NOT EXISTS turns_item ON turns(session_id, item_id);

-- Pre-change snapshot of the files a turn's write/edit/apply_patch calls touched: the content before the turn's first
-- change ('content', 'absent' when the turn created the file, 'skipped' for a binary or over-budget file), and the
-- content when the turn ended (after_*, NULL until then) so undo can tell a later edit from the turn's own change and redo can re-apply it.
CREATE TABLE IF NOT EXISTS turn_files (
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  turn_id TEXT NOT NULL,
  path TEXT NOT NULL,
  before_state TEXT NOT NULL,
  before_content BLOB,
  before_mode INTEGER,
  skip_reason TEXT,
  after_state TEXT,
  after_content BLOB,
  after_mode INTEGER,
  after_skip_reason TEXT,
  PRIMARY KEY (session_id, turn_id, path)
) WITHOUT ROWID;

-- Undo stack: each undo pushes the turns it hid and the model messages it took out of engine_messages, so redo can put
-- both back. Both tables are emptied when a new turn starts (redo only works while nothing new happened).
CREATE TABLE IF NOT EXISTS undo_stack (
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  n INTEGER NOT NULL,
  turn_ids TEXT NOT NULL,
  partial TEXT,
  PRIMARY KEY (session_id, n)
) WITHOUT ROWID;

-- Before-state of a file at each write/edit/apply_patch call of a turn (the call is the part/item that ran it), so one
-- part and the calls after it can be reverted without undoing the whole turn. Same byte budget idea as turn_files.
CREATE TABLE IF NOT EXISTS turn_call_files (
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  turn_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  path TEXT NOT NULL,
  before_state TEXT NOT NULL,
  before_content BLOB,
  before_mode INTEGER,
  skip_reason TEXT,
  PRIMARY KEY (session_id, turn_id, item_id, path)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS undone_messages (
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  n INTEGER NOT NULL,
  engine TEXT NOT NULL,
  idx INTEGER NOT NULL,
  payload TEXT NOT NULL,
  PRIMARY KEY (session_id, n, engine, idx)
) WITHOUT ROWID;

-- Session goals (goals.ts): one row per goal. The current goal of a session is its only row with superseded_at NULL; a
-- replaced or cleared goal stays as history. time_used_ms is the wall time of finished goal turns, active_since the start
-- of the goal turn in progress. budget_notice_sent and pending_steer are the daemon's bookkeeping for one-shot steering.
CREATE TABLE IF NOT EXISTS goals (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  objective TEXT NOT NULL,
  objective_file TEXT,
  status TEXT NOT NULL,
  token_budget INTEGER,
  tokens_used INTEGER NOT NULL DEFAULT 0,
  time_used_ms INTEGER NOT NULL DEFAULT 0,
  active_since INTEGER,
  stalled TEXT,
  note TEXT,
  budget_notice_sent INTEGER NOT NULL DEFAULT 0,
  pending_steer TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  superseded_at INTEGER
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS goals_session ON goals(session_id, created_at DESC);

CREATE TABLE IF NOT EXISTS blobs (
  sha256 TEXT PRIMARY KEY,
  bytes INTEGER NOT NULL,
  mime TEXT NOT NULL,
  created_at INTEGER NOT NULL
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS blob_refs (
  sha256 TEXT NOT NULL REFERENCES blobs(sha256),
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  PRIMARY KEY (sha256, session_id)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS blob_refs_session ON blob_refs(session_id);

-- Content-addressed file content of turn snapshots (compress.ts): a file that is the same before one turn and after the
-- previous one is stored once. z = 1 when data is zstd, bytes the original size. A row nothing points at is swept by cleaning.
CREATE TABLE IF NOT EXISTS snap_objects (
  sha256 TEXT PRIMARY KEY,
  bytes INTEGER NOT NULL,
  z INTEGER NOT NULL,
  data BLOB NOT NULL
) WITHOUT ROWID;

-- How far storage compaction has looked in each session (storage-upkeep.ts): a daily pass only visits events newer than this.
CREATE TABLE IF NOT EXISTS storage_marks (
  session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  events_seq INTEGER NOT NULL DEFAULT 0,
  deltas_seq INTEGER NOT NULL DEFAULT 0
) WITHOUT ROWID;

-- Snapshot scope and bounded diffs survive file-copy retention and daemon restarts.
CREATE TABLE IF NOT EXISTS turn_snapshots (
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  turn_id TEXT NOT NULL,
  payload TEXT NOT NULL,
  PRIMARY KEY (session_id, turn_id)
) WITHOUT ROWID;
`
