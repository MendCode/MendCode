# Fuentes de cuota por proveedor (T04)

Fecha: 2026-09-26. Regla P9: solo se usan fuentes oficiales o datos que el propio proveedor entrega a herramientas locales documentadas. Prohibido: scraping, copiar tokens OAuth o llamar endpoints internos no documentados. Si no hay fuente oficial, la UI muestra "cuota no expuesta por el proveedor".

## Modelo común (propuesta para `packages/protocol`)

```ts
QuotaSnapshot = {
  provider: "codex" | "claude" | "openrouter" | "anthropic-api" | "openai-api" | string
  plan?: string
  windows: Array<{ id: string; label: string; usedPercent: number /*0–100*/; resetsAt?: number /*epoch ms*/; windowMinutes?: number }>
  credits?: { remaining?: number; limit?: number; unit: "usd" | "credits"; resetKind?: "daily" | "weekly" | "monthly" | null }
  status?: "allowed" | "warning" | "rejected"
  fetchedAt: number
  source: string   // e.g. "codex app-server account/rateLimits/read"
}
```

La UI calcula la etiqueta ("5h", "7d") a partir de `windowMinutes` y nunca supone que *primary* significa 5 h. Codex puede devolver solo la ventana semanal.

## Tabla

| Proveedor | Estado | Fuente | Qué da | Cómo se obtiene en v2 | Evidencia |
|---|---|---|---|---|---|
| **Codex (suscripción ChatGPT)** | VERIFIED | `codex app-server --stdio`, JSON-RPC `account/rateLimits/read` y la notificación push `account/rateLimits/updated` | `rateLimits.primary/secondary` o `rateLimitsByLimitId.codex`: `usedPercent`, `windowDurationMins` (300 = 5 h, 10080 = 7 d), `resetsAt` (s), plan | El daemon mantiene **un** proceso app-server si Codex está configurado: lee al arrancar y luego escucha `updated` (sin polling). Alternativa pasiva: eventos `token_count.rate_limits` en `~/.codex/sessions/**.jsonl` | Protocolo en `openai/codex` (`codex-rs/app-server-protocol/src/protocol/common.rs`, `schema/typescript/v2/AccountRateLimitsUpdatedNotification.ts`); v1 ya lo usa en `routes/stats/subscription-usage.ts` |
| **Claude (suscripción Pro/Max) vía engine Claude Code** | VERIFIED | Evento `rate_limit_event` en `claude -p --output-format stream-json --verbose` | `rate_limit_info.unifiedWindows.five_hour` y `.seven_day`: `utilization` (0–1), `resetsAt` (s); además `status`, `rateLimitType`, `overageStatus`, `isUsingOverage` | El adaptador del engine Claude Code lo recibe en cada turno y lo emite como `quota.snapshot`. Sin polling ni credenciales | **Observado** con Claude Code 2.1.283 el 2026-09-26: `{"five_hour":{"utilization":0.12,...},"seven_day":{"utilization":0.03,...}}` con `status: "allowed"` (`.agents/evidence/t04-claude-stream.jsonl`). Los tipos `SDKRateLimitEvent` existen desde 2.1.45, pero la página de referencia del Agent SDK aún no los documenta (issue anthropics/claude-code#26392) |
| **Claude (suscripción) sin usar el engine** | VERIFIED (vía integración documentada) | JSON de statusline de Claude Code: `rate_limits.five_hour` y `.seven_day` con `used_percentage` y `resets_at` | 5 h y 7 d, solo tras la primera respuesta de la sesión | Opcional: `mendcode quota ingest claude-statusline` como comando que el usuario añade a su statusline de Claude Code; escribe el snapshot en el daemon | Docs oficiales: https://code.claude.com/docs/en/statusline |
| **Anthropic API (API key)** | VERIFIED (límites por minuto, no cuota de plan) | Cabeceras `anthropic-ratelimit-requests-*`, `-tokens-*`, `-input-tokens-*`, `-output-tokens-*` en cada respuesta | Límite, restantes y reset por minuto | El provider las reenvía como `quota.snapshot` con ventanas de 1 min; la UI las muestra como "rate limit", no como "cuota del plan" | Docs de rate limits de Anthropic |
| **OpenRouter** | VERIFIED | `GET https://openrouter.ai/api/v1/key` con la propia API key | `limit`, `limit_remaining`, `limit_reset` (daily/weekly/monthly/null), `usage` | Sondeo como máximo cada 5 min **y solo** con `/usage` abierto o tras un turno de OpenRouter | https://openrouter.ai/docs/api_reference/limits |
| **OpenAI API (API key)** | PARCIAL | Cabeceras `x-ratelimit-*` por minuto | Solo límites por minuto; el saldo de facturación no tiene API pública para keys normales | Igual que Anthropic API | Docs de rate limits de OpenAI |
| **Vercel AI Gateway** | UNVERIFIED | — | — | T04b: revisar la documentación del gateway antes de F4 | — |
| **Kimi / Grok / otros** | NONE (por ahora) | — | — | "cuota no expuesta"; se revisa por proveedor al añadirlo | v1 muestra "no local quota feed" |

## Decisiones derivadas

1. **Las cuotas viven en el daemon**, nunca en la TUI. v1 lanza `codex app-server` desde el proceso TUI y su footer usa `chatgpt.com/backend-api/wham/usage`, que no está documentado (script `~/.config/fastfetch/stats.py`). v2 no usará ese endpoint.
2. **Push antes que polling:** con Codex se usa `account/rateLimits/updated` y con Claude `rate_limit_event`. Solo OpenRouter necesita sondeo, y está acotado.
3. **Frescura visible:** cada barra muestra "hace N min"; pasa a *stale* si supera 2× su intervalo esperado o si el proveedor no emitió nada en la sesión actual.
4. **Coste cero si no se usa:** sin Codex configurado no existe el proceso app-server; sin OpenRouter no hay timer (P6).
5. **Quota ≠ usage local ≠ coste API:** son tres bloques distintos en `/usage` y en el footer.
