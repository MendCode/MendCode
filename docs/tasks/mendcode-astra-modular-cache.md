# Task packet: mendcode-astra-modular-cache

Source SHA-256: 8ae167b02a11d3dc40a202e73c474e7f40fcc5ea2415598519460498a0545af2

## Goal

Preparar la sucesora de beta.6 con un perfil Astra Focus/Full conciso y un núcleo de caché extensible por provider, modelo, endpoint, autenticación y transporte; preservar contratos existentes y dejar mantenimiento activo bloqueado hasta demostrar compatibilidad y coste.

## Context

Inspección del 2026-09-10: gh release list/view confirma v0.1.44-beta.6 publicada a las 06:25:23Z desde 40dc83756bbff25aa0756fc6bcdc356a3cb94f3c; nightly posterior es draft. Checkout dev b5646990, ahead 4/behind 18 de su tracking local, con cambios concurrentes en compose.ts, session/prompt.ts, TUI y serve. NO es la beta publicada. git show/diff del commit publicado verifica que beta.6 YA incluye perfil gpt-6-astra con nueve reglas, ASTRA_PROMPT_SOURCE, normalizedPromptModel, runtimeCapabilityPrompt, reasoning-auto y ContextProfile. Los archivos model-family.ts/runtime-capabilities.ts/context-profile.ts faltan en este checkout; no recrearlos como sustituto de integrar la base correcta. sources.ts exporta promptBehaviorForModel({focusID?,modelID?}) y promptBehaviorText(profile); composePromptPolicy(ComposeInput): Promise<PromptComposition> añade model-behavior una vez para focus/full, no minimal/custom. Beta ASTRA_PROMPT_SOURCE declara revision mendcode-astra-2026-09-04.1 y URL pública; esa declaración no constituye verificación externa en esta revisión. Referencia privada local suministrada: se leyeron líneas 1-220 y encabezados; contiene 5051 líneas de plantillas, no una guía única. Esenciales transferibles: completar trabajo autorizado, conservar objetivo y correcciones, continuar tras compactación, preguntar por decisiones materiales, examinar evidencia, verificar proporcionalmente y comunicar resultado/limitaciones. No importar herramientas, identidad Codex, overrides de aprobación, fechas límite ni persistencia ilimitada. El screenshot es contexto del selector existente; no se solicita rediseño. ProviderTransform.message(msgs,model,options) llama applyCaching para rutas Anthropic/compatibles; applyCaching añade controles a primeros dos system y últimos dos no-system. ProviderTransform.options usa sessionID para claves OpenAI/OpenRouter y otros. prepareCodexChatGPTOAuthRequest({body,headers,sessionIDs?,sessionPromptFingerprints?,responsesLite?}) delega en prepareResponsesLiteRequest: solo modelos gpt-5.6-sol/terra/luna, transforma tools/instructions en input, fuerza tool_choice auto y une prompt_cache_key con UUIDv7 de afinidad. Astra NO está en ese set incluso en beta.6. LLM.StreamInput incluye parentSessionID?, model, system, messages, tools, abort; beta añade toolMode y maxOutputTokens. LLM.run mezcla instrucciones/agente/memoria antes del hook system.transform, chat.params y resolveTools; middleware transforma mensaje y beta perfila contexto y aplica discoveryWireMiddleware. Cache fingerprint antes de esos cambios no prueba igualdad final. task.ts crea sessions.create({parentID:ctx.sessionID,...}); no demuestra prefijo idéntico. Session.getUsage({model,usage,metadata?}) normaliza tokens/coste; contexto beta ya distingue métricas ausentes con usageReported y contextReport devuelve null. @ai-sdk/openai declarado 3.0.53; no se inspeccionó paquete instalado ni se verificaron breakpoints/TTL en documentación online. Tests son bun test --timeout 30000 desde paquete, typecheck bun typecheck. No se ejecutó aplicación/test/build/provider. Plan beta4 existente permanece autoridad para sus features; este paquete es delta posterior, no sustitución.

## Decisions

Alcance de implementación propuesto: mejorar perfil existente, extraer política de caché conservando serialización actual, incorporar identidad compatible opcional y observación sin inferencia adicional. No cambiar orden/semántica de mensajes para aumentar hits en esta primera entrega. Las nociones project prefix y session tail son contabilidad local, no dos cachés remotas garantizadas. Resolver estrategia por binding exacto, nunca por nombre comercial solamente. Compartir lineage solo con prefijo final demostrado idéntico y límites de proyecto/cuenta/ruta; de lo contrario clave de sesión existente. Mantener selección de tools y permisos: no anunciar todo el catálogo ni equiparar activeTools con allowed_tools del proveedor. No upgrade de SDK, nuevos endpoints/flags de configuración/UI, migración SQL, versión elegida, ni keepalive automático en este incremento. T5 produce contrato de habilitación futuro, no implementación parcial del scheduler. No prometer mejora del razonamiento interno o ahorro medido por cambiar instrucciones.

## Recovery

