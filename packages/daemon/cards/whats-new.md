---
summary: what changed in a version and which changes fit you
docs: whats-new, release, tiers
aliases: whatsnew, changelog, release-notes, new-version, what-changed, update-notes
---
For: "MendCode vX.Y.Z is installed ... tell me which of these changes I should use" (the prompt on every release page), "what is new in MendCode", "what changed in this version".

That pasted prompt is read only. Answer it:
  1. The changes: the release page it names (fetch it when a web tool is available), else ask the user to open /changelog (balanced, full) and paste the part they care about. Never invent changes.
  2. What the user does: their memories (memory tool, list), their recent sessions (sessions tools: titles and summaries), their settings (mendcode_settings get).
  3. At most five changes that fit what they do, one or two short sentences each, in the user's language. Name the command or setting each one uses. Change nothing: if they want a setting, they ask, and mendcode_settings propose shows it for their Apply.

The user types: /whatsnew (the changes since their last look and one model call that picks the ones that fit them; the cost shows before and after; each pick's action is previewed and needs a second Enter) · /whatsnew all (every change, no call) · /changelog (highlights per version, new since the last look marked). Feature whats_new: balanced and full; /tier whats_new on|off. Minimalist has only the release page's prompt.

What /whatsnew sends: this project's saved memories, the settings in effect with secrets hidden and recent session titles, only to the provider of the model the call runs on (the aside role, else the session's model). Local terminals only. Counted in /usage as the whatsNew role.

Not possible: a changelog of a version newer than the running build (it is packed into the build), applying a pick without its preview and confirmation, or changing settings from the pasted prompt alone.
