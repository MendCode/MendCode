/**
 * The preset dictionary a small sealed turn is deflated with (`turn-blocks.ts`, block version 2). A short turn is a few
 * kilobytes of event rows that spell MendCode's own envelope again and again (event types, ids' prefixes, the keys of
 * `item.started`, `item.completed` and `usage.recorded`); zstd learns them inside each block, a preset dictionary starts with
 * them. On real sessions, turns under 4 KB are 17 % smaller than with zstd alone; larger turns keep zstd (version 1).
 *
 * Frozen: every block of version 2 was deflated against these exact bytes, so they never change. A new dictionary is a new
 * block version. Only MendCode's fixed spelling goes here, never a project's, a model's or a user's text.
 */
export const EVENT_DICTIONARY_V1: Uint8Array = new TextEncoder().encode([
  "session.createdqueue.addedqueue.changedturn.starteditem.starteditem.deltaitem.completedusage.recordedturn.completedturn.failedturn.interruptedfile.changedpermission.requestedpermission.resolved",
  '{"directory":"/Users/","title":""}',
  '{"queueId":"que_","text":"","attachments":[]}{"queue":[]}',
  '"provider":"chatgpt","model":"","provider":"claude","model":"',
  ',"input":,"output":,"reasoning":0,"cacheRead":0,"cacheWrite":0,"profile":[,"compactAt":',
  '{"turnId":"trn_","queueId":"que_"}',
  '{"turnId":"trn_","itemId":"itm_","kind":"user_message"}',
  '{"turnId":"trn_","itemId":"itm_","kind":"agent_message","meta":{"historyIndex":',
  '{"turnId":"trn_","itemId":"itm_","kind":"reasoning"}',
  '{"turnId":"trn_","itemId":"itm_","kind":"tool_call","meta":{"tool":"shell: ',
  '{"turnId":"trn_","itemId":"itm_","kind":"tool_call","meta":{"tool":"read: ',
  '","toolInput":"{\\"path\\":\\"","meta":{"path":"/Users/","lines":',
  '","toolInput":"{\\"command\\":\\"","meta":{"exitCode":0,',
  ',"meta":{"firstDeltaAt":',
  '{"itemId":"itm_","status":"ok","text":"',
  '{"turnId":"trn_"}',
].join(""))