T0 bloquea toda edición de producto en checkout desfasado/concurrente. No reset/stash/pull/cherry-pick automático ni crear worktree para evadir conflicto de ownership. Revalidar y actualizar paquete tras integración autorizada. Módulos nuevos degradan a política legacy sin operaciones de red. Revertir solo hunks propios, conservar datos y perfiles previos; sin migración de base ni borrado de caché remoto. Una nueva beta o implementación concurrente invalida decisiones afectadas. No copiar astra.md al repositorio ni depender de ese archivo en runtime. Evidencia de API/SDK pendiente no bloquea refactor pasivo, sí controles nuevos, compartir claves en rutas no verificadas y todo keeper. Elegir versión/publicación requiere intención posterior del usuario.

## Requirements

- R1: Usar base que contenga beta.6 y preservar cambios concurrentes y todas las funciones ya publicadas.
- R2: Focus y Full incluyen exactamente un perfil Astra afinado, con semántica común; Minimal/Custom y otros modelos no cambian; identidad, permisos y capacidades reales prevalecen.
- R3: Núcleo modular selecciona por binding provider/model/endpoint/auth/transport/SDK y permite variantes de modelo sin condicionales de proveedor dispersos ni controles inventados.
- R4: Separar identidad de sesión, afinidad y lineage sin romper contratos existentes; ningún aislamiento se pierde por parentID o coincidencia de clave y ningún hit se presume.
- R5: Observación de cache read/write distingue cero de desconocido y conserva contabilidad existente sin duplicación ni persistencia de prompts.
- R6: Mantenimiento activo solo tiene un contrato futuro explícito y bloqueos verificables; la entrega pasiva no realiza inferencias adicionales ni presume TTL, precios o rentabilidad OAuth.
- R7: Aceptación integrada usa evidencia focalizada real, pruebas de rechazo y recuperación sin publicar automáticamente.

## Execution Policy


### Profile

backend

### Rationale

Riesgo principal es identidad, serialización, permisos y contabilidad entre adapters; edición textual acotada de prompt y ninguna nueva interfaz visual.

### Locked Decisions


#### Entry 1


##### Decision

Base beta.6 como mínimo y delta sobre perfil Astra ya publicado.

##### Reason

El checkout omite funciones existentes y contiene trabajo ajeno.

##### Invalidated By

Nueva release o base integrada cambia firmas/ownership; revisar T0.

#### Entry 2


##### Decision

Compatibilidad legacy por defecto; capacidades nuevas opt-in verificadas por binding, mantenimiento sin habilitar.

##### Reason

Endpoint OAuth interno y afirmaciones de SDK/TTL no verificadas; no generar gasto de optimización supuesto.

##### Invalidated By

Evidencia de wire y servicio para binding exacto más autorización y nuevo contrato de habilitación.

#### Entry 3


##### Decision

No ampliar tools ni mover memoria/instrucciones entre roles para cachear.

##### Reason

La optimización no puede cambiar permisos ni significado del prompt.

##### Invalidated By

Plan posterior demuestra equivalencia y enforcement con pruebas de rechazo.

#### Entry 4


##### Decision

Paráfrasis editorial del comportamiento útil; no trasplante de plantillas ni cambio de reasoning effort.

##### Reason

La referencia mezcla contratos de otro runtime; el perfil no controla el razonamiento interno del modelo.

##### Invalidated By

Fuente pública verificable o petición específica cambia el contenido autorizado, sin suprimir permisos.

### Discretion

- Helpers, nombres locales y organización de tests dentro de paths declarados; módulos flat ESM conforme AGENTS.
- Ampliar fixtures locales para detectar regresiones reales sin llamadas pagadas ni cambiar dependencias.

### Escalation

- Base desfasada, cambios superpuestos o fuente publicada ausente: parar T0 y pedir reconciliación autorizada.
- SDK o endpoint no expresa wire equivalente: marcar capacidad unsupported, no introducir cast que aparente soporte.
- Necesidad de nueva dependencia, SQL, UI, gasto, ampliar herramientas o cambiar semántica del prompt: revisar contrato antes de continuar.

### Validation


#### Required Checks

- T0
- T1
- T2
- T3
- T4
- T5
- T6

#### Excluded Checks

- Build y suite completos: refactor acotado; ampliar solo ante riesgo de frontera compartida demostrado.
- Browser/PTY visual: no hay cambios de layout/interacción; si se amplía a UI requiere design_contract y smoke de repositorio.
- Canaries de proveedor y refresh: requieren credenciales, autorización de gasto y fixture sin datos privados; no necesarios para declarar solo compatibilidad local.

#### Rerun When

- Cambio de source/tests/SDK/config relevante o evidencia insuficiente/inválida; no repetir por ritual de cierre.

#### Failure Limit

2

Policy semantics: preserve locked decisions unless current evidence invalidates them; use only the declared local discretion. On an escalation trigger, stop affected work and report the observation and required decision; continue independent authorized work.
Validation required_checks names task IDs, not a waiver of other mandatory criteria. Reuse successful evidence only when relevant source, dependencies, environment and coverage still match. failure_limit counts consecutive ineffective attempts at one criterion before revisiting diagnosis; it never turns missing or failed evidence into acceptance. Policy fields grant no extra edit, publication or device permissions.

