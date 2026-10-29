# T10a — Spike de renderizado (2026-09-26)

**Escenario:** 10.000 mensajes deterministas (`fixture.ts`) más streaming de 50 tokens/s durante 60 s, en tmux 160×45, Mac 24 GB, Bun 1.3.13, `@opentui/core` 0.5.11 (0.5.12 bloqueada por `minimumReleaseAge`).

**Medición:** `run.sh`. Memoria física con `vmmap` del proceso bun a los 5 s y a los 55 s; CPU media de `ps` entre los segundos 25 y 55. Salida cruda en `RESULT.raw` y última pantalla en `pane-*.txt`.

**Corrección durante la medición:** la primera corrida midió el proceso `tmux` porque `pgrep` casaba con su línea de comandos. Se descartó y se repitió con `pgrep -f "^bun …"`.

| Variante | Qué hace | Memoria 5 s | Memoria 55 s | CPU | Meta cliente (≤ 70 MB, ≤ 25 %) |
|---|---|---:|---:|---:|---|
| A1 `opentui-naive` | 10k `TextRenderable` en un `ScrollBox` con `viewportCulling` (enfoque de OpenCode/v1) | 144,1 MB | 137,1 MB | 10,5 % | **FAIL** memoria |
| A2 `opentui-window` | Un `TextRenderable` con la ventana visible calculada por nosotros | 86,9 MB | 87,1 MB | 17,4 % | **FAIL** memoria |
| B `diff-renderer` | Frame anterior en memoria; solo reescribe las filas que cambian (ANSI) | 37,4 MB | 45,4 MB | 1,8 % | **PASS** |

## Lectura

- En este escenario OpenTUI 0.5.11 no llega al 100 % de CPU de oc#6172 (gracias a `viewportCulling`), pero su base de memoria (≈ 51 MB solo con un texto, 87–144 MB con el transcript) deja poco o ningún margen frente a la meta de 70 MB por terminal. A2 sube la CPU porque reasigna el contenido completo en cada token.
- B necesita **4–8 veces menos CPU** y **2–3 veces menos memoria**. Es la vía que siguen Pi (pi-tui) y Codex (ratatui con celdas en caché).
- B es un prototipo: no tiene layout, ratón, colores ni input. Hacerlo producto supone escribir una capa de UI propia pequeña (filas, estilos, diff, input, ratón y resize), no un framework general.

## Decisión propuesta (P8, requiere tu confirmación en la puerta F1)

**Renderer propio diferencial para el cliente**, construido sobre el modelo de vista ya independiente del renderer (`apps/cli/src/view/transcript.ts`, que ya prueba menos de 2 ms por frame con 10k mensajes). OpenTUI queda como opción para páginas pesadas solo si una página concreta lo justifica y cabe en el presupuesto.

- **Se invalida si:** la UI propia necesita más de ≈ 2.000 líneas para cubrir el transcript, el prompt multilínea, el footer, los overlays y el ratón en F3, o si una página no se puede expresar con filas y estilos. En ese caso se reevalúa OpenTUI en su versión vigente con el mismo `run.sh`.
- **Riesgo aceptado:** más código propio de terminal (anchos Unicode, capacidades del terminal, kitty/sixel) a cambio de cumplir E2 (ligero de verdad).
