# Contrato de diseño — UI de terminal de MendCode (F3, primer corte)

**Modo:** Operate (herramienta de trabajo). Se escanea rápido, el vocabulario es consistente y el color significa estado. La decoración no aporta.

**Baseline:** `.agents/evidence/f3/baseline.png`. Es la UI mínima de F1: texto plano, glifo `⚙` que se ve como un cuadrado (no existe en JetBrains Mono), sin markdown, sin tarjetas, footer gris.

**Referencias inspeccionadas:**

| Fuente | Qué se toma | Qué se evita |
|---|---|---|
| Tema activo del usuario en v1: `matrix` (kv `theme: matrix`, modo oscuro) | Paleta verde sobre negro verdoso | El tema `mendcode.json` de v1, que es la paleta por defecto de OpenCode (melocotón) y no la identidad del usuario |
| Perfil TUI de v1 (`~/.mendcode/tui/profile.json`) | Prompt `top-bottom` con reglas finas | Bordes redondeados en cajas completas: en un stream de chat ocupan filas sin aportar información |
| Footer de v1 (`rows-v1`) | Varias filas de estado y barras de cuota con `█░` | Las cuotas hechas por scripts externos; aquí salen de eventos `quota.snapshot` |

## Tokens (`apps/cli/src/ui/theme.ts`)

| Rol | Valor | Uso |
|---|---|---|
| `primary` | `#2eff6a` | Marca `❯` del usuario, regla activa del prompt, selección |
| `text` | `#62ff94` | Texto del usuario |
| `body` | `#c8e6cc` | Prosa del asistente. Verde muy desaturado: se lee largo sin fatiga y sigue la paleta |
| `muted` | `#8ca391` | Metadatos, tarjetas de tools, footer |
| `border` | `#1e2a1b` | Reglas inactivas |
| `heading` | `#00efff` | Encabezados markdown |
| `code` | `#1cc24b` | Código en línea y bloques |
| `link` | `#30b3ff` | Enlaces |
| `success` / `warning` / `error` | `#62ff94` / `#e6ff57` / `#ff4b4b` | Estado de tools y barras de cuota (< 70 % / < 90 % / ≥ 90 %) |

- Color en truecolor, con degradación a 256 colores si `COLORTERM` no es `truecolor`/`24bit`.
- **Se respeta el fondo del terminal:** no se pinta el fondo, por coste y por respeto al tema del usuario.
- **Glifos** (tokens con dos variantes):
  - `unicode` (por defecto): usuario `❯`, tool `◆`, ok `✓`, error `✗`, en curso `•`, cola `…`, aprobación `?`, regla `─`, barras `█░`.
  - `nerd` (opcional, `MENDCODE_GLYPHS=nerd`): iconos Nerd Font.

## Composición (de arriba abajo)

1. **Transcript:** se aprovecha todo el alto disponible y se ancla abajo.
   - Mensaje del usuario: `❯ texto`, en `text` y negrita.
   - Asistente: markdown sobre `body` con sangría de 2 columnas, para separarlo del usuario sin necesidad de etiquetas.
   - Razonamiento: `muted` atenuado, colapsado a una línea ("pensando… N líneas") salvo el último activo.
   - Tools, como **tarjetas de una línea**: `◆ título  ✓` o `✗ estado`. Mientras corren muestran las últimas 4 líneas de salida atenuadas. `Ctrl+O` expande o colapsa todas (como en Pi).
2. **Panel contextual** (solo si existe): cola (`… en cola: vista previa`, hasta 3 y "+N") y aprobación pendiente (título, detalle en 2 líneas como máximo y `[a] aprobar  [d] denegar`).
3. **Prompt top-bottom:** regla superior (`primary` si hay foco y `border` si está ocupado), editor multilínea de hasta 6 filas visibles con `❯` en la primera, y regla inferior.
4. **Footer:** estado (`listo` / `generando •` / …) · engine · cuotas `codex 7d ██░░░░░░ 17% ↺6d`.
   - En anchos menores de 70 columnas, la cuota se reduce a `7d 17%`.

**Estado vacío:** wordmark `MENDCODE` en ASCII centrado, en `primary`, con el directorio y una línea de ayuda ("Escribe y Enter · Esc Esc cancela · Ctrl+O tools"). Enseña la interfaz; no dice "no hay nada".

## Estados e interacción (Given / When / Then)

- **S1:** Given hay un turno activo, When llegan deltas de markdown, Then se renderizan en vivo; una fence ``` abierta se pinta como código hasta que se cierra y no se pierde texto.
- **S2:** Given una tool en curso, When termina con éxito o error, Then la tarjeta pasa a `✓` o `✗`, se colapsa y queda en la misma fila.
- **S3:** Given `Ctrl+O`, Then todas las tarjetas se expanden o colapsan. Es instantáneo y sin animación (Emil: acción de teclado frecuente).
- **S4:** Given un prompt con texto, When `Alt+Enter` o `Ctrl+J`, Then inserta un salto de línea; `Enter` envía. Flechas, Inicio/Fin, `Ctrl+A`/`Ctrl+E`, `Ctrl+U` (borra la línea) y `Ctrl+W` (borra la palabra).
- **S5:** Given una aprobación pendiente, Then el panel la muestra encima del prompt; con el prompt vacío, `a`/`d` responden; con texto, esas letras se escriben.
- **S6:** Given un `quota.snapshot`, Then la barra del footer se actualiza sin polling. El color refleja el umbral.
- **S7:** Given que el daemon se desconecta, Then el footer muestra `reconectando…` en `warning` y el input no se bloquea.
- **S8:** Given un turno activo, Then aparece un indicador `•` que parpadea a 2 Hz, solo mientras dura el turno; en reposo no hay timers (P6). Con `MENDCODE_REDUCED_MOTION=1` es estático.

## Adaptación

- **Anchos objetivo:** 60, 100 y 160 columnas.
- El transcript hace wrap por ancho de celda; el código no se reenvuelve y se recorta con `…`.
- Con menos de 70 columnas se ocultan el engine y el reset de cuota del footer.

## Aceptación (evidencia)

| ID | Escenario | Evidencia |
|---|---|---|
| A1 | S1 + S2 con markdown, fence y tool, en 100 columnas | PNG en `.agents/evidence/f3/` |
| A2 | Estado vacío con wordmark en 60 y 160 columnas | PNG |
| A3 | Aprobación + cola en el panel | PNG |
| A4 | Footer con cuota real (Codex, Luna `low`) | PNG |
| A5 | Tests unitarios de markdown, editor y tarjetas | `bun test apps` |
| A6 | Rendimiento: cliente ≤ 70 MB y < 1 % de CPU en reposo | medición tmux |
