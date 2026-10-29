# MendCode 2 — Conversación completa consolidada + investigación + visión + plan maestro

> Nota histórica: este documento se escribió cuando el producto se llamaba "MendCode 2". Hoy el producto es MendCode (repositorio `MendCode/MendCode`) y el producto público anterior es "legacy MendCode". El texto se conserva tal como era; ver `docs/design/rename-inventory.md`.

**Fecha de consolidación:** 26 de septiembre de 2026  
**Objetivo de este documento:** reunir en un solo archivo Markdown toda la conversación sustantiva de este chat sobre el remake de MendCode, incluyendo la investigación de repositorios de referencia, lo observado en el repositorio actual de MendCode y su web, todos los problemas/ideas que fueron apareciendo en la conversación por voz, y el plan técnico completo para reconstruir MendCode desde cero como un harness propio.

> **Nota sobre la transcripción:** este documento preserva **todo el contenido sustantivo** de la conversación y lo reorganiza para que sea utilizable como especificación de producto/arquitectura. Las respuestas de voz puramente de seguimiento como “ajá”, “claro”, “sí”, “mhm”, etc. se condensan porque no añaden información técnica. Las ideas, requisitos, ejemplos, dudas, preocupaciones, decisiones y propuestas sí están todas incluidas.

---

# 0. Resumen ejecutivo

La conversación empezó con una búsqueda muy concreta:

> encontrar un fork/proyecto de OpenCode “pero minimalista como Pi”, para usarlo como referencia o base conceptual y eventualmente rehacer MendCode como un harness realmente propio.

Durante la investigación aparecieron varios repositorios:

- `pi-zentui`: Pi con TUI estilo OpenCode.
- `Orin / coding_agent`: harness propio, TypeScript, OpenTUI, inspirado por Pi, Nanocoder y OpenCode.
- `PUM`: agent loop de Pi + OpenTUI.
- `zerostack`: coding agent minimalista en Rust inspirado por Pi y OpenCode.
- `codehamr`: coding agent todavía más mínimo.
- `OpenTUI`: la biblioteca TUI utilizada por OpenCode, independiente y MIT.

La primera conclusión fue que **no convenía simplemente forkear OpenCode** si el objetivo final era poder decir con precisión que el runtime/harness de MendCode fue implementado de forma independiente.

Luego se revisó el MendCode actual:

- `MendCode/MendCode`
- `Obed0101/MendCode-Web`
- screenshots reales
- README
- docs de arquitectura
- feature map
- package index
- source map
- changelog
- plugins/widgets
- mflow
- Usage Insights
- Memory/Dream
- Loop Workflows
- Changes Review
- provider bridges
- etc.

La observación central fue:

> MendCode ya no es “solo un fork con branding”; tiene muchísimas ideas propias. Sin embargo, el runtime sigue teniendo una base OpenCode muy grande y eso ha creado complejidad, consumo de RAM, capas de compatibilidad, estados compartidos y bugs difíciles de eliminar.

A partir de la conversación por voz, la visión cambió de:

> “quiero una base como Pi/OpenCode para rehacer MendCode”

a:

> **“quiero MendCode 2 como un harness propio desde cero, tan liviano y extensible como Pi, pero capaz de llegar a ser tan completo visualmente como Grok/OpenCode/Codex, manteniendo las ideas únicas de MendCode y corrigiendo sus problemas estructurales.”**

La decisión arquitectónica más importante del plan final es:

> **MendCode 2 debe tener un único runtime/backend local muy liviano (daemon), y uno o varios clientes TUI pequeños que se conecten a él.**

Esto permite:

- múltiples terminales viendo el mismo chat;
- menos RAM;
- un solo writer a la DB;
- Dream separado de la conversación foreground;
- workflows/loops separados del estado del chat;
- páginas/usage/memory leyendo proyecciones sin bloquear la sesión;
- side chats;
- panel de sesiones;
- clientes futuros web/desktop;
- engines externos como Claude Code/Codex;
- relay remoto;
- sync multi-terminal;
- mejor recovery;
- menos race conditions.

---

# 1. Punto de partida de la conversación

La necesidad original fue encontrar algo equivalente a:

> “OpenCode pero minimalista como Pi”

porque el objetivo era disponer de una base conceptual para reconstruir MendCode.

La intención no era simplemente rebrandear OpenCode.

La intención era llegar a una situación donde MendCode pudiera describirse como:

> un harness de coding agent propio, diseñado e implementado por MendCode, aunque inspirado por ideas públicas de Pi, OpenCode, Grok, Codex, Claude Code, Orin, etc.

---

# 2. Repositorios investigados

## 2.1 `pi-zentui`

Repositorio encontrado como un match casi literal del concepto:

> **“Opencode-style TUI for Pi”**

La importancia de `pi-zentui` no es solamente visual.

La idea útil es que separa superficies:

- editor/composer;
- mensajes;
- thinking;
- working line;
- footer;
- presets.

Esto sirve como referencia para que MendCode pueda tener:

- Minimal;
- Balanced;
- Full;

sin tener tres productos distintos.

Repositorio:

- https://github.com/lmilojevicc/pi-zentui

---

## 2.2 Orin / `coding_agent`

Repositorio:

- https://github.com/thetombrider/coding_agent

Es probablemente la mejor referencia arquitectónica.

Características observadas:

- TypeScript;
- OpenTUI;
- provider abstraction;
- agent loop propio;
- tools propias;
- approval policy;
- sessions;
- compaction;
- subagents;
- checkpoints;
- MCP;
- TUI;
- fake/faux provider;
- roles de modelos;
- aislamiento.

Su SPEC declara Pi, Nanocoder y OpenCode como referencias y deja explícito:

> estudiar los enfoques, no copiar el código literalmente.

Esto encaja muy bien con la estrategia para MendCode 2.

---

## 2.3 PUM

Repositorio:

- https://github.com/eugen1763/Pum

Concepto:

> agent loop basado en Pi + OpenTUI para rendering.

Sirve como prueba de que:

- la experiencia visual tipo OpenCode;
- y el core agent loop;

pueden desacoplarse.

No sería la base final de MendCode porque sigue utilizando Pi para el loop, pero sí una buena referencia.

---

## 2.4 Zerostack

Repositorio:

- https://github.com/gi-dellav/zerostack

Descripción muy cercana a lo buscado:

> “Minimal coding agent written in Rust, inspired by pi and opencode.”

Tiene:

- loop;
- providers;
- tools;
- permissions;
- sessions;
- compaction;
- MCP;
- worktrees;
- memory;
- hooks;
- subagents;
- TUI.

Problema:

- licencia GPL-3.0.

Conclusión:

> excelente para estudiar, no recomendable como base directa si MendCode quiere máxima libertad de licenciamiento/comercialización.

---

## 2.5 Codehamr

Fue encontrado como otra alternativa aún más minimalista.

Sirve como referencia del extremo:

> cuánto puede reducirse un harness funcional.

---

## 2.6 OpenTUI

Repositorio:

- https://github.com/anomalyco/opentui

Conclusión:

> **sí conviene seguir usando OpenTUI.**

OpenTUI es independiente de OpenCode.

Que OpenCode use OpenTUI no significa que un producto construido con OpenTUI sea un fork de OpenCode.

OpenTUI da:

- core rápido;
- Solid renderer;
- terminal layout;
- mouse;
- keyboard;
- scroll;
- imágenes;
- rendering moderno.

