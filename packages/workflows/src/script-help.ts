/** The script API as the model reads it (`workflow_script` with `help: true`). Kept next to the engine so the two change together. */
export const SCRIPT_API_HELP = `Script workflow API (plain JavaScript, top level await, no imports)

The first statement must be a pure literal (no calls, no template substitutions, no spreads):
export const meta = {
  name: "review-and-verify",            // required
  description: "what it does",
  phases: [{ title: "Find", detail: "optional" }, { title: "Verify" }],
  budget: { agents: 40, tokens: 2000000, usd: 5, minutes: 60 },   // hard caps, enforced by the engine; required above 10 agents
  contract: { criteria: [...], checks: [...] },                     // optional final contract (same shape as workflow_start), or a saved name
  permission: "edits",              // a request, never a grant
  maxConcurrent: 8,                 // 1..16, default 16
}

Then the body. It runs in an isolated process: no process, Bun, require, import, fs, network or environment. Only these names exist:
  args                      the arguments the run was started with (frozen)
  await agent(prompt, opts) one sub-agent (its own session). Returns its final text, or the parsed object when opts.schema is set.
      opts: label, phase, schema (JSON Schema subset; the answer is validated, with one automatic repair turn),
            mode "read" (default, cannot change anything) | "work" (edits; one work agent at a time unless worktree),
            worktree true (isolated checkout: work agents may then run in parallel), model "provider:model", effort,
            engine "native" | "claude" | "codex" | "pi" (the engine the model runs on; non-native needs the full tier, an exact model,
            and no allowedTools or budget; checked before the agent starts), agent (profile name), allowedTools,
            retry (number | {maxAttempts, retryOn}), timeoutMinutes, budget {tokens, usd},
            detail true (returns {text, taskId, workspace} instead of the text; for a worktree agent also branch and
            diff {commit, files, insertions, deletions, changed})
  await merge(results, {strategy, message})   combine worktree agents' results (detail: true) on a reviewed integration branch. The host runs
      git in a scratch worktree; your checkout is untouched. strategy "branch" (default) stops there and returns {branch, worktree, files,
      insertions, deletions, merged, applied: false}. "apply" then asks the user and merges that branch into the checkout only on a yes.
      A conflict pauses the run (files listed); the user resolves them in the integration worktree and resumes.
  await parallel([() => agent(...), ...], {settled?})   run thunks together; results keep order. settled: true returns {ok,value|error} per entry
  await pipeline(items, stage1, stage2, ...)           each item flows through the stages on its own; a stage returning undefined drops the item
  await check(command)      run a command on the host (same as a contract check). Returns {ok, detail}; never throws for a failing command
  await ask(question, options?)   ask the user (the question dialog) and wait; with options the answer is one of them
  await memo(key, fn)       run fn once per run; later replays reuse the journaled value
  phase(title)              mark the current phase (agents started after it are shown under it)
  log(...values)            a line in the run's log
  await sleep(ms)           a journaled timer (max 5 minutes)
  Date, Math.random         deterministic: the clock is the run's journaled time, random is seeded per run. setTimeout is journaled too.
  return value              the run's result (plain JSON)

Rules
- Every agent() call is a normal workflow task: limits, permissions, cost, cancel, the panel and the Agent View all apply.
- The run is a journal. After a restart or resume the script replays from the top: finished calls come from the journal, only changed or new calls run again. A call is identified by its prompt, options and the nth identical call, so keep prompts deterministic and put anything varying inside args or earlier results.
- Never rely on wall clock, randomness or object key order outside Date/Math.random above.
- Hard caps: 200 agent calls per run; above 10 agents meta.budget must be declared. A cap pauses the run; the user can raise it and resume.
- The user always approves a script you write (meta, caps, source hash and source are shown).`