## Execution and evidence

Planning state: draft. Execution has not started.
Closure owner: session_lead. Evidence: .agents/plans/mendcode-astra-modular-cache.evidence.json. State: .agents/plans/mendcode-astra-modular-cache.state.json.
Edit/new files scope product content. The evidence_file and each verification.evidence path authorize only named evidence artifacts; state_file names the execution state. Only the session lead aggregates evidence_file/state_file. Evidence outputs must not overwrite product/input files, existing unrelated artifacts or the planning source. Workers use distinct check-evidence files and required parent directories; no other output paths are implied.
Verify tools and permissions before work. Missing capabilities block only dependent criteria.
Record actual checks as PASS, FAIL, BLOCKED, NOT_RUN or NOT_APPLICABLE with evidence.

## T0 — Resolver base y ownership antes de implementar

### Work Kind

decision

### Depends On

None.

### Parallel Group

None.

### Read First

- src/mendcode/packages/opencode/package.json
- src/mendcode/packages/opencode/AGENTS.md
- src/mendcode/packages/opencode/test/AGENTS.md
- .agents/plans/mendcode-beta4-fast-context-orchestration.execution.json

### Edit Files

None.

### New Files

None.

### Symbols

- HEAD b5646990; release 40dc83756bbff25aa0756fc6bcdc356a3cb94f3c

### Interfaces

- Ejecución exige árbol integrado que contenga beta.6; fuentes ausentes deben provenir de integración autorizada, no recreación.

### Inputs

- Git local y release/PR actuales; diff dirty y staged; autorización posterior de implementación.

### Outputs

- SHA base, hashes de cambios relevantes, ownership y estado READY o BLOCKED de tareas dependientes.

### Operation Order

1. Inspeccionar status/diffs y release/PR mediante gh de solo lectura.
2. Comparar con SHA beta.6 y planes activos; comprobar presencia de model-family.ts, runtime-capabilities.ts, context-profile.ts y tests publicados.
3. Resolver con dueño cualquier superposición; registrar superficie segura y revalidar paths/firmas de este paquete.

### Error Semantics

- Divergencia o ownership no resuelto bloquea edits, no autoriza un merge automático.

### Examples

- Base integrada preserva ai-configuration-playbook y capability prompt: continuar con delta.

### Counterexamples

- Crear de cero model-family.ts en b5646990 duplica/reduce implementación publicada.

### Non Goals

- No sincronizar ramas, publicar ni cambiar versión.

### Acceptance

- Base y ownership son verificables; las tareas siguientes leen contratos de beta.6 o sucesora reconciliada.

### Required Capabilities

- repository_read
- command

### Traces To

- R1

### Verification

- kind: acceptance
- procedure: PROPUESTO: git status --short --branch; git diff --name-only; git diff --cached --name-only; gh release list --repo MendCode/MendCode --limit 5; gh pr list --repo MendCode/MendCode. Comparar archivos específicos con git show 40dc83756bbff25aa0756fc6bcdc356a3cb94f3c:path y registrar ownership.
- cwd: .
- preconditions: Acceso Git/gh de lectura; no modificar worktree al comprobar.
- expected: Base y conflictos explícitos; no falsa equivalencia entre checkout y release.
- evidence: .agents/plans/mendcode-astra-modular-cache.T0.txt


### Stop Condition

Fuente o ownership no reconciliado; cambiar solo planning cuando se resuelva.

## T1 — Afinar perfil Astra existente para Focus y Full

### Work Kind

product_code

### Depends On

- T0

### Parallel Group

None.

### Read First

- src/mendcode/packages/opencode/src/mend/prompt/sources.ts
- src/mendcode/packages/opencode/src/mend/prompt/compose.ts
- src/mendcode/packages/opencode/src/mend/prompt/model-family.ts
- src/mendcode/packages/opencode/src/mend/prompt/runtime-capabilities.ts
- src/mendcode/packages/opencode/test/mend/prompt/compose.test.ts

### Edit Files

- src/mendcode/packages/opencode/src/mend/prompt/sources.ts
- src/mendcode/packages/opencode/test/mend/prompt/compose.test.ts

### New Files

None.

### Symbols

- modelBehaviorProfiles entry gpt-6-astra
- promptBehaviorForModel
- promptBehaviorText
- composePromptPolicy

### Interfaces

- Mantener PromptBehaviorProfile y sección model-behavior. Registrar perfil afinado como mendcode-compatibility si deriva de paráfrasis local; no atribuir nuevas reglas a verificación pública no realizada.

### Inputs

- IDs Astra normalizados por helper publicado, focusID codex, modos minimal/focus/full/custom; texto original del perfil beta.6.

### Outputs

- Perfil revisado en inglés de máximo 12 reglas y 4500 bytes UTF-8 (presupuesto editorial propuesto), compartido una vez por Focus y Full.

### Operation Order