La combinación propuesta para MendCode 2:

- TypeScript;
- Bun;
- Solid;
- `@opentui/core`;
- `@opentui/solid`;
- Zod;
- Vercel AI SDK detrás de una interfaz propia;
- Vitest.

---

# 3. Qué se descubrió al revisar MendCode actual

Se revisó el repo público:

- `MendCode/MendCode`

y el repo web:

- `Obed0101/MendCode-Web`

además de screenshots y documentación.

## 3.1 Identidad visual actual

La identidad de MendCode ya está bastante definida:

- fondo casi negro/verde;
- verde/mint;
- líneas finas;
- paneles rectangulares;
- wordmark `MENDCODE`;
- mucho espacio negativo;
- prompt en la parte inferior;
- status row;
- Agent View;
- estilo técnico/industrial;
- website consistente con la terminal.

Conclusión:

> **la identidad visual no es el problema principal.**

---

## 3.2 Arquitectura actual

Los propios docs actuales dicen que MendCode es un downstream/derivative del codebase de OpenCode.

La estructura actual incluye:

```text
src/mendcode/packages/opencode/
```

El public CLI de MendCode termina entrando en el runtime heredado/adaptado.

Conceptualmente:

```text
mendcode CLI
    ↓
MendCode control plane
    ↓
public-bin.ts
    ↓
OpenCode-derived runtime
    ↓
session/provider/tools/database/TUI
```

MendCode tiene una capa enorme propia encima, pero el engine base sigue siendo heredado.

---

## 3.3 Tamaño actual

Se comparó aproximadamente el `package.json` del runtime actual con Orin.

MendCode actual:

- ~102 runtime dependencies;
- ~31 dev dependencies.

Orin:

- ~22 runtime dependencies;
- ~7 dev dependencies.

Esto no demuestra por sí solo performance, pero sí refleja la diferencia de superficie.

Conclusión:

> MendCode 2 necesita un budget explícito de dependencias y lazy loading.

---

# 4. Las cosas que NO quieres perder del MendCode actual

Durante la conversación se fueron enumerando muchísimas.

Esta sección es importante porque el objetivo del rewrite **no es hacer un Pi clone**.

El objetivo es mantener lo único de MendCode.

---

# 5. Feature: múltiples terminales y sesiones sincronizadas

Una idea importante:

> tener un backend que posea todos los chats/sesiones y permitir abrir varias terminales sobre el mismo chat.

Ejemplo:

```text
Terminal A ─┐
Terminal B ─┼── same session
Terminal C ─┘
```

Todos sincronizados.

Esto se parece más a un sistema cliente-servidor local que a una CLI clásica.

Requisito:

- si una terminal manda un mensaje;
- las otras ven el mensaje;
- ven el model stream;
- ven tool calls;
- ven approvals;
- ven state changes;
- reconnect funciona;
- no se duplican turns.

---

# 6. Feature: peer communication / relay

Se mencionó que dos terminales/agentes puedan hablar entre ellas.

Esto se relaciona con mflow y relay.

Actualmente mflow ya hace coordinación de archivos mediante locks/leases y puede usar relay local/remoto.

Pero para v2 hay que distinguir:

## 6.1 Same-session synchronization

Varios clientes viendo **una misma sesión**.

```text
TUI ↔ daemon
```

## 6.2 Agent peer communication

Dos agentes distintos comunicándose.

```text
Agent A ↔ Agent B
```

## 6.3 Remote relay

Otra máquina.

```text
Machine A
    ↕
encrypted relay
    ↕
Machine B
```

Son tres problemas diferentes.

No deben mezclarse en un solo concepto.

---

# 7. Feature: páginas TUI

MendCode ya tiene muchas páginas/surfaces abiertas mediante slash commands.

Ejemplos:

- `/changes`
- `/usage`
- `/memory`
- `/loops`
- `/sessions`
- `/models`
- `/agents`
- etc.

La intención es:

> mantenerlas, pero rehacerlas mejor y más rápidas.

Todas deberían utilizar un design system TUI común.

---

# 8. Feature: Usage Insights

La página Usage actual ya contiene:

- tokens;
- sesiones;
- AI time;
- tools;
- agents;
- models;
- daily activity;
- cache mix;
- heatmap estilo GitHub;
- selected-day detail;
- etc.

Problemas señalados:

1. no muestra realmente el remaining usage de tu suscripción;
2. el heatmap puede tardar demasiado;
3. no debería hacer scans caros cuando se abre;
4. debería separar local usage, API cost y subscription quota.

---

# 9. Heatmap estilo GitHub

Ya existe una versión en MendCode.

La idea es mantenerla.

Pero debe funcionar con una proyección incremental.

NO:

```text
open /usage
→ scan toda la historia
→ agregar
→ render
```

SÍ:

```text
cada evento
→ actualiza usage_daily
```

Luego:

```sql
SELECT ...
```

al abrir la página.

Objetivo:

- apertura casi instantánea.

---

# 10. Feature: Dream

Dream fue identificado como una de las ideas especiales de MendCode.

No quieres perderlo.

Dream:

- trabaja en segundo plano;
- analiza memory/context;
- propone consolidación;
- mantiene memoria;
- puede ejecutar scheduled work.

Pero Dream actualmente también fue ejemplo de un problema grave.

---

# 11. Bug crítico mencionado: Dream + queued message

Ejemplo real descrito:

1. la IA está terminando una iteración;
2. hay un mensaje del usuario en queue;
3. Dream empieza a hacer trabajo en background;
4. el estado de abajo se queda en `generating`;
5. el mensaje queued no arranca;
6. el chat parece bloqueado.

Este bug se convirtió en una de las principales señales de que:

> no hay que seguir metiendo fixes alrededor del mismo estado compartido.

En v2, Dream debe estar arquitectónicamente incapaz de modificar el estado foreground.

---

# 12. Feature: compaction

Se expresó que la compaction actual de MendCode parece de las mejores que has probado.

Por tanto:

> conservar el **comportamiento deseado**, pero reimplementar su arquitectura.

La compactación debe preservar:

- intent actual;
- tasks unresolved;
- plan;
- queued messages;
- latest file state;
- important images;
- recent context;
- tool state relevante.

Pero no debe tener la capacidad de:

- replay accidental;
- generar duplicados;
- corromper queue state;
- apoderarse del state del foreground.

---

# 13. Feature: setup mejorado

El setup actual se siente demasiado grande/complicado.

La visión nueva:

## Paso 1 — Appearance

Elegir:

- Minimal
- Balanced
- Full

con preview.

## Paso 2 — AI

Elegir:

- subscription;
- API;
- external harness.

Y luego:

- Claude Code;
- Codex;
- Anthropic API;
- OpenAI API;
- OpenRouter;
- etc.

## Paso 3 — Intelligence preset

Ejemplos:

- Automatic
- Token Saver
- Balanced
- Maximum Quality
- Custom

## Paso 4 — Optional modules

Ejemplo:

- Memory on/off;
- Dream on/off;
- MCP on/off;
- Computer Use on/off;
- background jobs on/off.

Y listo.

---

# 14. Feature: Model Recipes

Una idea importante del setup:

> una persona nueva no debería tener que configurar manualmente un modelo para title, summary, compaction, build, plan, review, memory, Dream, permission review, etc.

