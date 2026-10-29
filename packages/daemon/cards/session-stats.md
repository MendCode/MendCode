---
summary: a session's hours and tokens, by model and sub-agent
docs: automation, sessions, usage
aliases: stats, duration, statistics, spent, worked, timeline, consumption
---
For: "how long did that session work", "how many hours", "what did it spend", "why did my Claude or Codex usage drop", "which hours", "were the sub-agents expensive".

Get the figures, never estimate them from an export (an export is a transcript, truncated, without totals):
  sessions {"stats":"<id>"} (or "self") for a session of this project; threads {"action":"stats"} gives the same. No approval, no message text.
  {{program}} session stats <id> [--json] from the shell, for any session.

What it reports (times in the machine's local zone, which it names):
  turns: count by status (completed, cancelled, failed, running), each one's real start, end and duration; the longest are listed with their tokens.
  active time: the sum of turn durations, approval waits included; waiting on approvals is also given alone.
  per day and per hour: active minutes, turns started, output and cache-read tokens. A turn's time and usage are split over the hours it ran, so a 9-hour turn shows in each of its hours. The last 72 active hours are listed.
  usage: totals and per provider/model: input, output, reasoning, cache read, cache write, cost when known.
  unknown: ended turns with no recorded usage are counted as unknown, not zero; "partial" turns ended before the engine's own total and carry the sum of the calls it reported.
  sub-agents (Claude Code's agents): runs, their tool calls, tokens and time (they can run in parallel, so their time can exceed the turn's).
  tools: calls by name with errors, and calls made by sub-agents; child sessions with their usage.

Answer with the figures and say what is unknown. A provider's weekly or 5-hour quota reading is separate: {{program}} docs usage.