1. Conservar las nueve intenciones existentes y fusionar redundancias.
2. Expresar: inspeccionar evidencia antes de editar; diferenciar hecho e hipótesis; revisar causa tras evidencia contraria; completar alcance autorizado; preguntar solo por datos/autoridad materiales; no ampliar alcance por iniciativa propia.
3. Expresar continuidad tras corrección/compactación usando notas y recall solo disponibles; no reiniciar ni repetir verificaciones válidas; respetar objetivos previos y cancelación.
4. Expresar uso de herramientas reales, delegación solo según consentimiento vigente, sin polling ocupado; salida con resultado, evidencia y limitación breve. No solicitar razonamiento privado ni imponer esfuerzo del modelo.
5. Actualizar pruebas por matriz y revisar texto compuesto contra contradicciones con permisos de Full; no editar compose.ts concurrente.

### Error Semantics

- Modelo no Astra o foco diferente no recibe perfil; sin capacidades async/recall no prometerlas; no llamar un API para resolver texto.

### Examples

- openai/gpt-6-astra-fast con focus codex incluye perfil exactamente una vez; full conserva su catálogo y reglas de consentimiento.
- Tras compactación con tests válidos disponibles, conservar objetivo y evidencia en vez de repetir todo.

### Counterexamples

- Añadir send_user_message_async, clock.sleep o persistencia hasta 2027 copia capacidades ajenas.
- Decir que el usuario siempre anula permisos del runtime o que hay que mostrar razonamiento completo incumple el contrato.

### Non Goals

- No importar astra.md, sustituir prompt base OSS, cambiar Minimal/Custom, auto-reasoning ni catálogo de modelos.

### Acceptance

- Matriz Astra base/fast/pro de comportamiento, no normalización de API, no-Astra y cuatro modos pasa; cero duplicación del perfil; identidad MendCode y full-only se conservan.
- Revisión editorial distingue objetivos de comportamiento de capacidades comprobadas; no atribuye mejoras de calidad sin evaluación.

### Required Capabilities

- code
- command

### Traces To

- R2

### Verification

- kind: text_test
- procedure: PROPUESTO: bun test --timeout 30000 test/mend/prompt/compose.test.ts; revisar el texto renderizado por composePromptPolicy en fixtures con y sin fuente OSS, y contar bytes de la sección en test.
- cwd: src/mendcode/packages/opencode
- preconditions: T0 resuelto; Bun/dependencias instaladas; tmpdir de tests y configuración aislada sin datos globales.
- expected: Checks pasan y preservan secciones de beta.6; revisión semántica no detecta falsa capacidad ni autonomía no autorizada.
- evidence: .agents/plans/mendcode-astra-modular-cache.T1.txt


### Stop Condition

Afinación exige modificar permisos/global harness, falta perfil publicado o existe edición concurrente del mismo perfil.

## T2 — Extraer registro modular conservando comportamiento legacy

### Work Kind

product_code

### Depends On

- T0

### Parallel Group

None.

### Read First

- src/mendcode/packages/opencode/src/provider/transform.ts
- src/mendcode/packages/opencode/src/plugin/codex.ts
- src/mendcode/packages/opencode/src/session/llm.ts
- src/mendcode/packages/opencode/test/provider/transform.test.ts
- src/mendcode/packages/opencode/package.json

### Edit Files

- src/mendcode/packages/opencode/src/provider/cache-policy.ts
- src/mendcode/packages/opencode/src/provider/transform.ts
- src/mendcode/packages/opencode/test/provider/cache-policy.test.ts
- src/mendcode/packages/opencode/test/provider/transform.test.ts

### New Files

- src/mendcode/packages/opencode/src/provider/cache-policy.ts
- src/mendcode/packages/opencode/test/provider/cache-policy.test.ts

### Symbols

- ProviderTransform.message/options/applyCaching
- Nuevos CacheBinding, CacheCapabilities, CacheAdapter y resolveCacheAdapter

### Interfaces

- CacheBinding={providerID:string,modelID:string,apiModelID:string,endpoint:string,auth:'api'|'oauth'|'unknown',transport:'responses-http'|'responses-lite'|'other',sdk:string,accountScope?:string}. accountScope es identificador opaco local, nunca token; endpoint conserva ruta relevante, sin credenciales.
- CacheCapabilities={key:boolean,explicitBreakpoints:boolean,retentionSeconds:number|null,refresh:boolean,lineage:boolean}; capacidades nuevas false/null salvo evidencia del binding exacto.
- CacheAdapter={id:string,matches:(binding:CacheBinding)=>boolean,capabilities:(binding:CacheBinding)=>CacheCapabilities}; resolveCacheAdapter(binding, adapters?) devuelve adapter o fallback legacy. Registros internos estáticos; plugins dinámicos fuera de alcance. Orden: match exacto de modelo/ruta registrado, familia registrada, proveedor legacy, fallback; ambigüedad al mismo nivel es error de registro en test, nunca selección accidental.
- Extraer constructor de anotaciones legacy a cache-policy.ts conservando keys y lugares existentes; ProviderTransform sigue siendo frontera pública y acepta input viejo sin CacheBinding.

### Inputs