Debe existir un registry comunitario/oficial de recipes.

Ejemplo conceptual:

```text
Claude Max — Balanced

main        Sonnet
build       Sonnet
review      Opus
plan        Opus
title       Haiku
summary     Haiku
compaction  Haiku
memory      Haiku
```

O presets equivalentes para Codex/OpenAI/etc.

Los recipes deben:

- ser versionados;
- actualizarse;
- no cambiar config del usuario silenciosamente;
- poder ser mantenidos por la comunidad.

Ejemplo:

```text
recipe: claude-max-balanced@2026.09
```

---

# 15. TUI Minimal / Balanced / Full

Esta es una pieza central de la visión.

No son tres productos.

Son tres presentaciones del mismo runtime.

## 15.1 Minimal

Inspirado por Pi.

Casi nada de chrome.

```text
assistant output
tool output
assistant output

────────────────────
> prompt
```

Ideal para:

- SSH;
- servidores;
- laptops pequeñas;
- gente que quiere casi cero UI.

---

## 15.2 Balanced

Probablemente el default.

```text
project · model · context
─────────────────────────

conversation

─────────────────────────
> prompt
mode · agent · status
```

Más información que Minimal.

Menos decoración que Full.

---

## 15.3 Full

La visión:

> tan completa y bonita como Grok terminal.

Puede incluir:

- rich thinking;
- icons;
- grouped tools;
- image previews;
- sidebar;
- Agent View;
- widgets;
- mascot;
- context visualization;
- mouse;
- pages;
- full menus;
- richer reasoning presentation.

El “Full actual” de MendCode no se considera terminado.

Debe mejorar.

---

# 16. Grok como referencia visual

Se mencionó explícitamente que la terminal de Grok DX / Grok Build tiene una de las mejores experiencias visuales vistas.

Cosas a estudiar como inspiración:

- reasoning presentation;
- settings menu;
- iconografía;
- agrupación de herramientas;
- status presentation;
- tool grouping;
- densidad visual.

La intención NO es copiar Grok.

La intención es que:

> `MendCode Full` alcance ese nivel de calidad visual.

---

# 17. Images dentro del chat

Pi mostró una feature que gustó mucho:

> si el agente está viendo una imagen, el usuario también puede verla renderizada dentro del terminal.

MendCode Full debería soportarlo.

Fallback:

- Kitty;
- Sixel;
- block rendering;
- metadata text si no hay soporte.

Ejemplo:

```text
[Viewed image]

┌─────────────────────────────┐
│         image preview       │
└─────────────────────────────┘
```

---

# 18. Artifact system

No limitarse a “imágenes”.

Formalizar:

```text
Artifact
 ├─ image
 ├─ diff
 ├─ markdown
 ├─ plan
 ├─ file
 ├─ graph
 ├─ benchmark
 └─ report
```

Tool results pueden devolver references a artifacts.

El TUI decide cómo renderizarlos.

El web client futuro también.

---

# 19. Custom tools + custom renderers

Ejemplo dado:

se agregó una tool de graphs a Pi y se configuró para que:

> en vez de mostrar JSON, renderizara un graph ASCII directamente.

Eso debe ser feature first-class de MendCode.

Concepto:

```ts
api.tools.register("graph", ...)
api.renderers.tool("graph", {
  collapsed(),
  expanded(),
})
```

Entonces:

- tool data sigue siendo structured;
- renderer puede ser personalizado.

Casos:

- graph;
- DB;
- network;
- Docker;
- Kubernetes;
- Git;
- benchmark;
- memory graph;
- dependency tree.

---

# 20. Widgets

MendCode actual ya tiene widgets custom.

Mencionado:

- `Ctrl+T`;
- cuadraditos arriba del chat input;
- scratch pad;
- listas;
- incluso juegos;
- custom widgets.

Eso debe mantenerse y mejorar.

Widgets posibles:

- scratchpad;
- todo;
- timer;
- git status;
- server monitor;
- token budget;
- agent status;
- games;
- custom company tool.

---

# 21. TUI Plugin SDK

La documentación actual de MendCode ya soporta una API bastante avanzada:

- widgets;
- slots;
- shell-backed widgets;
- overlays;
- routes;
- themes;
- dialogs;
- commands;
- footer entries;
- custom UI.

En v2 esto se debe reimplementar como API oficial, pero más limpia.

Objetivo:

> built-ins y plugins usan las mismas primitivas.

---

# 22. Side Chat

Una idea nueva importante:

> poder abrir un pequeño chat secundario que vea el contexto actual pero no forkear toda la conversación.

Caso:

el main agent está trabajando y quieres preguntar:

> “oye, creo que el problema es X, ¿tiene sentido?”

Side Chat:

- recibe snapshot;
- ve últimos mensajes;
- current tool;
- current plan;
- active files;
- git diff summary;
- context del main session.

Por default:

- read-only;
- no write;
- no shell peligroso;
- no muta main conversation.

Acciones opcionales:

- Send advice to main;
- Create task;
- Save note;
- Discard.

---

# 23. External Harnesses / Engines

Idea:

> poder usar Claude Code, Codex u otros harnesses dentro de la TUI de MendCode.

Esto es parecido conceptualmente a T3 Code, pero en terminal.

No confundir `Provider` con `Engine`.

## Provider

Ejemplos:

- Anthropic API;
- OpenAI API;
- OpenRouter;
- Google;
- OpenAI-compatible.

## Engine/Harness

Ejemplos:

- Mend Native;
- Claude Code;
- Codex;
- Pi;
- ACP agent.

Interfaz conceptual:

```ts
interface Engine {
  startSession()
  resumeSession()
  send()
  cancel()
  events()
  capabilities()
}
```

Mend Native = harness propio.

Claude Code engine = MendCode actúa como frontend/cliente sobre el harness oficial.

Importante:

- utilizar interfaces oficiales;
- no copiar tokens;
- no OAuth spoofing;
- no hacks internos de credenciales.

---

# 24. Package/Profile system

Esto fue descrito como parte de la idea original de MendCode.

Ejemplo:

## Personal Profile

Contiene:

- skills;
- prompts;
- plugins;
- MCP;
- context;
- memory;
- theme;
- widgets;
- models;
- workflows;
- permissions.

## Company Profile

Contiene:

- company skills;
- company prompts;
- private tools;
- company MCP;
- company memory;
- company policies;
- company model recipes;
- workflows;
- TUI config.

Cambiar:

```bash
mendcode profile use personal
```

o:

```text
/profile
```

Debe ser instantáneo.

---

# 25. Package sources

Pueden venir de:

```text
git:https://...
github:org/repo
local:/...
registry:mendcode/...
```

Ejemplo:

```text
company-pack@1.4.3
```

Update muestra diff antes de aplicar.

---

# 26. Secrets y packages

Los packages NO llevan secrets.

Solo referencias:

```yaml
credentials:
  jira: secret://jira-company
```

El secret store local los resuelve.

Así un repo privado de empresa puede compartir el setup sin exponer tokens.

---

# 27. Memory scopes

Para que Personal y Company no se mezclen:

```text
session
project
profile
user
team
```

Ejemplo:

```text
profile:personal
```

vs:

```text
profile:cognix
```

Nunca deben cruzarse accidentalmente.

---

# 28. Loop System

Ya existe `/loop`.

Debe mantenerse.

Un loop es:

