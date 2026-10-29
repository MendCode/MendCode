import type { Database } from "bun:sqlite"
import type { SessionId } from "@mendcode/protocol"
import type { Codec } from "./compress"

export type LimitCheckpoint = {
  version: 1
  provider: string
  windowKey: string
  at: number
  checkpoint: { version: 1; generation: number; method: string; tailTurns: number }
  summary: string
}

/** One bounded compressed recovery snapshot per session, removed with that session. */
type State = { provider: string; used: Record<string, { percent: number; at: number; burn: number }>; saved: string[] }
export function createLimitCheckpoints(db: Database, codec: Codec) {
  return {
    tracked() {
      return db.query<{ session_id: SessionId }, []>("SELECT session_id FROM limit_checkpoint_state ORDER BY session_id LIMIT 512").all().map((row) => row.session_id)
    },
    state(sessionId: SessionId): State | undefined {
      const row = db.query<{ payload: string }, [string]>("SELECT payload FROM limit_checkpoint_state WHERE session_id = ?").get(sessionId)
      return row ? JSON.parse(row.payload) as State : undefined
    },
    track(sessionId: SessionId, state: State) {
      db.query("INSERT INTO limit_checkpoint_state(session_id, payload) VALUES (?, ?) ON CONFLICT(session_id) DO UPDATE SET payload = excluded.payload").run(sessionId, JSON.stringify(state))
    },
    get(sessionId: SessionId): LimitCheckpoint | undefined {
      const row = db.query<{ payload: string | Uint8Array }, [string]>("SELECT payload FROM limit_checkpoints WHERE session_id = ?").get(sessionId)
      return row ? JSON.parse(codec.unpackText(row.payload)) as LimitCheckpoint : undefined
    },
    put(sessionId: SessionId, checkpoint: LimitCheckpoint, state?: State) {
      if (checkpoint.summary.length > 16_000 || checkpoint.windowKey.length > 2000) throw new Error("Limit checkpoint exceeds its budget")
      db.transaction(() => {
        db.query("INSERT INTO limit_checkpoints(session_id, payload) VALUES (?, ?) ON CONFLICT(session_id) DO UPDATE SET payload = excluded.payload").run(sessionId, codec.packText(JSON.stringify(checkpoint)))
        if (state) this.track(sessionId, state)
      })()
    },
  }
}