- Modelo y opciones existentes; binding opcional nuevo para callers que pueden proporcionar auth/ruta; fixtures golden de serialización actual.

### Outputs

- Un punto extensible de decisión con override por modelo y fallback que no introduce opciones nuevas; request normal equivalente antes/después.

### Operation Order

1. Capturar fixtures de opciones y anotaciones existentes por proveedor soportado en transform.test.
2. Definir contrato flat ESM y resolver sin IO/red; ausencia de binding completo impide lineage/refresh pero conserva legacy.
3. Extraer lógica cache existente sin modificar normalización de mensajes ni orden de tools; registrar OpenAI, Anthropic/Bedrock, OpenRouter y fallback mediante reglas compatibles con source observado.
4. Añadir adapter ficticio de test que sobrescribe solo un modelo y demuestra extensión sin editar LLM/plugin; dejar explicitBreakpoints y refresh false en producción.

### Error Semantics

- URL inválida, auth/cuenta desconocida o modelo no reconocido no recibe capacidades nuevas; conservar request legacy.
- No propagar opciones OpenAI a Anthropic ni inferir Anthropic nativo por nombre Claude tras gateway; no aumentar retries.

### Examples

- Dos modelos del mismo provider pueden resolver distinto adapter; modelo desconocido sigue funcionando con política legacy.
- API OpenAI y OAuth con mismo modelID son bindings diferentes.

### Counterexamples

- if model startsWith gpt => ttl 30m ignora endpoint/auth/model.
- @ai-sdk/openai 3.0.53 no prueba que acepte opciones del ejemplo 4.x; un cast no aporta soporte.

### Non Goals

- Sin instalación/upgrade, nuevos controles API, configuración pública, scheduler ni cambios de defaults.

### Acceptance

- Fixtures legacy idénticas para controles existentes; precedencia determinista y rechazo de ambigüedad; extensión por modelo y fallback prueban modularidad.

### Required Capabilities

- code
- command

### Traces To

- R3
- R6

### Verification

- kind: text_test
- procedure: PROPUESTO: bun test --timeout 30000 test/provider/cache-policy.test.ts test/provider/transform.test.ts
- cwd: src/mendcode/packages/opencode
- preconditions: T0 integrado; fixtures nuevas ejecutan implementación real sin proveedor; dependencias instaladas.
- expected: Serialización legacy preservada y matriz exacto/familia/provider/fallback pasa sin IO.
- evidence: .agents/plans/mendcode-astra-modular-cache.T2.txt


### Stop Condition

Extracción cambia wire o requiere SDK/dependencia nueva: aislar la diferencia y revisar alcance.

## T3 — Definir lineage compatible y separar clave opcional de afinidad

### Work Kind

product_code

### Depends On

- T2

### Parallel Group

None.

### Read First

- src/mendcode/packages/opencode/src/plugin/codex.ts
- src/mendcode/packages/opencode/src/session/llm.ts
- src/mendcode/packages/opencode/src/tool/task.ts
- src/mendcode/packages/opencode/src/mend/runtime/provider-adapters.ts
- src/mendcode/packages/opencode/test/plugin/codex.test.ts
- src/mendcode/packages/opencode/src/provider/cache-policy.ts

### Edit Files

- src/mendcode/packages/opencode/src/session/cache-lineage.ts
- src/mendcode/packages/opencode/src/plugin/codex.ts
- src/mendcode/packages/opencode/test/session/cache-lineage.test.ts
- src/mendcode/packages/opencode/test/plugin/codex.test.ts

### New Files

- src/mendcode/packages/opencode/src/session/cache-lineage.ts
- src/mendcode/packages/opencode/test/session/cache-lineage.test.ts

### Symbols

- prepareCodexChatGPTOAuthRequest
- prepareResponsesLiteRequest
- Nuevos CacheIdentity, fingerprintPrefix y selectCacheIdentity

### Interfaces

- CacheIdentity={runtimeSessionID:string,transportAffinity:string,cacheKey:string,lineageID:string,compatible:boolean,reason:string}. Identidades distintas conceptualmente, no obligación de cambiar sus valores legacy.
- fingerprintPrefix({binding:CacheBinding,projectScope:string,prefix:unknown,toolDefinitions:unknown,settings:unknown,serializationRevision:string}):string|null usa SHA-256 sobre representación determinista preservando orden de arrays/texto. Sin scope de cuenta/proyecto, valores no serializables, media no reproducible o wire no conocido devuelve null. No registrar payloads ni secrets.
- selectCacheIdentity({sessionID,transportAffinity,ownLineageID,parent?:{lineageID,cacheKey,fingerprint},fingerprint,legacyKey}):CacheIdentity hereda solo si fingerprint no null e idéntico al parent; sino ownLineageID y legacyKey. Parent es información interna validada, no parámetro público de tool.
- Añadir managedCacheKey?:string a preparación OAuth y helper Lite; únicamente caller interno verificado puede suministrarlo. En Lite validar no vacío, <=256 caracteres ASCII [A-Za-z0-9:_-]; si inválido ignorar y usar sessionID generado. Ausente mantiene parsed.prompt_cache_key=sessionID EXACTAMENTE como antes. No leer clave gestionada desde header externo ni cambiar afinidad.