```text
objective
trigger
budget
completion condition
```

Ejemplos:

- cada hora;
- diariamente;
- max-goal;
- recurring;
- fixed count.

---

# 29. Workflow System

Ya existe `/workflow`.

Debe mantenerse y rehacerse sobre una base común.

Workflow = DAG.

Ejemplo:

```text
      A
     / \
    B   C
     \ /
      D
```

Cada task:

- role;
- model;
- tools;
- inputs;
- outputs;
- retry;
- completion criteria.

---

# 30. Un solo JobScheduler

Dream, Loops, Workflow, Maintenance no deben tener scheduler separado.

Un solo:

```text
JobScheduler
```

Tipos:

```text
job.type = dream
job.type = loop
job.type = workflow
job.type = maintenance
```

Estados:

```text
scheduled
running
sleeping
waiting_input
paused
done
error
```

Crítico:

> los jobs no controlan `session.foregroundState`.

---

# 31. Background jobs deben poder apagarse de verdad

Disabled significa:

- cero worker;
- cero timer;
- cero network connection;
- cero model call;
- cero poll.

No:

> “feature disabled pero worker esperando”.

---

# 32. Resource modes

Se propuso:

```text
resourceMode:
  low
  normal
  high
```

## Low

- no Dream automático;
- caches pequeños;
- max 1 subagent;
- no heavy image cache;
- lower FPS;
- background minimized.

## Normal

Default.

## High

- más parallel agents;
- larger caches;
- richer background features.

---

# 33. RAM y performance

Se explicó que el MendCode actual puede consumir más de 1–2 GB cuando hay varias terminales.

Objetivo:

> MendCode 2 debe sentirse tan liviano como Pi/Codex.

No se fijan estos números como promesas públicas, pero sí como budgets internos iniciales.

Ejemplo:

| Estado | Budget objetivo inicial |
|---|---:|
| daemon idle | 100–150 MB RSS |
| 1 TUI idle | +40–70 MB |
| sesión activa | pequeño incremental |
| 3 TUIs mismo chat | idealmente <250–300 MB total |
| Dream off | 0 worker |
| page cerrada | 0 expensive work |

Hay que medir desde el primer día.

---

# 34. Arquitectura principal propuesta

El cambio más importante de todo el plan:

> **un solo runtime/backend local y clientes TUI livianos.**

Nombre interno posible:

```text
mendd
```

Flow:

```text
mendcode
   ↓
¿mendd corriendo?
   ├─ no → start
   └─ sí → connect
```

`mendd` posee:

- sessions;
- DB;
- engines;
- tool execution;
- permissions;
- context;
- memory;
- Dream;
- workflows;
- loops;
- usage projections;
- packages;
- relay;
- workers.

La TUI posee:

- rendering;
- input;
- mouse;
- keyboard;
- event subscription.

---

# 35. Por qué un daemon único

Con tres terminales:

```text
Terminal A ─┐
Terminal B ─┼── mendd ── ses_123
Terminal C ─┘
```

No necesitas:

- tres DB writers;
- tres Dream workers;
- tres model clients;
- tres context managers;
- tres memory engines.

Resultado:

- menos RAM;
- menos races;
- mejor sync;
- mejor reconnect;
- mejor observability.

---

# 36. SessionActor

Cada sesión debe ser poseída por un único actor.

```text
SessionActor
```

Tiene:

```text
mailbox
```

Solo procesa un foreground command a la vez.

Ejemplo:

```text
M1 user message
→ generating

M2 arrives
→ queue
```

Luego:

```text
M1 complete
→ commit
→ claim M2
→ M2 starts
```

Dream nunca toca la mailbox.

---

# 37. Foreground session states

```text
idle
queued
generating
tool
waiting_approval
compacting
cancelling
error
```

Solo `SessionActor` cambia estos estados.

---

# 38. Background job states

```text
scheduled
running
sleeping
waiting_input
paused
done
error
```

Completamente distintos.

---

# 39. El bug Dream+queue se hace imposible

Ejemplo válido:

```text
Session ses_123
foreground = idle

Dream job dream_442
background = running
```

Dream no tiene acceso a:

```ts
session.foregroundState = "generating"
```

porque esa API simplemente no existe.

---

# 40. Event log como contrato central

Cada ejecución produce eventos.

Ejemplo:

```text
session.created
user.message
turn.started

model.started
model.delta
model.completed

tool.requested
approval.requested
approval.resolved
tool.started
tool.output
tool.completed
tool.failed

context.compacted

agent.spawned
agent.completed

turn.completed
turn.cancelled
turn.failed
```

Dream:

```text
memory.proposal.created
```

Workflow:

```text
workflow.task.started
workflow.task.completed
```

---

# 41. Multi-client synchronization

Cada TUI tiene:

```text
clientId
terminalId
sessionId
cursorSeq
```

El daemon puede enviar:

```text
events after seq N
```

Al reconnect:

- no replay incorrecto;
- no duplicate;
- no lost tool state.

---

# 42. Presence

Opcionalmente:

```text
3 viewers
```

o:

```text
Nora@Mac
Terminal 2
Remote laptop
```

También:

```text
read-only attach
```

---

# 43. SQLite WAL

Para v2 se propuso SQLite porque ahora hay un daemon único.

Regla:

> `mendd` es el único writer.

Tablas conceptuales:

```text
sessions
events
messages
jobs
memories
packages
usage_daily
usage_models
usage_tools
kv
```

No múltiples procesos escribiendo la misma DB.

---

# 44. JSONL export

Aunque SQLite sea el storage interno:

```bash
mendcode session export ses_x --jsonl
```

para:

- portability;
- debugging;
- migration;
- reproducibility.

---

# 45. Provider vs Engine

Arquitectura:

```text
MendCode TUI
      │
      ▼
EngineAdapter
      │
 ┌────┼─────────────┐
 │    │             │
Mend Claude Code   Codex
Native
```

`Mend Native` es el harness propio.

---

# 46. Native Engine debe ser extremadamente pequeño

No conoce:

- Usage;
- Dream;
- packages;
- widgets;
- pages;
- mflow;
- weather;
- Agent View.

Loop:

```text
user
 ↓
context
 ↓
model
 ↓
tool call?
 ├─ no → done
 └─ yes
      ↓
   permission
      ↓
     tool
      ↓
   result
      ↓
    model
```

---

# 47. Model Roles

Mantener:

```text
main
plan
build
explore
review
subagent
title
summary
compaction
memory
dream
permission
sidechat
```

Pero con fallback.

Si un role no está definido:

```text
use main
```

---

# 48. El usuario nuevo no ve roles individuales

El usuario ve:

```text
Token Saver
Balanced
Maximum Quality
```

Los roles detallados viven en Advanced.

---

# 49. Repository layout v2

Propuesta:

```text
mendcode/
│
├── apps/
│   └── cli/
│
├── packages/
│   ├── protocol/
│   ├── kernel/
│   ├── daemon/
│   ├── store/
│   ├── engine-native/
│   ├── engine-sdk/
│   ├── provider-sdk/
│   ├── extension-sdk/
│   ├── tui/
│   └── testkit/
│
├── features/
│   ├── changes/
│   ├── usage/
│   ├── memory/
│   ├── dream/
│   ├── agents/
│   ├── loops/
│   ├── workflows/
│   ├── packages/
│   └── computer/
│
├── engines/
│   ├── claude-code/
│   ├── codex/
│   └── acp/
│
├── specs/
├── fixtures/
├── benchmarks/
└── docs/
```

