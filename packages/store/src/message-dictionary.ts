/**
 * The preset dictionary small model messages are deflated with (`compress.ts`, kind `D`). A message under a kilobyte gains little
 * from compression alone (a short tool output or answer is 20 to 30 % smaller with zstd); most of what such a message holds is
 * MendCode's own spelling: the JSON envelope, the tool names and their argument keys, the `<orientation>` block that opens every
 * session, the read tool's numbered lines. Seeded with those, the same messages store in about half the bytes.
 *
 * Frozen: every stored message of kind `D` was deflated against these exact bytes, so they never change. A new dictionary is a
 * new kind. Only MendCode's fixed text goes here, never a project's or a user's.
 */
const numbered = Array.from({ length: 12 }, (_, i) => `\\n${String(i + 1).padStart(6)}\\t`).join("")

export const MESSAGE_DICTIONARY_V1: Uint8Array = new TextEncoder().encode([
  "instruction files already in your system prompt (do not search for them): AGENTS.md, CLAUDE.md",
  "package manager bun · tests: bun run test (bun test) · package manager npm · tests: npm test · cargo · tests: cargo test · go · tests: go test ./...",
  "\\ngit branch: main\\ngit branch: master\\nno project instruction file (AGENTS.md, CLAUDE.md) exists here or above\\nfiles (",
  "):\\nsrc/\\npackage.json\\nREADME.md\\ntsconfig.json\\n</orientation>\\n\\n",
  "<orientation>\\ncwd: /Users/",
  '"name":"shell","args":{"command":"',
  '"name":"grep","args":{"pattern":"',
  '"name":"glob","args":{"pattern":"',
  '"name":"write","args":{"path":"',
  '"name":"edit","args":{"path":"","oldString":"","newString":"',
  '"name":"apply_patch","args":{"',
  '"name":"read","args":{"path":"',
  '","isError":true}',
  '{"role":"tool","callId":"call_","name":"shell","output":"',
  '{"role":"tool","callId":"call_","name":"read","output":"',
  numbered,
  '","isError":false}',
  '","toolCalls":[{"callId":"call_',
  '","toolCalls":[]}',
  "\\n- `",
  "`\\n- ",
].join(""))