### Inputs

- Prefijo final conocido, settings que afectan semántica/cache, binding exacto y padre opcional; fixtures de body/Headers/mapas del plugin.

### Outputs

- Primitivas puras comprobadas y seam opcional de transporte; ningún caller de producción habilita lineage todavía.

### Operation Order

1. Implementar hash y selección sin storage ni mapas globales; incluir model real, ruta, auth/cuenta, proyecto y revisión serializer.
2. Separar campo opcional de cache key y conservar UUIDv7 de session-id/x-session-affinity y rotación de instrucciones.
3. Probar path directo y fetch(Request) existente, normalización 5.6/Astra y bypass responsesLite=false; no ensanchar set de modelos Lite.
4. Documentar en comentarios de seam que hashing pre-SDK no acredita wire final; activación futura exige inspección posterior a plugins, tool discovery y serializer.

### Error Semantics

- Mismatch, unknown, reordenación tools, cambio de instrucciones/modelo/settings/cuenta/proyecto devuelve compatible=false y mantiene aislamiento.
- Sin key opcional cualquier ruta conserva comportamiento anterior; el helper no ejecuta requests ni cambia permisos de subagentes.

### Examples

- Fixture de padre e hijo con fingerprint final idéntico produce mismo cacheKey y diferente runtimeSessionID/transportAffinity.
- Cambio de tool schema o cuenta produce rama propia; parentID solo no permite compartir.

### Counterexamples

- Hash de AGENTS.md igual no basta si agent.prompt o memory cambia antes del corte.
- Añadir Astra a RESPONSES_LITE_MODELS para aprovechar cache altera transporte sin evidencia.

### Non Goals

- No herencia automática en task/background/workflow, persistencia, sharing entre proyectos, ni afirmar hits reales. Esta entrega prepara el seam con producción legacy.

### Acceptance

- Matriz de aislamiento pasa; plugin sin opción nueva es wire-compatible; opción de fixture modifica solo key; no caller productivo la pasa ni introduce requests.

### Required Capabilities

- code
- command

### Traces To

- R4
- R6

### Verification

- kind: text_test
- procedure: PROPUESTO: bun test --timeout 30000 test/session/cache-lineage.test.ts test/plugin/codex.test.ts; inspección de callers de prepareCodexChatGPTOAuthRequest para confirmar ausencia de activación en producción.
- cwd: src/mendcode/packages/opencode
- preconditions: T2 integrado, T0 ownership del plugin resuelto; tests con body y tokens ficticios, sin red externa.
- expected: Seam opcional independiente de afinidad, defaults idénticos y ninguna herencia no demostrada.
- evidence: .agents/plans/mendcode-astra-modular-cache.T3.txt


### Stop Condition

Caller necesita propagar key a través de una ruta no verificada o fuera de paths declarados; dejar legacy y revisar contrato.

## T4 — Normalizar observación modular sin fabricar estado warm

### Work Kind

product_code

### Depends On

- T2
- T3

### Parallel Group

None.

### Read First

- src/mendcode/packages/opencode/src/session/context-profile.ts
- src/mendcode/packages/opencode/src/session/session.ts
- src/mendcode/packages/opencode/src/session/llm.ts
- src/mendcode/packages/opencode/src/mend/runtime/provider-adapters.ts
- src/mendcode/packages/opencode/src/provider/cache-policy.ts

### Edit Files

- src/mendcode/packages/opencode/src/provider/cache-policy.ts
- src/mendcode/packages/opencode/test/provider/cache-policy.test.ts

### New Files

None.

### Symbols

- Nuevo normalizeCacheObservation
- Session.getUsage
- ContextProfile.usageReported
- contextReport

### Interfaces

- normalizeCacheObservation({inputTokens?:unknown,readTokens?:unknown,writeTokens?:unknown,observedAtMs:number}):{inputTokens:number|null,readTokens:number|null,writeTokens:number|null,hitRatio:number|null,observedAtMs:number,state:'hit_observed'|'miss_observed'|'unknown',expiresAtMs:null}. Números tokens finitos enteros >=0; invalid/ausente => null. Ratio solo con input>0, read conocido y read<=input. read>input invalida read y ratio; write>input invalida write. observedAtMs inválido produce RangeError sin efectos.

### Inputs

- Uso reportado en la respuesta, no estimaciones de Token.estimate ni valores default de Session.getUsage.

### Outputs

- Normalizador reutilizable por futuros adapters, compatible con null de contextReport; ningún cambio de contabilidad o UI existente.

### Operation Order

1. Implementar validación y estados observados sin reloj implícito.
2. Usar fixtures representativas de usageReported existente para demostrar que missing no se vuelve cero.
3. Inspeccionar que el módulo no suma de nuevo coste step y acumulado assistant ni escribe metadata/transcript.

### Error Semantics