---

# 50. Extension primitives

Primitivas TUI:

```text
Surface
Panel
Card
Tabs
List
Table
Tree
Viewport
Text
Markdown
Code
Diff
Graph
Heatmap
Image
Prompt
StatusRow
Sidebar
Overlay
Dialog
Toast
WidgetDock
```

Built-in features deben usar lo mismo que plugins.

---

# 51. Dos clases de extensions

## 51.1 Trusted TypeScript extension

Puede:

- tools;
- commands;
- hooks;
- pages;
- widgets;
- custom OpenTUI components;
- renderers;
- overlays;
- themes.

Máxima flexibilidad.

## 51.2 Portable declarative extension

Devuelve structured data.

Ejemplo:

```json
{
  "type": "graph",
  "nodes": [],
  "edges": []
}
```

MendCode renderer decide cómo mostrarlo.

Ventaja:

- TUI;
- web;
- desktop;
- mobile;

pueden renderizar el mismo artifact.

---

# 52. Responsive TUI

Breakpoints semánticos propuestos:

```text
< 70 cols       compact
70–109          normal
110–149         wide
>=150           ultrawide
```

No crear pages para 180 cols y arreglarlas después.

---

# 53. `/changes` responsive

Wide:

```text
┌ files ───────┬ diff ───────────────────┐
│              │                         │
│              │                         │
└──────────────┴─────────────────────────┘
```

Compact:

```text
┌ file selector ────────────────────────┐
└───────────────────────────────────────┘

diff
```

---

# 54. Sidebar

Config:

```text
sidebar:
  mode: auto | always | hidden
  position: left | right
```

Full:

```text
PROJECT
  chat A   ● generating
  chat B   ○ idle
  chat C   ! approval
```

Balanced:

- panel/rail opcional.

Minimal:

- hidden.

---

# 55. Project/session panel

Ejemplo:

```text
PROJECTS

MendCode
  ● Rewrite architecture
  ○ Plugin tests
  ! Provider issue

Vorlen
  ● Tauri bug

GITSA
  ○ Modbus parser
```

Movible izquierda/derecha.

En narrow:

- overlay.

---

# 56. Page system

Pages built-in propuestas:

```text
/usage
/changes
/memory
/sessions
/agents
/loops
/workflows
/models
/providers
/packages
/mcp
/context
/settings
/diagnostics
```

Plan Review puede seguir siendo modal/workspace especial.

---

# 57. `/context`

Una página nueva útil.

Debe mostrar cuánto contexto está ocupando cada fuente.

Ejemplo:

```text
System          4.2k
Project         7.1k
Memory          2.3k
Summary         9.4k
Recent turns    31k
Tools           5.2k
───────────────────
Total           59k
```

---

# 58. Usage v2

Separar:

## Local Usage

MendCode sabe:

- tokens;
- models;
- tools;
- sessions;
- cache;
- AI time.

## API Cost

Si pricing existe:

- estimated cost.

## Subscription Quota

Interfaz:

```ts
interface QuotaSource {
  getQuota()
}
```

Si el provider/harness expone oficialmente quota:

- mostrar.

Si no:

```text
Quota not exposed by provider
```

No inventar percentages.

No scraping peligroso.

---

# 59. Usage projection

Event:

```text
model.completed
```

actualiza:

```text
usage_daily
```

La página lee esa proyección.

No scan histórico al abrir.

---

# 60. Memory architecture

Scopes:

- session;
- project;
- profile;
- user;
- team.

Memory es un service separado.

ContextBuilder pide:

```text
retrieve relevant memory
```

No es dueño del session state.

---

# 61. Dream architecture

```text
JobScheduler
    ↓
DreamJob
    ↓
read events/memory
    ↓
generate proposals
    ↓
save proposal
```

Políticas:

```text
run only when idle
pause during foreground generation
max concurrency = 1
time limit
model budget
resource mode aware
```

---

# 62. Changes Review

Debe seguir.

Arquitectura:

```text
GitService.diff()
       ↓
Changes feature
       ↓
TUI route
```

Comentarios:

```text
review.comment.added
```

ContextBuilder los recoge en el siguiente turn.

No se inyectan dentro de un token stream ya iniciado.

---

# 63. Plan Review

Debe seguir.

Arquitectura:

```text
agent
 ↓
artifact.created(type="plan")
 ↓
Plan Review
 ↓
approve/edit/comment/reject
 ↓
artifact.reviewed
 ↓
continue
```

No debe estar acoplado profundamente al session internals.

---

# 64. Agent View

Debe leer de un registry explícito:

```text
AgentRegistry
```

Ejemplo:

```text
agent_1
 role build
 state tool
 parent session_1

agent_2
 role explore
 state idle
```

No inferir agentes desde logs.

---

# 65. Computer Use

Debe ser una capability separada.

```text
computer.screenshot
computer.click
computer.move
computer.drag
computer.type
computer.key
computer.scroll
computer.window
```

Adapters:

- macOS;
- Windows;
- Linux;
- Browser;
- Remote.

---

# 66. Computer Use quality

Benchmarkear:

- click accuracy;
- coordinate scaling;
- multi-monitor;
- window targeting;
- screenshot latency;
- scroll reliability;
- retry;
- recovery after layout shift.

No solo:

> “se siente mejor”.

---

# 67. Image preview + Computer Use

Flow:

```text
capture
   ↓
artifact:image
   ├─ model sees image
   └─ TUI renders image
```

Así puedes ver qué está mirando la IA.

---

# 68. Performance rules de TUI

```text
virtualize transcript
bounded tool output
lazy load pages
lazy load routes
do not mount hidden pages
no model SDK in TUI
no DB scan in TUI
no background timers per component
lower FPS while idle
```

---

# 69. Transcript virtualization

Si hay 10,000 mensajes:

NO:

- 10,000 Solid nodes montados.

SÍ:

- viewport;
- overscan;
- on-demand rendering.

---

# 70. Animations

Si un spinner está fuera del viewport:

- no tick.

Page cerrada:

- no render.

Terminal unfocused:

- reduce animation.

---

# 71. Background priorities

```text
P0 user input
P1 foreground agent
P2 approvals
P3 active workflow
P4 compaction
P5 Dream
P6 indexing/maintenance
```

Si P0/P1 aparecen:

- P5/P6 yield.

---

# 72. Plugin crash isolation

Si un plugin renderer falla:

```text
plugin failed: company.graph-renderer
```

El chat sigue.

El tool result se muestra en fallback generic representation.

Un plugin nunca debe tumbar toda la sesión.

---

# 73. Security de packages

Manifest:

```yaml
requires:
  shell: read
  network: true
  tools:
    - jira
```

Al instalar:

```text
This package requests:
✓ network
✓ custom tool execution
! shell command access
```

El usuario aprueba.

---

# 74. Workflows no deben secuestrar el chat

Un workflow tiene:

```text
root workflow session
```

Pero job-owned.

El main chat puede mostrar:

```text
Workflow #123 running
```

sin convertirse en:

```text
main session generating
```

---

# 75. Queue reliability

La queue es responsabilidad del SessionActor.

Nunca:

- Dream;
- Workflow;
- Memory;
- Usage;
- another TUI;

modifican directamente la queue.

