# Lazy engines and native provider runtimes

Baseline: `1e37c0fe`, branch `perf/lazy-engines`. Bun 1.3.13. No CLI launch, real provider request or login operation was used for measurement.

## Bundle proof

Before and after command:

```sh
bun build --splitting --minify --target=bun --metafile=dist/probe/meta.json --outdir dist/probe/split apps/cli/src/entry.ts
```

Both succeeded. Local artifacts: `dist/probe/before.json`, `meta.json`, `comparison.json` and `build.log` (ignored).

The CLI entry dynamically dispatches to main, and solo startup dynamically loads the daemon. To avoid a vacuous result, measurement roots include the chunks containing **entry.ts, CLI main.ts and daemon main.ts**, then follow only non-dynamic imports. The new `lazy-startup.test.ts` enforces this same stronger boundary without running the app.

| Measure | Before | After | Reduction |
|---|---:|---:|---:|
| Emitted startup JS bytes | 4,287,052 | 4,077,233 | 209,819 |
| Source bytes in static startup closure | | | 467,555 net |

37 original files leave the closure (479,353 source bytes); four new helper modules add 10,415 bytes, and changed retained files account for the rest. `hooks.ts` is unused and tree-shaken (4,414 bytes), rather than moved to a lazy chunk. Decimal KB are used. This is bundle evidence, **not a measured footprint improvement**.

Before: ACP/Pi runtime files were in `main-vd1rcwxz.js`, native runtimes in `entry-gcdfzc27.js`, and Claude runtime files in `entry-rn40gm3m.js`. After, none of these runtime chunks is statically reachable from the roots:

| Runtime | After chunk(s) | First use |
|---|---|---|
| ACP engine, transport, RPC, updates, tool cards | `index-efpeqarg.js` | First ACP turn |
| Pi engine, transport, RPC, events, gate | `index-1xh0bgdy.js` | First Pi turn or compaction |
| Claude engine, transport, plan-file, quota probe | `index-kgrytdhw.js` | First Claude turn or explicit quota probe |
| Bedrock, AWS event stream | `amazon-bedrock-s8hwb0a7.js` | Bedrock generation or model refresh |
| AWS credential resolution | `aws-credentials-zypy3ksj.js` | First credentials request |
| Azure adapter / Entra | `azure-openai-3m69rnqj.js`, `azure-entra-fm5ecp6m.js` | Azure generation / first Entra token request |
| Gemini / model discovery | `entry-2tfjh4z2.js`, `google-models-r2hzsf75.js` | Gemini generation / Google model refresh |
| Vertex Gemini / Anthropic | `google-vertex-ngthxfz3.js`, `vertex-anthropic-q73e16mf.js` | Generation for that wire format |
| Google ADC | `google-adc-zyt13te2.js` | First Google token request |
| Anthropic messages / thinking / threads | `entry-4g3bh02n.js`, `entry-e46tn1sj.js`, `entry-7xg8tz4z.js` | Anthropic-format generation, including Copilot, Zen and GitLab |
| GitLab workflow | `gitlab-workflow-0m0ayztf.js` | First Duo Workflow request, not ordinary GitLab chat |
| Code runtime, library, values, regex / parser | `code-runtime-6qjekv1d.js`, `entry-yc38ckrb.js` | First `code` or `computer_code` execution |

Public exports and synchronous factories remain available. Provider adapter initialization is cached as a promise per model, shared by concurrent first requests and evicted on failure. Credential wrappers share one lazily constructed resolver, preserving its token caches. Small catalog/routing helpers and synchronous credential-presence checks remain eager. Explicit barrel exports and `sideEffects: false` prevent unused re-exports from retaining runtimes in the split bundle.

## Remaining limitation

`chatgpt-auth.ts` remains eager: startup uses synchronous `status`, `route`, `planAccount` and method-availability calls, not only its constructor. Moving its OAuth implementation safely requires separating that stateful synchronous surface from login/refresh operations. This pass leaves it unchanged rather than alter login behavior. ACP/Pi catalog/config/router code and Claude's effort helper also remain available at startup; their engines and transports do not.

## Verification

`bun run typecheck`: passed. `git diff --check`: passed.

Each file below was run with its own `bun test <file>` invocation; all final runs passed:

- `packages/engine-native/test/`: `lazy-startup.test.ts`, `lazy-credentials.test.ts`, `provider-factory.test.ts`, `provider-remote.test.ts`, `aws-credentials.test.ts`, `google-adc.test.ts`, `amazon-bedrock.test.ts`, `azure-openai.test.ts`, `google-gemini.test.ts`, `google-vertex.test.ts`, `vertex-anthropic.test.ts`, `anthropic-messages.test.ts`, `anthropic-threads.test.ts`, `gitlab-workflow.test.ts`, `gitlab.test.ts`, `zen.test.ts`, `github-copilot.test.ts`, `code-mode.test.ts`, `code-runtime.test.ts`, `code-language.test.ts`, `code-classes.test.ts`, `engine.test.ts`.
- `packages/daemon/test/`: `pi-routing.test.ts`, `claude-routing.test.ts`, `advisor-claude.test.ts`, `context-limits.test.ts`, `extension-session-control.test.ts`, `workflow-script-engines.test.ts`, `b80-program.test.ts`, `bedrock-provider.test.ts`, `vertex-provider.test.ts`, `azure-provider.test.ts`, `providers.test.ts`, `host-tools-routing.test.ts`.

The first new concurrency-test run failed because its construction counter used a property also read by routing predicates (7 reads instead of 1). The fixture now counts a construction-only property; the corrected test passes. No production failure was hidden or waived.

Not verified: live provider/engine sessions, actual idle physical footprint, or the full test suite.
