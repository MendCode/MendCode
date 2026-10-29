---
summary: reasoning effort: set it, and the adaptive JEV evaluator
docs: reasoning
aliases: jev, adaptive, think-harder, reasoning-auto, evaluator
---
For: "make it think harder", "lower the effort to save tokens", "what is JEV / adaptive reasoning".

Effort is per session and per model: the levels a model supports (minimal, low, medium, high, xhigh). The user sets it in /model (F3 steps it); a headless run takes --effort LEVEL ({{program}} docs automation). A level the model lacks is refused, not rounded. You cannot change your own effort.

Adaptive effort (JEV; feature jev, tier full; experimental flag reasoning_auto; off by default). Two parts, both the user's:
  The evaluator policy: /model reasoning (or a in /model) opens a grid: o off, s shadow (evaluates, keeps the baseline effort), a adaptive (applies supported efforts to native main and plan generations); c toggles consent for evaluator processing, p picks the evaluator provider (OpenRouter by default). Defaults: off, no consent, two-generation leases, eight decisions per turn, pause on failure. Consent is stored under the data dir (consent.json); a project's .mendcode/adaptive-reasoning.json can only reduce the mode and limits, never grant consent. Turning it on sends data to an evaluator provider: never do it yourself.
  The tool: with the flag on, reasoning_auto lets the model ask for one higher effort for the current turn only, capped at high, with reason verification_failed or technical_block and 1 to 1000 characters of concrete evidence. Network errors, permission requests and unrelated failures are not reasons. Manual effort, named variants and provider parameters always win.

On this machine: the live line shows whether jev is on in this tier.

Check: /model reasoning shows the mode, consent and decisions used; shadow mode never changes effort.