---

# 76. Cancellation

Cada turn tiene:

```text
turnId
AbortController
state
activeModelRequest
activeToolProcesses[]
```

`Esc Esc` es UI behavior.

La API real:

```text
runtime.cancel(turnId)
```

Así un web client también puede cancelar exactamente igual.

---

# 77. State machine

```text
idle
 ↓
model
 ↓
approval?
 ↓
tool
 ↓
model
 ↓
completed

cualquier estado
 ↓ cancel
cancelled
```

---

# 78. Build process con varios modelos

Se habló de usar:

- Sol 6;
- Opus 5.5;
- Sonnet 5;
- Luna 6;

para construir el rewrite.

Propuesta:

## Architects

- Sol 6;
- Opus 5.5.

Uno diseña.

El otro intenta romper el diseño.

Antes de escribir código generan:

- ADRs;
- state machines;
- protocol;
- invariants;
- interfaces;
- failure tests.

---

# 79. División de trabajo por modelo

Conceptualmente:

## Sol / Opus

- kernel;
- concurrency;
- storage;
- security;
- scheduling;
- contracts;
- architecture review.

## Sonnet

- TUI;
- adapters;
- tools;
- pages;
- packages;
- workflows;
- substantial feature implementation.

## Luna

- tests;
- fixtures;
- migration;
- docs;
- repetitive adapters;
- provider metadata;
- screenshot fixtures;
- batch mechanical work.

---

# 80. No mandar “arregla MendCode” a muchos agentes

Cada worker debe recibir:

```text
Task ID
Goal
Allowed paths
Read-only paths
Forbidden paths
Contract version
Acceptance tests
```

Ejemplo:

```text
T27 — Usage Heatmap Projection

Allowed:
features/usage/projector.ts
features/usage/projector.test.ts

Read:
packages/protocol/**
packages/store/**

Forbidden:
packages/kernel/**
packages/protocol/**

Acceptance:
100k events projection...
no page-time history scan
tests pass
```

---

# 81. Worktree por task

```text
worktrees/
  T21-session-actor
  T22-sqlite-store
  T23-tui-transcript
  T24-tui-prompt
  T25-usage-projection
```

---

# 82. Contratos congelados

Carpetas como:

```text
packages/protocol
packages/kernel/contracts
```

no las cambian workers normales.

Si un worker necesita una modificación:

- RFC;
- architect review.

---

# 83. Clean rewrite methodology

No pedirle al builder:

> “refactoriza OpenCode hasta que ya no parezca OpenCode”.

Separar agentes:

## Legacy Miner

Puede leer:

- MendCode v1;
- OpenCode-derived internals;
- public docs;
- screenshots;
- tests.

Produce:

- behavioral spec;
- fixtures;
- test vectors;
- public behavior;
- known bugs.

## V2 Builder

Lee:

- specs;
- tests;
- fixtures;
- public docs;
- screenshots.

NO necesita leer old runtime internals.

Esto ayuda a que la nueva implementación sea realmente independiente.

---

# 84. Old MendCode como especificación ejecutable

Crear:

```text
legacy-feature-map.yaml
```

Ejemplo:

```yaml
feature: queued-prompts
status: rebuild
behavior:
tests:
screenshots:
known_bugs:
```

---

# 85. Clasificación de features

Estados:

```text
KEEP
REBUILD
IMPROVE
DEFER
DROP
```

Ejemplo:

| Feature | Acción |
|---|---|
| Agent loop | REBUILD |
| Queue | REBUILD |
| Compaction | KEEP behavior / REBUILD implementation |
| Dream | KEEP / REBUILD scheduling |
| Memory | KEEP / IMPROVE |
| Usage | KEEP / IMPROVE |
| Changes | KEEP |
| Plan Review | KEEP |
| Packages | KEEP / IMPROVE |
| TUI customization | KEEP / IMPROVE |
| mflow | compatibility first, native replacement later |
| TSM | DEFER |
| weather | optional plugin |
| OpenCode compatibility | DROP eventually |
| generated OpenCode config | DROP |
| donor runtime wrapper | DROP |

---

# 86. Fault tests imprescindibles

El bug descrito debe ser test.

```text
1. foreground turn running
2. submit second message
3. first turn ends
4. Dream starts same millisecond
5. assert queued message starts
6. Dream continues separately
7. foreground returns idle
```

Si Dream bloquea el queued message:

- test fail.

---

# 87. Multi-terminal test

```text
3 TUIs same session
TUI A disconnects
TUI B sends prompt
A reconnects
all events identical
```

---

# 88. Crash during tool

```text
daemon dies during tool
restart
tool marked interrupted
no duplicated execution
```

---

# 89. Workflow recovery

```text
workflow waiting approval
daemon restarts
approval remains waiting
```

---

# 90. Profile isolation test

```text
personal → company
personal memory unavailable
company memory available
```

---

# 91. Plugin error test

```text
custom renderer crashes
conversation still usable
```

---

# 92. Performance benchmark suite

```text
bench:tui-10k-messages
bench:3-clients
bench:usage-1m-events
bench:memory-10k
bench:100-turn-session
bench:background-idle
```

Guardar:

- RSS;
- CPU;
- startup ms;
- page open latency;
- event throughput.

---

# 93. Faux Engine / Fixture Mode

Debe existir desde temprano.

Ejemplos:

```bash
mendcode fixture home
mendcode fixture chat
mendcode fixture tools
mendcode fixture image
mendcode fixture usage
mendcode fixture memory
mendcode fixture changes
mendcode fixture plan
mendcode fixture agents
```

Todo determinista.

Sin API.

---

# 94. Golden screenshots

Las fixtures pueden producir screenshots reales.

Así:

```text
release binary
 ↓
fixture PTY
 ↓
screenshots
 ↓
MendCode-Web
```

La web deja de quedarse meses con screenshots viejos.

---

# 95. Website

No se considera necesario rehacer la identidad web desde cero.

Mantener:

- branding;
- colors;
- layout language;
- logo;
- workflow explanation;
- visual identity.

Pero mejorar la source of truth.

Website debe usar:

- release manifest;
- current screenshots;
- actual feature state.

---

# 96. Version drift

Se observó que screenshots del repo mostraban versiones viejas mientras el runtime iba más adelante.

V2 debe generar marketing assets desde releases reales.

---

# 97. Roadmap completo

---

## M0 — Freeze v1

Objetivo:

- congelar versión actual;
- tag exacto;
- export docs;
- screenshots;
- configs;
- public behavior;
- known bugs.

Crear:

```text
legacy-feature-map.yaml
```

No usar v1 como workspace de v2.

---

## M1 — Product & Protocol Specification

Crear:

```text
specs/
  product.md
  protocol.md
  sessions.md
  jobs.md
  context.md
  extensions.md
  packages.md
  ui.md
  performance.md
  security.md
```

Definir:

- IDs;
- events;
- commands;
- errors;
- capabilities;
- artifacts.

Nada de TUI todavía.

---

## M2 — Store + daemon

Construir:

```text
mendd
SQLite WAL
session actors
event stream
IPC
```

Test:

- multiple dummy clients;
- reconnect;
- sequence consistency.

---

## M3 — Mend Native Engine

Construir:

- faux provider;
- provider registry;
- read;
- write;
- edit;
- bash;
- grep;
- find;
- ls;
- permissions.

Headless primero.

