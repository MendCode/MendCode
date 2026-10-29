---
summary: finish a task step by step: /goal, plan mode and plan review, todo lists
docs: goals, plan-review, tool-discovery
aliases: goal, plan, planning, todo, todos, objective, until-done, ultraplan
---
For: "work until all tests pass", "keep going until it is done", "show me a plan before touching anything", "track the steps".

Goal (one standing objective per session; the daemon starts each next turn itself until it ends):
  The user types /goal <objective> (optional --budget 50k tokens), /goal pause | resume | clear | edit | budget <n|off>. A goal ends complete, blocked, over budget, paused, or stopped by a provider usage limit.
  Model tools (main agent only, no approval): get_goal; create_goal {objective, token_budget?} only when the user explicitly asked for a goal; update_goal {status: complete|blocked|paused, note?}. complete only when every requirement is achieved and verified; blocked only after the same blocker held for 3 goal turns in a row; paused only if the user asked. You cannot resume or lift a budget. On a budgeted goal report "X of Y tokens used" at the end. Engines without these tools end their last message with GOAL_STATUS: complete or GOAL_STATUS: blocked - why.
  Not a loop: a loop recurs on a trigger in fresh sessions ({{program}} docs loops).

Todo: todo {items: [{text, status: pending|in_progress|done|cancelled, priority?}]} replaces the whole list ([] clears it, at most 50 items); keep one item in_progress. The user sees it in the dock (ctrl+t) and the right panel. In minimalist the plan and goal tools stay out of the request until the user turns on /tier plan_tools on.

Plan mode (read-only until approved): the user types /plan (/ultraplan plans and critiques without edits). The model calls plan_review {title?, markdown, phase?} (or plan_submit {plan}) with goal, steps with files, risks and how it will verify; plan_exit applies the reviewed plan. The user applies (enter), accepts without implementing (a), edits (e), comments (c) or rejects with a reason (r); /plan-review reopens saved decisions. Never edit files before approval. phase: "plan" means acceptance only. planExitAgent picks the agent that implements after approval ([[setting:planExitAgent]]; build when unset).

Limits: one goal per session (an unfinished one needs the user's yes to be replaced); objective up to 60,000 characters (over 4,000 it is saved to a file and the goal reads it); the newest 20 goals per session are kept; a goal stalls, still active, after a failed or cancelled turn or two turns with no output, and restarts when the user sends a message or types /goal resume.

Check: get_goal returns status and tokens; the status row shows the goal indicator. Say when you cannot see it.
