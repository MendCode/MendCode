Extract durable facts from this exchange. Return JSON: {"memories":[{"scope":"project" or "user","category":"preferences" or "constraints" or "commands" or "conventions","text":"standalone fact"}]}.

Keep a fact only when the user stated it as lasting (always, from now on, remember, I prefer), as a correction that applies to future work, or as a project fact the repo does not show.
Never extract what only this request asks for (its content, format or language), task status, or anything that matters only to this conversation. A one-off request is not a preference.
When unsure, leave it out. No speculation or secrets. An empty array is the expected result for most exchanges.
