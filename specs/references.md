# Referencias externas y lecciones (2026-09-26)

Qué se toma de cada sistema y qué evidencia lo respalda. "Tomar" significa estudiar el enfoque, no copiar código (P7).

## Codex app-server (OpenAI) — modelo de protocolo

- **Qué es:** un proceso de larga duración que aloja los hilos del agente y habla JSON-RPC bidireccional (JSONL sobre stdio). Da servicio a todas las superficies de Codex: CLI, VS Code y web ([OpenAI: Unlocking the Codex harness](https://openai.com/index/unlocking-the-codex-harness/), [InfoQ](https://www.infoq.com/news/2026/02/opanai-codex-app-server/), [README](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md)).
- **Primitivas:**
  - **Thread:** contenedor durable que se puede crear, reanudar, bifurcar y archivar, con historial persistido para reconectar.
  - **Turn:** el trabajo disparado por una entrada del usuario.
  - **Item:** la unidad atómica, con ciclo `started → delta* → completed`.
- **Otros detalles:** el servidor puede iniciar peticiones (por ejemplo, una aprobación) y pausar el turno; está diseñado para ser compatible hacia atrás; las operaciones sobre un mismo hilo se serializan entre conexiones.
- **Lección para v2:** el protocolo de MendCode (T05) adopta la forma Thread/Turn/Item con `seq` por sesión. Además:
  - peticiones iniciadas por el daemon (aprobaciones, preguntas) con respuesta idempotente;
  - negociación de versión en el handshake;
  - cuotas por notificación push (`account/rateLimits/updated`), sin polling.
- **Medido:** Codex 0.155.1 cargado ocupa **200 MB** de memoria física en 1 terminal (165 MB el proceso principal) y **0 %** de CPU en reposo.

## Pi (pi-mono) — núcleo mínimo y extensible

- **Qué es:** un harness mínimo en TypeScript. Tiene un eje central `coding-agent → agent-core → ai`, y todo lo demás (extensiones, árboles de sesión, Slack) se engancha como superficie opcional. Viene con pocas herramientas (read, bash, edit, write, grep, find, ls) y un TUI propio con renderizado diferencial, no basado en Ink ni en OpenTUI ([repo](https://github.com/badlogic/pi-mono), [extensiones](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/extensions.md)).
- **Lección para v2:** el kernel no conoce las features. Lo avanzado entra por un SDK de extensiones con las mismas primitivas que usan los built-ins.
- **Medido:** Pi 0.85.1 ocupa **78–147 MB** de memoria física por terminal (233 MB con 3 terminales, un proceso por terminal) y **0,15 %** de CPU en reposo.

## Claude Code — engine externo y fuente de cuota

- **Qué es:** `claude -p --output-format stream-json --verbose` emite eventos `system/init`, `assistant`, `result` y **`rate_limit_event`** con `unifiedWindows.five_hour/seven_day` (`utilization`, `resetsAt`). Lo observé con 2.1.283, y el evento aparece incluso cuando el estado es `allowed`.
- **Lección para v2:** el engine Claude Code de MendCode es un cliente de esa interfaz oficial. Obtiene la cuota sin tocar credenciales.
- **Medido:** Claude Code 2.1.283 ocupa **275 MB** en 1 terminal, incluidos sus MCP (177 MB el proceso principal).

## OpenCode upstream — lo que no hay que repetir

- **Megathread de memoria (oc#20695) y fugas múltiples (oc#16697):** más de 20 PRs para parchear listeners sin desuscribir, Maps sin eviction, timers sin limpiar, sesiones visitadas retenidas, subagentes no liberados, streams SSE, procesos zombie, MCP inactivos, stderr de LSP, WAL sin checkpoint y `cache_size` de 64 MB. **Lección:** la gestión de recursos no puede depender de la disciplina de cada PR. Todo recurso nace dentro de un `Scope` con dueño, y hay tests de soak que comparan la memoria base.
- **Event log sin retención (oc#33356):** snapshots completos de mensaje en cada `message.updated` (440 KB de media) acabaron en una DB de 13 GB. **Lección:** los eventos son deltas pequeños; los snapshots se guardan aparte, con compactación y retención; hay un presupuesto de disco por sesión.
- **CPU al 100 % en streaming con sesiones largas (oc#6172):** el text buffer de OpenTUI recalcula todas las líneas virtuales en cada token. El issue se cerró por inactividad y no hay arreglo confirmado. **Lección:** v2 no delega la virtualización al framework. Los mensajes terminados se congelan en bloques con altura cacheada, solo el ítem activo se re-renderiza, y en F1 hay un spike que compara OpenTUI con un renderer diferencial (T10a).
- **Sesiones atascadas que sobreviven a reinicios (oc#43277):** estado derivado persistido. **Lección:** I15.
- **Stream congelado con el socket inactivo (oc#29129):** **Lección:** watchdog de inactividad por stream (I12).
- **Cola:** prompts encadenados ejecutados juntos (oc#3098) y cola descartada al interrumpir (oc#5333). **Lección:** la cola es del actor y su política al interrumpir es explícita y configurable.

## OpenTUI — plataforma de UI

- Es independiente de OpenCode. Medido: un cliente mínimo con `@opentui/core` 0.5.11 ocupa **51 MB** de memoria física.
- Riesgo conocido: el rendimiento del text buffer con transcripts largos (oc#6172). Se valida en el spike T10a antes de comprometerse.
- Nota operativa: tu pnpm tiene `minimumReleaseAge`, así que la 0.5.12 (publicada el 22-sep) queda bloqueada hasta que pase el corte. Hay que fijar versiones que ya lo superen.

## Runtime base

- Un daemon Bun 1.3.13 mínimo (bun:sqlite en WAL + socket unix) ocupa **≈ 8 MB** de memoria física (24 MB RSS). El coste de v1 no lo pone Bun: lo pone la arquitectura.