Cuando esto funciona:

```text
mendcode run --headless
```

ya existe un harness real.

---

## M4 — Session Reliability

Construir:

- queue;
- cancellation;
- reconnect;
- resume;
- crash recovery;
- context;
- compaction;
- artifacts.

No avanzar hasta que sea estable.

---

## M5 — Minimal TUI

Solo:

- transcript;
- prompt;
- tool rendering;
- working indicator;
- model;
- minimal footer.

Debe sentirse tan rápido como Pi.

---

## M6 — Multi-client Sessions

Agregar:

- mismo chat en múltiples terminales;
- presence;
- reconnect;
- session rail;
- project sessions;
- read-only attach.

---

## M7 — TUI Platform

Agregar:

- Minimal;
- Balanced;
- Full;
- themes;
- custom renderers;
- widgets;
- pages;
- overlays;
- images;
- responsive layouts;
- sidebars.

---

## M8 — Setup + Model Recipes + Profiles

Agregar:

- 4-step setup;
- engine/provider selection;
- intelligence preset;
- package/profile selection;
- Personal/Company switching.

---

## M9 — Core Product Pages

Orden sugerido:

```text
/changes
/usage
/sessions
/context
/models
/packages
```

Porque son relativamente independientes.

---

## M10 — Memory + Dream

Portar comportamiento deseado:

- scopes;
- memory graph;
- proposals;
- Memory Center;
- Dream scheduler;
- side memory assistant.

Todo encima de JobScheduler.

---

## M11 — Agents + Loops + Workflows

Agregar:

- AgentRegistry;
- Task DAG;
- loops;
- workflow;
- scheduler;
- leases;
- waiting_input;
- durable recovery.

---

## M12 — Extension/Package Completeness

Agregar:

- custom tools;
- custom renderers;
- custom pages;
- widgets;
- games;
- MCP;
- skills;
- prompts;
- profiles;
- TUI packs.

---

## M13 — External Engines

Agregar adapters oficiales para:

- Claude Code;
- Codex;
- ACP;
- otros.

No antes de que Mend Native esté sólido.

---

## M14 — Computer Use

Agregar:

- screenshot;
- click;
- type;
- keyboard;
- scroll;
- drag;
- windows;
- browser;
- image preview;
- permissions;
- replayable tests.

---

## M15 — Collaboration

Agregar:

- peer bus;
- local locks;
- relay;
- remote machine;
- team channels;
- multi-machine session attach.

mflow puede ser compatibility adapter durante transición.

---

## M16 — Migration + Cutover

v1 exporta:

```text
config
sessions
memory
packages
themes
skills
prompts
```

V2 importa formato neutral.

V2 no abre directamente DB antigua.

---

# 98. Mantener v1 mientras se construye v2

Estrategia:

```text
MendCode stable = v1
MendCode next = v2
```

hasta tener suficiente parity.

---

# 99. Qué NO portar primero

No empezar con:

- Slack;
- VS Code;
- TSM edge cases;
- weather;
- every provider;
- giant MCP UI;
- all release automation.

Primero:

- runtime;
- reliability;
- TUI;
- extension contracts.

---

# 100. Primera lista de PRs propuesta

```text
PR-001  product-contract + provenance rules
PR-002  protocol + event schemas
PR-003  faux provider + headless runtime
PR-004  basic agent loop
PR-005  read/bash tools
PR-006  write/edit/search tools
PR-007  deterministic permission engine
PR-008  append-only/session event store + resume
PR-009  context builder + compaction
PR-010  model role resolver

--- CORE FREEZE ---

PR-011  OpenTUI shell
PR-012  MendCode home + wordmark
PR-013  transcript + markdown
PR-014  composer + working line + footer
PR-015  provider/model picker
PR-016  setup flow

--- USEFUL MENDCODE 2 ---

PR-017  Plan Review
PR-018  Changes Review
PR-019  extension API
PR-020  packages / skills / commands
PR-021  MCP
PR-022  Agent View
PR-023  Memory
PR-024  Usage Insights

--- ADVANCED ---

PR-025  subagents
PR-026  worktrees
PR-027  task_parallel
PR-028  loops
PR-029  Dream
PR-030  native collaboration / mflow evolution
```

---

# 101. Product identity final

MendCode 2 no debería ser descrito como:

> “OpenCode pero customizable.”

Ni:

> “Pi con más features.”

Ni:

> “Grok clone.”

La identidad propuesta:

> **MendCode es un coding harness modular y liviano que puede ir desde una terminal minimalista hasta un workstation TUI completo, con sesiones compartidas, perfiles/packages, memoria, workflows, extensiones, custom tools/renderers y diferentes engines de IA debajo.**

---

# 102. Arquitectura final objetivo

```text
                         mendcode
                            │
                      thin bootstrap
                            │
                            ▼
                         mendd
                ┌───────────┼────────────┐
                │           │            │
           Session Bus    Job Bus     Extension Bus
                │           │            │
        ┌───────┴──────┐    │      ┌─────┴─────┐
        │              │    │      │           │
   SessionActor     Context │    Packages     MCP
        │              │    │      │           │
        │              │    │    Plugins     Tools
        ▼              ▼    │
      Engine          Memory│
        │                   │
   ┌────┼─────────┐         │
   │    │         │         │
 Mend Claude    Codex       │
Native Code                 │
   │                        │
   └────────────┬───────────┘
                ▼
             Events
                │
      ┌─────────┼──────────┐
      │         │          │
     TUI       Web       Desktop
      │
┌─────┼──────────────────────────┐
│     │                          │
Minimal / Balanced / Full       Pages
│                               │
│                        Usage / Memory /
│                        Changes / Agents /
│                        Loops / Workflows
│
Extensions
│
tools / widgets / renderers /
pages / overlays / themes
```

---

# 103. Definition of Done

MendCode 2 no se considera terminado hasta que se cumpla, como mínimo:

```text
✓ zero OpenCode runtime imports
✓ no packages/opencode
✓ no OPENCODE_* required by Mend Native
✓ one DB writer
✓ foreground state only mutated by SessionActor
✓ Dream cannot block queued prompts
✓ compaction cannot duplicate turns
✓ multiple TUIs can observe same session
✓ reconnect deterministic
✓ background modules really turn off
✓ minimal TUI loads without heavy pages/features
✓ Usage does not scan full history on open
✓ custom tools can register custom renderers
✓ image artifacts can render
✓ personal/company profiles isolated
✓ packages do not contain secrets
✓ external engines do not require copying credentials
✓ faux engine covers critical state transitions
✓ responsive snapshots pass multiple widths
✓ RAM/performance benchmarks stay under budgets
✓ v1 → v2 migration is tested
✓ Mac/Linux/Windows release smoke tests pass
✓ security/SBOM/signing/provenance remain
✓ website screenshots come from actual release binary
✓ feature claims match released behavior
```

---

# 104. Qué se puede decir públicamente cuando el rewrite termine

Ahora mismo los docs de v1 reconocen correctamente lineage con OpenCode.

Después del rewrite, una formulación precisa sería:

> **MendCode 2 features an independently implemented coding-agent runtime, built from scratch around MendCode's own protocol, tools, workflows and TUI architecture. MendCode v1 was originally based on OpenCode.**

Y también:

> Inspired by ideas from Pi, OpenCode, Orin, Grok, Codex, Claude Code and other coding-agent systems.