- Métrica ausente/NaN/negativa/infinita/fraccionaria => null; read=0 explícito => miss_observed; read>0 válido => hit_observed incluso si total desconocido, con ratio null.
- Nunca warm/expiry garantizado a partir de un hit ni ahorro USD desde precio OAuth cero.

### Examples

- input=10000,read=8000,write=0 => ratio .8, hit_observed, expiry null.
- {} con timestamp válido => unknown; read=0 => miss_observed sin afirmar caché global cold.

### Counterexamples

- cachedTokens ?? 0 fabrica un miss si el proveedor no reportó datos.
- Sumar estimados de tokens a facturación o declarar 30 minutos garantizados inventa evidencia.

### Non Goals

- Sin dashboard/comandos nuevos, uso normal duplicado, savings estimados, almacenamiento ni llamadas adicionales.

### Acceptance

- Boundaries de números y unknown pasan; se conserva API de contabilidad publicada; módulo es puro.

### Required Capabilities

- code
- command

### Traces To

- R5
- R6

### Verification

- kind: text_test
- procedure: PROPUESTO: bun test --timeout 30000 test/provider/cache-policy.test.ts; comparar contrato null y granularidad por step con contextReport de la base integrada.
- cwd: src/mendcode/packages/opencode
- preconditions: T2/T3 integrados; fixtures puras sin provider ni base real.
- expected: Cero y unknown distinguibles, ninguna garantía de TTL/coste inventada y cero side effects.
- evidence: .agents/plans/mendcode-astra-modular-cache.T4.txt


### Stop Condition

Métricas de provider no pueden interpretarse sin convención específica: dejar unknown, no adaptar facturación silenciosamente.

## T5 — Cerrar condiciones de la segunda fase Cache Keeper

### Work Kind

decision

### Depends On

- T2
- T3
- T4

### Parallel Group

None.

### Read First

- src/mendcode/packages/opencode/src/provider/cache-policy.ts
- src/mendcode/packages/opencode/src/session/cache-lineage.ts
- src/mendcode/packages/opencode/src/session/llm.ts
- src/mendcode/packages/opencode/src/mend/runtime/provider-adapters.ts
- src/mendcode/packages/opencode/package.json

### Edit Files

None.

### New Files

None.

### Symbols

- CacheBinding/CacheCapabilities
- prepareResponsesLiteRequest
- discoveryWireMiddleware

### Interfaces

- Matriz de habilitación futura por binding: fuente y fecha, versión SDK y peers, serializer wire, breakpoint/control, TTL mínimo/renovación, usage reportado, pricing/quota, permiso de refresh, estado VERIFIED|UNVERIFIED|UNSUPPORTED. Toda afirmación pendiente permanece UNVERIFIED.

### Inputs

- Propuesta suministrada: explicit breakpoints y TTL 30m para GPT-5.6+, Anthropic 5m/1h, OpenRouter sticky session, SDK OpenAI 4.x; todas requieren verificación de contrato exacto antes de habilitar.

### Outputs

- Informe de preparación y propuesta de siguiente paquete, con keeper bloqueado y ningún request activo.

### Operation Order

1. Inspeccionar versión instalada de SDK y serializer y peers sin instalar; fuentes primarias OpenAI prompt-caching, Anthropic prompt-caching y OpenRouter caching, registrando si faltan herramientas de lectura web. Issues no son especificación API.
2. Para cada binding distinguir soporte declarado, serialización local probada y canary real pendiente; OAuth nunca hereda capacidades API key.
3. Definir fase futura: una única autoridad de scheduler por backend, leases acotados y limpieza por InstanceState, un in-flight por lineage, cancelación al llegar actividad normal/off/dispose, no revivir tras reinicio sin evidencia nueva.
4. Contrato futuro recomendado: preserve off por defecto; opt-in smart/always con límites efectivos proyecto/sesión subordinados a off global, maxIdleSeconds=7200, maxWarmSessions=4, concurrencia refresh=1, maxAttemptsPerWake=1 y timeoutSeconds=30. Always no anula permiso, presupuesto ni soporte. Sin TTL conocido/estimación económica fiable no hay refresh.
5. Request futuro debe reutilizar exactamente prefix wire incluyendo definiciones tools, sin ejecutarlas, sin hooks/transcript/updatedAt/summary/wake; si endpoint exige auto tools y no existe aislamiento seguro no habilitar. Añadir sufijo nuevo solo si no altera prefijo. Cancelación no autoriza reintento duplicado.
6. Tras miss/unknown/error suspender lease hasta actividad real; 429 respetar retry-after sin retry activo; auth failure deshabilita binding. Coste real del refresh se contabiliza separado y una sola vez; no usar precios API para OAuth. Pin no sobrepasa presupuesto ni autoriza modelo.
7. Exigir nuevo paquete para controles UI/CLI, config validada, scheduler durable/persistencia y canary autorizado antes de implementación. No marcar esta fase implementada por escribir el informe.

### Error Semantics

- Sin documentación/credenciales/permiso de gasto el informe registra BLOCKED para habilitación, pero no bloquea aceptación del núcleo pasivo.
- Refrescar sin conservar prefijo o sin inhibir herramientas invalida binding, aunque HTTP 200.

