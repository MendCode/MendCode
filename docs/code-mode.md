# Code Mode

Native sessions can opt in through the existing daemon settings protocol:

```json
{"type":"settings.set","patch":{"experimental":{"code_mode":true,"tool_discovery":true}}}
```

`code_mode` is off when unset or false, independent of `tool_discovery`. Settings persist across daemon restarts
and apply on the next model step. An `experimental` patch replaces the object: retain existing `primary_tools`
and `continue_loop_on_deny` values when toggling this flag. External engines retain their own tools.

The model gets `code({code})`. Its confined JavaScript program calls the permission-filtered catalog through
`tools.<name>(input)` or `tools[name](input)`. Tool results are `{output, title, truncated, meta?}`. Only the
selected JSON return value (or final expression), console logs and a bounded call receipt enter model history. Returned
promises are awaited by the implicit async body. Nested tool inputs,
outputs and approvals remain in the daemon audit/transcript, linked to the parent by `meta.parentItemId`.
The CLI uses its existing tool rows; Ctrl+O expands the results. No new page or sidebar is needed.

```js
const found = search({query: "symbols", limit: 3})
const results = await Promise.all(found.tools.map(async entry => {
  const result = await tools[entry.name]({path: "src/main.ts"})
  return {tool: entry.name, data: JSON.parse(result.output)}
}))
console.log(results.length, "results")
return results
```

`search({query?, limit?})` uses B26's local lookup and bounds (500 characters, 16 search words, limit 1–8,
24 KiB schema receipt, 64 secondary slots). Successful search receipts survive in retained native history and
activate the schemas on subsequent model steps. Compaction removes old receipts. Search invokes no service
and grants no permission. Tools can be called within the program without first exposing their schemas to the
model; every nested call is still validated and checked against current tool/path policy, the selected agent,
main-only restrictions, plan mode, grants, the smart reviewer and extension argument rewrites. Three repeated
identical nested calls still trigger `doom_loop` (in full mode a refusal the model reads, not a prompt). A user rejection stops by default; `continue_loop_on_deny`
allows the model to adapt. Secret substitution stays in the host, and output is masked before Code Mode sees it.

The supported language is JavaScript or TypeScript. TypeScript types (annotations, generics, `as`/`satisfies`,
`!`, interfaces, type aliases, overload signatures, `declare`, `implements`, `abstract`, member modifiers) are
skipped, never executed or checked; `enum`, `namespace`, imports/exports and `<T>x` assertions are diagnosed.

- Classes: declarations and expressions with constructors (including TypeScript parameter properties), methods,
  fields, `static` members and static blocks, `extends`/`super()`/`super.method()`, getters/setters (instance, static
  and `#private`), `#private` fields and methods, computed names, async/generator methods and `instanceof`.
  A class can extend another program class or an Error type (`extends Error` keeps `instanceof Error`, `name`,
  `message`); other built-ins cannot be extended. Instances are plain records: JSON, spread and `Object.*` see own
  fields only, and getters are not serialized. A typed field without initializer (`x: number`) emits nothing; a plain
  `x` field defines `undefined`. `toString`/`Symbol` hooks, `new.target`, `static` inheritance of private names and
  cyclic instances (rejected like any cyclic data) are not supported. Constructor and method depth counts toward the
  64-level limit, and every field initializer, getter and setter spends the normal operation budget.
- Object literals accept `get`/`set` accessors and methods that use `this`; `{...obj}` evaluates the getters, but an
  object with accessors cannot cross the JSON boundary (copy its values into a plain object first).
- Labels: `name: for/while/do/for…of/for…in/{ block }`, `break name` and `continue name`. A label must be declared
  in the same function; unknown, duplicate or cross-function labels are parse errors.

- Bindings: const/let/var (var is function-scoped), hoisted function declarations, per-iteration `let` in loops,
  destructuring with defaults, rest, nesting, holes, renames, parameter patterns and swap assignments.
- Control flow: if/else, for, for…of, for…in, `for await`, while, do…while, switch, break/continue,
  try/catch/finally with thrown values preserved, `??=`/`||=`/`&&=`, optional chains (`?.`, `?.()`, `?.[]`),
  bitwise/shift operators, `in`, `instanceof`, ternaries and template literals with substitutions.
- Functions: declarations, arrows, default and rest parameters, closures, recursion (depth 64), async functions,
  generators (`function*`, `yield`, `yield*`, `.next/.return/.throw`) and async generators.
- Promises: `await`, `.then/.catch/.finally` chains, `new Promise`, `Promise.all/allSettled/race/any/resolve/reject`.
  Started host calls may be collected in arrays and awaited together; the 16-call budget still applies.
- Library: Object/Array/String/Number/Math/JSON helpers, Map, Set, Date (always UTC), RegExp, URL,
  URLSearchParams, Error types, `structuredClone`, `encodeURIComponent` and friends, `console`.

Maps, Sets and RegExps live inside the program: they cannot be returned, logged as data or passed to a tool
(convert with `[...map]`, `Object.fromEntries(map)` or `[...set]`); Date and URL values become ISO/href strings at
that boundary. Built-in values are read-only and expose no host internals. Unsupported syntax and unknown globals
return a diagnostic. There is no eval, Function, import, process, Bun, require, filesystem, network, timer
or prototype access (`constructor`, `__proto__` and `prototype` stay blocked on classes too). Runtime functions and promises cannot cross the JSON boundary. Programs must await all work;
unawaited work is aborted and finalized before the receipt returns. A timed-out nested approval is abandoned
independently of the surrounding turn; a stale approval cannot resume it.

Regular expressions cannot be interrupted once running, so they are checked first: no backreferences, no quantified
group containing an unbounded quantifier, no unbounded quantified alternation, patterns up to 500 characters, and an
input cap per operation derived from the longest chain of overlapping unbounded atoms (16 KiB for simple patterns,
down to a few dozen characters for pathological ones). Violations return `UnsafeRegExp` or `ValueLimitExceeded`;
split large text into lines first. Aliased data graphs are limited to 262,144 visited nodes per copy.

| Limit | Per program |
|---|---|
| Source | 32 KiB UTF-8 |
| Host calls | 16, including failures |
| Result/logs/envelope | 24 KiB UTF-8, valid JSON with `truncated` |
| Deadline | 30 seconds, including permissions and cleanup initiation |
| Operations / function depth | 500,000 / 64 |
| Data depth / individual value | 32 / 1 MiB |
| Cumulative allocated data | 8 MiB |

B71 runtime decision: an in-process AST interpreter, with cooperative checkpoints on every execution path
and no native evaluation. Empty loops yield to the daemon and deadline. This is a confined language, not an OS
sandbox or a hard process heap quota. Host tool cleanup must honor its AbortSignal; result delivery waits for
admitted calls to finalize. No listener, external service, network in tests or dependency is added. `code` is
reserved from extension registration even while disabled.
