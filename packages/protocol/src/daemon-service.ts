import { z } from "zod"
import { lazySchema } from "./lazy"

/** Local daemon health, without login probes, transcripts or credential data. */
export const DaemonStatusReport = lazySchema(() => z.strictObject({
  running: z.literal(true),
  pid: z.number().int().positive(),
  dataDir: z.string(),
  engine: z.string(),
  buildId: z.string().optional(),
  /** Connected clients that completed the handshake (absent from daemons that predate the field). */
  clients: z.number().int().nonnegative().optional(),
  activeTurns: z.number().int().nonnegative(),
  backgroundJobs: z.number().int().nonnegative(),
  loops: z.strictObject({ total: z.number().int().nonnegative(), active: z.number().int().nonnegative(), running: z.number().int().nonnegative() }),
  dream: z.strictObject({ configured: z.boolean(), enabled: z.boolean(), at: z.string().nullable(), handled: z.string().nullable() }),
  /** What a terminal that hosts this daemon must keep alive when it closes (absent from daemons that predate solo mode): `running` work cannot change process mid-step; `standing` features restart from durable state. */
  keepAlive: z.strictObject({ running: z.array(z.string()), standing: z.array(z.string()) }).optional(),
  /** A restart was asked while work ran: the daemon stops once it ends, and the terminals' reconnect starts the installed build. */
  restartPending: z.literal(true).optional(),
}))
export type DaemonStatusReport = z.infer<typeof DaemonStatusReport>

export const DaemonLogsReport = lazySchema(() => z.strictObject({
  logs: z.array(z.strictObject({ stream: z.enum(["stdout", "stderr"]), path: z.string(), text: z.string().max(160_000), missing: z.boolean(), truncated: z.boolean() })).max(2),
}))
export type DaemonLogsReport = z.infer<typeof DaemonLogsReport>