### Examples

- OpenAI API wire verificado pero OAuth sin prueba: API candidato a canary; OAuth legacy, sin keeper.
- SDK 4.x incompatible con ai/provider-utils instalado exige migración independiente y pruebas de todos los adapters afectados.

### Counterexamples

- Ping cada 26 minutos para todos los providers y sesiones consume cuota sin garantía.
- Same key o cached_tokens positivo no demuestra dos niveles de caché ni lease garantizado.

### Non Goals

- No pruebas pagadas, red hacia endpoints de inferencia, scheduler, comandos /cache o promesa de ahorro en esta entrega.

### Acceptance

- Cada afirmación tiene estado y fuente/limitación; fase activa tiene condiciones claras de habilitación y permanece desactivada.

### Required Capabilities

- repository_read
- command
- documentation_read

### Traces To

- R6

### Verification

- kind: acceptance
- procedure: PROPUESTO: revisión documental del SDK instalado y fuentes primarias https://developers.openai.com/api/docs/guides/prompt-caching, https://platform.claude.com/docs/en/build-with-claude/prompt-caching y https://openrouter.ai/docs/guides/best-practices/prompt-caching. Registrar información inaccesible como UNVERIFIED; comprobar que no se realizó inferencia ni se añadieron refresh callers.
- cwd: .
- preconditions: Acceso de lectura a fuentes y dependencias, o registrar ausencia. No autorización de llamadas de proveedor implícita.
- expected: Matriz honesta, prerequisitos de fase activa y límites propuestos sin claims de ejecución.
- evidence: .agents/plans/mendcode-astra-modular-cache.T5.txt


### Stop Condition

Habilitación activa solicitada requiere nuevo contrato y autorización; continuar cierre pasivo por separado.

## T6 — Aceptar delta pasivo y preparar prueba local del usuario

### Work Kind

acceptance

### Depends On

- T0
- T1
- T2
- T3
- T4
- T5

### Parallel Group

None.

### Read First

- src/mendcode/packages/opencode/src/mend/prompt/sources.ts
- src/mendcode/packages/opencode/src/provider/cache-policy.ts
- src/mendcode/packages/opencode/src/session/cache-lineage.ts
- src/mendcode/packages/opencode/src/plugin/codex.ts
- src/mendcode/packages/opencode/src/provider/transform.ts

### Edit Files

None.

### New Files

None.

### Symbols

- Perfil Astra, CacheAdapter, CacheIdentity, normalizeCacheObservation

### Interfaces

- Lead registra criterios PASS/FAIL/BLOCKED/NOT_RUN; aceptación pasiva no equivale a keepalive ni ahorro probado.

### Inputs

- Diff integrado, fingerprints y evidencia T0-T5; beta.6 como baseline.

### Outputs

- Evidencia agregada y recomendación local con bloqueos de fase activa explícitos.

### Operation Order

1. Revisar diff y callers por compatibilidad, permisos, activación accidental, identidad y datos sensibles.
2. Reutilizar checks vigentes; correr typecheck del paquete tras integrar. Si baseline ya falla, registrar errores previos separados sin llamar PASS al criterio fallido.
3. Confirmar ausencia de nuevos timers, llamadas de inferencia, migrations/version/SDK y cambios ajenos; pedir prueba local antes de lifecycle de release.
4. Registrar versión propuesta como no seleccionada; no publicar ni atribuir pruebas live.

### Error Semantics

- Falla de criterio requerido bloquea aceptación; mantenimiento UNVERIFIED se informa fuera del incremento pasivo y no se vende como feature terminada.

### Examples

- Núcleo pasivo y prompt pasan checks; informe dice 'keeper pendiente de integración/validación', no 'cache warm funcionando'.

### Counterexamples

- Solo snapshots de texto o mocks no prueban ahorro, tokens cobrados o compatibilidad endpoint.

### Non Goals

- No commit/push/bump/release, pruebas amplias sin motivo ni modificar resultados anteriores.

### Acceptance

- R1-R7 tienen evidencia proporcionada al alcance; el usuario puede revisar cambios locales; fase activa y límites de evidencia son inequívocos.

### Required Capabilities

- code_read
- command

### Traces To

- R1
- R2
- R3
- R4
- R5
- R6
- R7

### Verification

- kind: acceptance
- procedure: PROPUESTO: bun typecheck desde paquete; revisar evidencia focalizada T1-T4 y diff integrado. Reejecutar tests solo al invalidarse source/entorno/cobertura; comprobar que llamadas de preparación OAuth sin managedCacheKey son idénticas y no se añadieron productores de refresh.
- cwd: src/mendcode/packages/opencode
- preconditions: T0-T5 completos con evidence fingerprints; toolchain instalado; checks aislados de DB/config global.
- expected: Tipos y criterios pasivos pasan; ningún resultado live inventado, ninguna publicación o cambio ajeno.
- evidence: .agents/plans/mendcode-astra-modular-cache.T6.txt


### Stop Condition

Error de tipos, regresión o wire cambiado sin explicación: volver a tarea responsable, no liberar.
