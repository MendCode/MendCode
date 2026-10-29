---
summary: prompt modes (how much MendCode text each call carries) and model families
docs: prompt-modes
aliases: prompt-mode, prompt, modes, mode, families, family, focus
---
A prompt mode picks how much MendCode text rides in every model call: {{modes}}.
  minimal: a small boundary, the one-line pointer to these cards, the user's instructions and memories
  focus (default): adds the native coding harness, the skill catalog and a one-line note for the model family
  guide: adds the shared working basics and a longer guide for the family, plus model notes (more tokens on every call)
  full: adds the operator note about MendCode itself and the family's context files
  custom: reads <project>/.mendcode/prompts/custom.md (a regular file, up to 32 KiB, {{cwd}} expands) and inherits nothing else
The family is {{families}}; auto follows the session's model on every call, naming one overrides it. A family changes guidance only, never provider, model, permissions or budgets. Instruction files (AGENTS.md, CLAUDE.md) ride in every mode.
The user chooses with /prompt-mode: Up/Down select, Tab swaps modes and families, Enter applies. The choice is saved per project in <data dir>/prompt-context.json and applies from the next call.
CLI: {{program}} prompt mode [<mode>] [--focus <family>] reads or saves it for the project; {{program}} prompt cycle-mode (saving and cycling: the user's terminal, refused from your shell); {{program}} prompt build --mode full --show-full previews the exact text without a provider call (also shows each mode's cost in tokens per call); {{program}} prompt sources.
Prose style is separate: the user's /output-style default|explanatory|learning|terse|caveman saves [[setting:outputStyle]] (you can propose it with mendcode_settings; it saves on the user's Apply). The prompt mode itself is not a daemon setting. caveman (feature caveman, balanced) is opt-in compression of prose that keeps code, paths, quantities and uncertainty exact; no savings percentage is claimed.
A tier applies a mode once ({{program}} docs tiers). Do not confuse prompt modes with tiers, permission modes or the process mode.
