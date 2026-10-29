import { describeTask, type BackgroundTaskInfo } from "@mendcode/tools"

const TAIL_LINES = 20

/**
 * Whether a queued notice is one of the two below. The queue is stored without the "nobody waits on a reply" mark, so a restored
 * session recognises its background notices by how they open and keeps sending them with the user's next message.
 */
export function isBackgroundNotice(text: string): boolean {
  return /^\[(background task|monitor) /.test(text)
}

/** The message a session gets while a monitored task (`shell_monitor`) prints matching lines. */
export function watchNotice(task: BackgroundTaskInfo, lines: string[], final: boolean) {
  const command = task.command.split("\n")[0]!.slice(0, 120)
  return [
    `[monitor ${task.id}: ${command}]`,
    ...lines,
    final ? "(monitor stopped: message limit reached; call shell_monitor again to keep watching)" : `(shell_monitor ${task.id} with stop ends this)`,
  ].join("\n")
}

/**
 * The message a session gets when one of its background tasks ends on its own: what ended, how, and the
 * end of its output, so the agent can often act without another tool call.
 */
export function backgroundNotice(task: BackgroundTaskInfo, tail: string, now = Date.now()) {
  const lines = tail.replace(/\s+$/, "").split("\n").slice(-TAIL_LINES)
  const command = task.command.split("\n")[0]!.slice(0, 200)
  return [
    `[background task ${describeTask(task, now)}: ${command}]`,
    ...(lines.join("").trim() ? ["last output:", ...lines] : ["no output"]),
    `(shell_output ${task.id} reads anything not shown)`,
  ].join("\n")
}
