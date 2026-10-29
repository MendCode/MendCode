# Protocolo MendCode v1 (`@mendcode/protocol`)

La fuente de verdad es `packages/protocol/src/*.ts` (esquemas zod estrictos). Este documento explica el diseño; si hay contradicción, manda el código y este documento se corrige.

## Transporte
- JSONL sobre socket unix (named pipe en Windows): una trama por línea, como máximo `MAX_FRAME_BYTES` (256 KiB).
- Tramas: `command` (cliente → daemon), `event` (evento de sesión), `global` (evento global), `ack`, `error`. Todas llevan `v: 1`.
- El primer comando es `hello{protocolVersion}`. Si la versión no es compatible, el daemon responde `error{code:"protocol_version", supported}` y cierra la conexión.

## IDs
ULID con prefijo y ordenables: `ses_ trn_ itm_ job_ cli_ req_ que_ cmd_`. Reloj y aleatoriedad inyectables, para que el kernel sea determinista en simulación. Los adjuntos viajan como `BlobRef{sha256, bytes, mime}` y nunca en línea.

## Comandos
Todos llevan `id` (cmd_, idempotente ante reintentos) y `clientId`.

| Comando | Efecto |
|---|---|
| `hello` | Handshake y capacidades |
| `session.create` | Crea una sesión en un directorio |
| `user.submit` | Encola un mensaje; arranca si la sesión está `idle` |
| `queue.promote` | "Send now": cancela el turno activo (`by: promotion`) y arranca este mensaje a continuación |
| `queue.remove` | Quita un mensaje de la cola |
| `turn.cancel` | Cancela **ese** turno; si no es el activo, responde `target_mismatch` y no hace nada más |
| `request.resolve` | Responde a una aprobación o pregunta; la primera respuesta gana y las siguientes reciben `request_already_resolved` |
| `client.subscribe` / `unsubscribe` | Suscripción con `afterSeq`: primero se reproduce el historial y después llegan los eventos en vivo |
| `job.schedule` / `job.cancel` | Jobs de fondo |
| `resource.mode.set` | Cambia el `resourceMode` (low/normal/high) |
| `diagnostics.resources` | Contadores de timers, suscripciones, procesos, sockets y scopes |

## Eventos de sesión
Todos llevan `sessionId`, `seq` contiguo desde 1 y `at`. Su forma es Thread/Turn/Item:

```text
turn.started → (item.started → item.delta* → item.completed)* → turn.completed | turn.cancelled | turn.interrupted | turn.failed
```

- `foreground.state` solo lo emite el SessionActor. `queue.changed` es el snapshot pequeño de la cola (vista previa de 200 caracteres).
- `turn.cancelled.by`: `user` o `promotion`. Una caída de red, un reinicio o un stream inactivo generan `turn.interrupted.reason` y nunca se registran como cancelación.
- `item.completed.status`: `ok | error | cancelled | interrupted | unknown`. `unknown` es para comandos interrumpidos cuyo resultado se desconoce. Si el contenido supera 64 KiB, va a `blob` y `text` es una vista previa.
- `usage.recorded`: el uso de tokens de cada llamada al modelo (provider, modelo, input/output/reasoning/cache y coste en micro-USD solo si el precio es conocido). Alimenta las proyecciones de `/usage`.
- `server.request` y `server.request.resolved` (con `abandoned` si su dueño desaparece, I7).

## Eventos globales
`gseq` propio: `job.state` y `quota.snapshot` (ver `specs/quota-sources.md`). Su esquema no admite `sessionId` ni `foregroundState`, así que un job no puede cambiar el primer plano (I3).

## Evolución
- Cambiar este paquete después de F1 requiere un RFC en este documento y aprobación.
- Los campos nuevos son opcionales. Un cambio incompatible sube `PROTOCOL_VERSION`.
