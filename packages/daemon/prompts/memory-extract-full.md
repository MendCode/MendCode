Extract the durable memory of this exchange. Return JSON: {"memories":[{"scope":"project" or "user","category":"preferences" or "constraints" or "commands" or "conventions" or "architecture" or "objective" or "release" or "stack","text":"standalone fact","confidence":0.0-1.0,"durability":0.0-1.0,"changeRisk":0.0-1.0,"sensitivity":"low" or "medium" or "high"}]}.

Keep a fact when it will still matter in a later conversation:
- a decision the user made or accepted, with the reason when it was given (choice of approach, tool, name, scope);
- a preference or rule the user stated, or a correction of how to work (scope user when it applies to every project);
- a project fact the repository does not show: where things run, how to validate, release steps, ownership, constraints;
- the state of the work when it will carry over: what is done, what is blocked, the agreed next step (category objective, project scope).

Write each fact on its own, specific and in the user's language, with exact names, paths and values. One fact per entry; at most 6.
Never keep what only this request asks for, its format, a single command's output, a passing error, or anything true only inside this conversation. Never keep secrets or personal data.
Scores: confidence in the evidence, durability across sessions, change risk of acting on it wrongly. Give 0.9 or more only for what the user said outright; do not inflate them.
When nothing meets this, return an empty array.