No borrar la historia.

Explicar la evolución.

---

# 105. Decisión final de esta conversación

No construir:

```text
OpenCode
  + más wrappers
  + más MendCode
  + más guards
  + más adoption
```

Tampoco:

```text
fork Pi
→ rename
→ add features
```

La estrategia final:

```text
MendCode v1
     │
     ▼
behavior mining
specs
tests
fixtures
screenshots
feature inventory
     │
     ▼
MendCode 2
independent implementation
     │
     ├── tiny native engine
     ├── local daemon
     ├── session actors
     ├── event protocol
     ├── job scheduler
     ├── OpenTUI clients
     ├── extension platform
     ├── profiles/packages
     ├── Memory/Dream
     ├── Loops/Workflows
     ├── Usage/Changes/Context
     ├── Computer Use
     └── external harness adapters
```

---

# 106. La frase más importante de todo el plan

> **No rescatar el runtime viejo pieza por pieza. Rescatar el PRODUCTO.**

El producto incluye:

- tus ideas;
- UX;
- Dream;
- Memory;
- Usage;
- packages;
- workflows;
- loops;
- widgets;
- custom TUI;
- changes;
- plan review;
- multi-agent;
- model roles;
- profiles;
- relay;
- etc.

Pero el runtime se vuelve a diseñar desde cero alrededor de:

- ownership claro;
- state machines;
- event sourcing;
- single writer;
- actors;
- modular jobs;
- TUI as client;
- lazy capabilities;
- performance budgets;
- testable invariants.

---

# 107. Resultado esperado

La meta final:

## En una laptop pequeña

```text
mendcode
```

abre rápido.

Minimal mode.

Bajo RAM.

Nada de background innecesario.

---

## En una laptop potente

Full mode.

- sidebar;
- images;
- widgets;
- multiple agents;
- Dream;
- memory graph;
- workflows;
- computer use;
- rich reasoning.

---

## En una empresa

```text
/profile company
```

y cambia:

- models;
- tools;
- MCP;
- skills;
- memory;
- prompts;
- policies;
- workflows;
- theme.

---

## En casa

```text
/profile personal
```

y vuelve tu setup personal.

---

## Si quieres MendCode Native

```text
engine = mend
```

Harness propio.

---

## Si quieres Claude Code

```text
engine = claude-code
```

Misma TUI MendCode.

---

## Si quieres Codex

```text
engine = codex
```

Misma TUI MendCode.

---

## Si abres tres terminales

```text
mendcode -s ses_123
```

las tres muestran el mismo chat sin triplicar el backend.

---

## Si Dream corre

No rompe el chat.

---

## Si Usage abre

No reescanea todo.

---

## Si un plugin falla

No mata MendCode.

---

## Si el terminal es pequeño

La UI reorganiza, no se rompe.

---

## Si el terminal soporta imágenes

Las renderiza.

---

## Si una tool produce un grafo

Puede renderizarlo como ASCII nativo.

---

# 108. Fuentes/repos de referencia identificados durante la conversación

## MendCode

- https://github.com/MendCode/MendCode
- https://www.mendcode.dev/

## Pi

- ecosistema Pi / pi coding agent como referencia de minimalismo, extensibilidad y harness pequeño.

## pi-zentui

- https://github.com/lmilojevicc/pi-zentui

Referencia:

- “Pi + OpenCode-like presentation”.

## Orin

- https://github.com/thetombrider/coding_agent

Referencia:

- clean architecture;
- TypeScript;
- OpenTUI;
- agent loop;
- faux provider;
- provider registry;
- sessions;
- subagents;
- approvals.

## PUM

- https://github.com/eugen1763/Pum

Referencia:

- Pi loop + OpenTUI.

## Zerostack

- https://github.com/gi-dellav/zerostack

Referencia:

- minimal coding agent inspired by Pi/OpenCode.
- estudiar; cuidado con GPL.

## OpenTUI

- https://github.com/anomalyco/opentui

Referencia principal para la UI.

---

# 109. Resumen de la conversación por etapas

## Etapa A

Se buscó “OpenCode minimal como Pi”.

Resultado:

- pi-zentui;
- Orin;
- PUM;
- Zerostack;
- OpenTUI.

Conclusión:

> usar como referencias, no simplemente forkear.

---

## Etapa B

Se revisó MendCode actual y sus screenshots.

Se detectó:

- mucho producto propio;
- runtime muy grande;
- dependencia histórica de OpenCode;
- web/branding buenos;
- features únicas que vale la pena preservar.

---

## Etapa C

Se empezó a enumerar lo que está roto o difícil de arreglar.

Ejemplo central:

- queued prompt + Dream → generating stuck.

También:

- páginas lentas;
- usage heatmap;
- background interactions;
- compaction complexity;
- beta regressions.

---

## Etapa D

Se enumeraron cosas únicas que hay que preservar.

- Dream;
- compaction;
- packages;
- profiles;
- memory;
- usage;
- changes;
- workflows;
- loops;
- widgets;
- custom TUI;
- mflow;
- peer/relay;
- multiple terminals;
- custom tools/renderers;
- Agent View.

---

## Etapa E

Se añadió la visión de mejorar muchísimo la UX.

- Minimal / Balanced / Full;
- Full inspirado por calidad visual de Grok;
- imágenes;
- reasoning rendering;
- sidebar;
- responsive;
- side chat;
- provider/engine selection;
- simpler setup.

---

## Etapa F

Se añadió el requisito fuerte de RAM.

Eso cambió la arquitectura:

> un solo daemon local + thin clients.

---

## Etapa G

Se llegó al plan final.

MendCode 2:

- runtime propio;
- daemon;
- session actors;
- event log;
- JobScheduler;
- OpenTUI client;
- external engines;
- profiles/packages;
- modular pages;
- computer use;
- extension platform;
- performance tests;
- clean rewrite process.

---

# 110. Conclusión final

El remake correcto de MendCode no consiste en encontrar “el repo perfecto” y montar MendCode encima.

Los repos encontrados sirven para aprender:

- Pi → minimalismo y extensiones.
- pi-zentui → surfaces/presets.
- Orin → clean harness architecture.
- OpenCode → producción, sessions, tools, layout ideas.
- Grok → calidad de TUI.
- Codex → algunas ideas de session UX/usage.
- Claude Code → engine externo y workflows.
- OpenTUI → rendering platform.

Pero MendCode 2 debe tener su propia arquitectura.

La oportunidad real es construir algo que combine:

- **minimalismo real cuando se desea**;
- **TUI completa cuando se desea**;
- **runtime liviano**;
- **múltiples terminales sincronizadas**;
- **packages personales/empresariales**;
- **Memory + Dream**;
- **workflows/loops**;
- **side chat**;
- **custom renderers**;
- **images/computer use**;
- **external harnesses**;
- **features avanzadas sin meterlas dentro del kernel**.

La idea central:

> **MendCode no debe ser un montón de features pegadas a un agent loop. Debe ser una plataforma de runtime + session protocol + extension system donde esas features viven separadas y pueden encenderse, apagarse, reemplazarse o renderizarse de distintas maneras.**

Ese es el camino para que MendCode 2 sea:

- propio;
- rápido;
- modular;
- mantenible;
- open-source friendly;
- ligero;
- extensible;
- multi-client;
- y mucho más difícil de romper que el MendCode actual.

