import { CodeError } from "./code-parser"
import { checkInput, compileRegExp } from "./code-regex"
import type { Runtime } from "./code-runtime"
import { CDate, CMap, CParams, CRegExp, CSet, CURL, Callable, Deferred, Gen, MAX_ITEMS, Native, Scope, Thrown, blocked, data, describe, isError, isPlain, isWrapper, makeError, object, utf8 } from "./code-values"

/** Standard library for Code Mode programs. Everything here is a whitelisted, budgeted re-implementation: no host object is ever exposed. */
const method = (run: (args: unknown[], depth: number) => unknown) => new Callable(async (args, depth) => run(args, depth))
function fail(kind: string, message: string): never { throw new CodeError(kind, message) }
const clip = (ms: number) => Number.isFinite(ms) && Math.abs(ms) <= 8.64e15 ? Math.trunc(ms) : NaN

function matchResult(match: RegExpExecArray) {
  const result = Object.assign([...match] as unknown[], { index: match.index, input: match.input }) as unknown[] & { groups?: unknown }
  if (match.groups) {
    const groups = object()
    for (const [name, value] of Object.entries(match.groups)) if (!blocked.has(name)) groups[name] = value
    result.groups = groups
  } else result.groups = undefined
  return result
}
/** Collects regular-expression matches without touching the program's own regexp state. */
function allMatches(re: CRegExp, input: string, global: boolean): RegExpExecArray[] {
  checkInput(re, input)
  const native = new RegExp(re.native.source, re.native.flags.includes("g") || !global ? re.native.flags : `${re.native.flags}g`)
  const matches: RegExpExecArray[] = []
  if (!native.global) { const match = native.exec(input); return match ? [match] : [] }
  while (matches.length < MAX_ITEMS) {
    const match = native.exec(input)
    if (!match) break
    matches.push(match)
    if (match[0] === "") native.lastIndex++
  }
  return matches
}
function expand(template: string, match: { 0: string; index: number; groups?: Record<string, string> | undefined } & ArrayLike<string | undefined>, input: string) {
  return template.replace(/\$(\$|&|`|'|\d{1,2}|<[^>]*>)/g, (token, code: string) => {
    if (code === "$") return "$"
    if (code === "&") return match[0]
    if (code === "`") return input.slice(0, match.index)
    if (code === "'") return input.slice(match.index + match[0].length)
    if (code.startsWith("<")) return match.groups?.[code.slice(1, -1)] ?? ""
    const index = Number(code)
    return index > 0 && index < match.length ? match[index] ?? "" : token
  })
}
async function replaceText(rt: Runtime, input: string, pattern: unknown, replacement: unknown, all: boolean, depth: number): Promise<string> {
  let matches: Array<RegExpExecArray | { 0: string; index: number; length: number; groups?: undefined }>
  if (pattern instanceof CRegExp) {
    if (all && !pattern.native.global) fail("InvalidDataValue", "replaceAll needs a global regular expression")
    matches = allMatches(pattern, input, pattern.native.global)
  } else {
    const needle = rt.text(pattern)
    matches = []
    for (let from = input.indexOf(needle); from >= 0 && matches.length < MAX_ITEMS; from = input.indexOf(needle, from + Math.max(1, needle.length))) {
      matches.push(Object.assign([needle], { index: from }) as unknown as { 0: string; index: number; length: number })
      if (!all) break
      if (from >= input.length) break
    }
  }
  const template = replacement instanceof Callable ? undefined : rt.text(replacement)
  let out = "", last = 0
  for (const match of matches) {
    await rt.tick()
    const value = template === undefined ? rt.text(await (replacement as Callable).call([...Array.from(match as ArrayLike<string | undefined>), match.index, input, ...(match.groups ? [match.groups] : [])], depth)) : expand(template, match as never, input)
    out += input.slice(last, match.index) + value
    if (out.length > rt.limits.maxValueBytes) fail("ValueLimitExceeded", "String exceeds budget")
    last = match.index + match[0].length
  }
  return rt.budget(out + input.slice(last))
}

async function sort(rt: Runtime, target: unknown[], callback: unknown, depth: number) {
  if (callback !== undefined && !(callback instanceof Callable)) fail("InvalidDataValue", "sort needs a function")
  const compare = async (left: unknown, right: unknown) => {
    await rt.tick()
    if (left === undefined || right === undefined) return left === undefined ? right === undefined ? 0 : 1 : -1
    if (callback instanceof Callable) return rt.number(await callback.call([left, right], depth))
    const a = rt.text(left), b = rt.text(right)
    return a < b ? -1 : a > b ? 1 : 0
  }
  const sorted = [...target], scratch = [...target]
  for (let size = 1; size < sorted.length; size *= 2) {
    for (let start = 0; start < sorted.length; start += size * 2) {
      let left = start, right = Math.min(start + size, sorted.length)
      const middle = right, end = Math.min(start + size * 2, sorted.length)
      for (let index = start; index < end; index++) scratch[index] = right >= end || left < middle && await compare(sorted[left], sorted[right]) <= 0 ? sorted[left++] : sorted[right++]
    }
    for (let index = 0; index < sorted.length; index++) sorted[index] = scratch[index]
  }
  return sorted
}

function arrayMember(rt: Runtime, arr: unknown[], key: string): unknown {
  const walk = async (callback: unknown, depth: number, visit: (answer: unknown, item: unknown, index: number) => boolean | void, reverse = false) => {
    if (!(callback instanceof Callable)) fail("InvalidDataValue", `${key} needs a function`)
    const length = arr.length
    for (let step = 0; step < length; step++) {
      const index = reverse ? length - 1 - step : step
      await rt.tick()
      const item = arr[index]
      if (visit(await (callback as Callable).call([item, index, arr], depth), item, index) === true) return
    }
  }
  const range = (start: unknown, end: unknown) => [start === undefined ? 0 : rt.number(start), end === undefined ? undefined : rt.number(end)] as const
  switch (key) {
    case "length": return arr.length
    case "at": return method(([index]) => arr.at(rt.number(index)))
    case "sort": return method(async ([callback], depth) => { const sorted = await sort(rt, arr, callback, depth); sorted.forEach((item, index) => { arr[index] = item }); return arr })
    case "toSorted": return method(async ([callback], depth) => rt.budget(await sort(rt, arr, callback, depth)))
    case "map": return method(async ([callback], depth) => { const out: unknown[] = []; await walk(callback, depth, (answer) => { out.push(answer) }); return rt.budget(out) })
    case "filter": return method(async ([callback], depth) => { const out: unknown[] = []; await walk(callback, depth, (answer, item) => { if (answer) out.push(item) }); return rt.budget(out) })
    case "flatMap": return method(async ([callback], depth) => { const out: unknown[] = []; await walk(callback, depth, (answer) => { out.push(answer) }); return rt.budget(out.flat(1)) })
    case "forEach": return method(async ([callback], depth) => { await walk(callback, depth, () => undefined) })
    case "find": return method(async ([callback], depth) => { let found: unknown; await walk(callback, depth, (answer, item) => { if (answer) { found = item; return true } }); return found })
    case "findLast": return method(async ([callback], depth) => { let found: unknown; await walk(callback, depth, (answer, item) => { if (answer) { found = item; return true } }, true); return found })
    case "findIndex": return method(async ([callback], depth) => { let found = -1; await walk(callback, depth, (answer, _, index) => { if (answer) { found = index; return true } }); return found })
    case "findLastIndex": return method(async ([callback], depth) => { let found = -1; await walk(callback, depth, (answer, _, index) => { if (answer) { found = index; return true } }, true); return found })
    case "some": return method(async ([callback], depth) => { let found = false; await walk(callback, depth, (answer) => { if (answer) { found = true; return true } }); return found })
    case "every": return method(async ([callback], depth) => { let ok = true; await walk(callback, depth, (answer) => { if (!answer) { ok = false; return true } }); return ok })
    case "reduce": case "reduceRight": return method(async ([callback, ...initial], depth) => {
      if (!(callback instanceof Callable)) fail("InvalidDataValue", `${key} needs a function`)
      const indexes = arr.map((_, index) => index)
      if (key === "reduceRight") indexes.reverse()
      let accumulator: unknown, start = 0
      if (initial.length) accumulator = initial[0]
      else { if (!indexes.length) fail("ExecutionFailure", "Reduce of empty array"); accumulator = arr[indexes[0]!]; start = 1 }
      for (const index of indexes.slice(start)) { await rt.tick(); accumulator = await (callback as Callable).call([accumulator, arr[index], index, arr], depth) }
      return accumulator
    })
    case "push": case "unshift": return method((args) => {
      if (arr.length + args.length > MAX_ITEMS) fail("ValueLimitExceeded", "Array length exceeds budget")
      if (args.includes(arr)) fail("InvalidDataValue", "Circular data")
      rt.budget(args)
      return key === "push" ? arr.push(...args) : arr.unshift(...args)
    })
    case "pop": return method(() => arr.pop())
    case "shift": return method(() => arr.shift())
    case "splice": return method(([start, count, ...items]) => {
      if (arr.length + items.length > MAX_ITEMS) fail("ValueLimitExceeded", "Array length exceeds budget")
      if (items.includes(arr)) fail("InvalidDataValue", "Circular data")
      rt.budget(items)
      const first = start === undefined ? 0 : rt.number(start)
      return rt.budget(count === undefined ? start === undefined ? arr.splice(0, 0) : arr.splice(first) : arr.splice(first, rt.number(count), ...items))
    })
    case "slice": return method(([start, end]) => { const [from, to] = range(start, end); return rt.budget(arr.slice(from, to)) })
    case "concat": return method((args) => {
      const out = arr.concat(...args.map((arg) => Array.isArray(arg) ? arg : [arg]))
      if (out.length > MAX_ITEMS) fail("ValueLimitExceeded", "Array length exceeds budget")
      return rt.budget(out)
    })
    case "join": return method(([separator]) => {
      const glue = separator === undefined ? "," : rt.text(separator)
      let length = glue.length * Math.max(0, arr.length - 1)
      const parts = arr.map((item) => {
        const part = item === null || item === undefined ? "" : rt.text(item)
        length += part.length
        if (length > rt.limits.maxValueBytes) fail("ValueLimitExceeded", "String exceeds budget")
        return part
      })
      return rt.budget(parts.join(glue))
    })
    case "toString": return method(() => rt.budget(arr.map((item) => item === null || item === undefined ? "" : rt.text(item)).join(",")))
    case "includes": return method(([item]) => arr.includes(item))
    case "indexOf": return method(([item]) => arr.indexOf(item))
    case "lastIndexOf": return method(([item]) => arr.lastIndexOf(item))
    case "reverse": return method(() => arr.reverse())
    case "toReversed": return method(() => rt.budget([...arr].reverse()))
    case "flat": return method(([depth]) => rt.budget(arr.flat(Math.max(0, Math.min(32, depth === undefined ? 1 : rt.number(depth))))))
    case "fill": return method(([value, start, end]) => { const [from, to] = range(start, end); rt.budget(value); return arr.fill(value, from, to) })
    case "keys": return method(() => arr.map((_, index) => index))
    case "values": return method(() => [...arr])
    case "entries": return method(() => rt.budget(arr.map((item, index) => [index, item])))
    case "with": return method(([index, value]) => { const copy = [...arr], at = rt.number(index), real = at < 0 ? copy.length + at : at; if (real < 0 || real >= copy.length) fail("RangeError", "Invalid index"); copy[real] = value; return rt.budget(copy) })
  }
  if (/^\d+$/.test(key)) return arr[Number(key)]
  return Object.hasOwn(arr, key) ? (arr as unknown as Record<string, unknown>)[key] : undefined
}

function stringMember(rt: Runtime, s: string, key: string): unknown {
  if (key === "length") return s.length
  if (/^\d+$/.test(key)) return s[Number(key)]
  const text = (value: unknown) => rt.text(value)
  const optional = (value: unknown) => value === undefined ? undefined : rt.number(value)
  const pad = (start: boolean) => method(([length, filler]) => {
    const target = rt.number(length)
    if (!Number.isFinite(target) || target > rt.limits.maxValueBytes) fail("ValueLimitExceeded", "String exceeds budget")
    return rt.budget(start ? s.padStart(target, filler === undefined ? " " : text(filler)) : s.padEnd(target, filler === undefined ? " " : text(filler)))
  })
  switch (key) {
    case "trim": return method(() => s.trim())
    case "trimStart": case "trimLeft": return method(() => s.trimStart())
    case "trimEnd": case "trimRight": return method(() => s.trimEnd())
    case "toLowerCase": return method(() => s.toLowerCase())
    case "toUpperCase": return method(() => s.toUpperCase())
    case "toString": case "valueOf": return method(() => s)
    case "charAt": return method(([index]) => s.charAt(rt.number(index ?? 0)))
    case "charCodeAt": return method(([index]) => s.charCodeAt(rt.number(index ?? 0)))
    case "codePointAt": return method(([index]) => s.codePointAt(rt.number(index ?? 0)))
    case "at": return method(([index]) => s.at(rt.number(index ?? 0)))
    case "includes": return method(([needle, from]) => s.includes(text(needle), optional(from)))
    case "startsWith": return method(([needle, from]) => s.startsWith(text(needle), optional(from)))
    case "endsWith": return method(([needle, end]) => s.endsWith(text(needle), optional(end)))
    case "indexOf": return method(([needle, from]) => s.indexOf(text(needle), optional(from)))
    case "lastIndexOf": return method(([needle, from]) => s.lastIndexOf(text(needle), optional(from)))
    case "slice": return method(([start, end]) => s.slice(rt.number(start ?? 0), optional(end)))
    case "substring": return method(([start, end]) => s.substring(rt.number(start ?? 0), optional(end)))
    case "substr": return method(([start, length]) => s.substr(rt.number(start ?? 0), optional(length)))
    case "concat": return method((args) => rt.budget(s + args.map(text).join("")))
    case "padStart": return pad(true)
    case "padEnd": return pad(false)
    case "localeCompare": return method(([other]) => s.localeCompare(text(other), "en"))
    case "normalize": return method(([form]) => { const name = form === undefined ? "NFC" : text(form); if (!["NFC", "NFD", "NFKC", "NFKD"].includes(name)) fail("RangeError", "Invalid normalization form"); return s.normalize(name) })
    case "split": return method(([separator, limit]) => {
      const count = Math.min(MAX_ITEMS, limit === undefined ? MAX_ITEMS : rt.number(limit))
      if (separator === undefined) return [s]
      if (separator instanceof CRegExp) { checkInput(separator, s); return rt.budget(s.split(separator.native, count)) }
      return rt.budget(s.split(text(separator), count))
    })
    case "repeat": return method(([times]) => {
      const count = rt.number(times)
      if (!Number.isSafeInteger(count) || count < 0 || s.length * count > rt.limits.maxValueBytes) fail("ValueLimitExceeded", "String repeat exceeds budget")
      return rt.budget(s.repeat(count))
    })
    case "replace": return method(([pattern, replacement], depth) => replaceText(rt, s, pattern, replacement, false, depth))
    case "replaceAll": return method(([pattern, replacement], depth) => replaceText(rt, s, pattern, replacement, true, depth))
    case "match": return method(([pattern]) => {
      const re = pattern instanceof CRegExp ? pattern : compileRegExp(pattern === undefined ? "(?:)" : text(pattern), "")
      const matches = allMatches(re, s, re.native.global)
      if (!matches.length) return null
      return rt.budget(re.native.global ? matches.map((match) => match[0]) : matchResult(matches[0]!))
    })
    case "matchAll": return method(([pattern]) => {
      const re = pattern instanceof CRegExp ? pattern : compileRegExp(text(pattern), "g")
      if (!re.native.global) fail("InvalidDataValue", "matchAll needs a global regular expression")
      return rt.budget(allMatches(re, s, true).map(matchResult))
    })
    case "search": return method(([pattern]) => {
      const re = pattern instanceof CRegExp ? pattern : compileRegExp(text(pattern), "")
      checkInput(re, s)
      return s.search(new RegExp(re.native.source, re.native.flags.replace(/[gy]/g, "")))
    })
  }
  return undefined
}

function numberMember(rt: Runtime, n: number, key: string): unknown {
  switch (key) {
    case "toFixed": return method(([digits]) => { const count = rt.number(digits ?? 0); if (!Number.isInteger(count) || count < 0 || count > 100) fail("RangeError", "toFixed digits must be between 0 and 100"); return n.toFixed(count) })
    case "toPrecision": return method(([digits]) => { if (digits === undefined) return String(n); const count = rt.number(digits); if (!Number.isInteger(count) || count < 1 || count > 100) fail("RangeError", "toPrecision digits must be between 1 and 100"); return n.toPrecision(count) })
    case "toString": return method(([radix]) => { const base = radix === undefined ? 10 : rt.number(radix); if (!Number.isInteger(base) || base < 2 || base > 36) fail("RangeError", "toString radix must be between 2 and 36"); return n.toString(base) })
    case "valueOf": return method(() => n)
  }
  return undefined
}

function promiseMember(rt: Runtime, promise: Deferred, key: string): unknown {
  const chain = (onFulfilled: unknown, onRejected: unknown, depth: number) => rt.tracked(promise.promise.then(
    async (value) => onFulfilled instanceof Callable ? rt.settle(await onFulfilled.call([value], depth)) : value,
    async (error) => { if (onRejected instanceof Callable) return rt.settle(await onRejected.call([rt.caught(error)], depth)); throw error },
  ))
  switch (key) {
    case "then": return method(([onFulfilled, onRejected], depth) => chain(onFulfilled, onRejected, depth))
    case "catch": return method(([onRejected], depth) => chain(undefined, onRejected, depth))
    case "finally": return method(([callback], depth) => rt.tracked(promise.promise.then(
      async (value) => { if (callback instanceof Callable) await callback.call([], depth); return value },
      async (error) => { if (callback instanceof Callable) await callback.call([], depth); throw error },
    )))
  }
  return undefined
}

function generatorMember(rt: Runtime, gen: Gen, key: string): unknown {
  if (key !== "next" && key !== "return" && key !== "throw") return undefined
  const send = async ([value]: unknown[]) => {
    const step = await gen.send(key, value)
    return Object.assign(object(), { value: step.value, done: step.done })
  }
  return method((args) => gen.async ? rt.tracked(send(args)) : send(args))
}

function mapMember(rt: Runtime, map: CMap, key: string): unknown {
  const inner = map.inner
  switch (key) {
    case "size": return inner.size
    case "get": return method(([item]) => inner.get(item))
    case "has": return method(([item]) => inner.has(item))
    case "set": return method(([item, value]) => {
      if (!inner.has(item) && inner.size >= MAX_ITEMS) fail("ValueLimitExceeded", "Map exceeds budget")
      rt.budget([item, value]); inner.set(item, value); return map
    })
    case "delete": return method(([item]) => inner.delete(item))
    case "clear": return method(() => { inner.clear() })
    case "keys": return method(() => [...inner.keys()])
    case "values": return method(() => [...inner.values()])
    case "entries": return method(() => [...inner].map(([k, v]) => [k, v]))
    case "forEach": return method(async ([callback], depth) => {
      if (!(callback instanceof Callable)) fail("InvalidDataValue", "forEach needs a function")
      for (const [k, v] of [...inner]) { await rt.tick(); await (callback as Callable).call([v, k, map], depth) }
    })
  }
  return undefined
}

function setMember(rt: Runtime, set: CSet, key: string): unknown {
  const inner = set.inner
  const other = (value: unknown) => value instanceof CSet ? value.inner : fail("InvalidDataValue", "Expected a Set")
  const build = (items: Iterable<unknown>) => { const result = new CSet(); for (const item of items) result.inner.add(item); rt.budget(result); return result }
  switch (key) {
    case "size": return inner.size
    case "has": return method(([item]) => inner.has(item))
    case "add": return method(([item]) => {
      if (!inner.has(item) && inner.size >= MAX_ITEMS) fail("ValueLimitExceeded", "Set exceeds budget")
      rt.budget(item); inner.add(item); return set
    })
    case "delete": return method(([item]) => inner.delete(item))
    case "clear": return method(() => { inner.clear() })
    case "values": case "keys": return method(() => [...inner])
    case "entries": return method(() => [...inner].map((item) => [item, item]))
    case "forEach": return method(async ([callback], depth) => {
      if (!(callback instanceof Callable)) fail("InvalidDataValue", "forEach needs a function")
      for (const item of [...inner]) { await rt.tick(); await (callback as Callable).call([item, item, set], depth) }
    })
    case "union": return method(([value]) => build([...inner, ...other(value)]))
    case "intersection": return method(([value]) => build([...inner].filter((item) => other(value).has(item))))
    case "difference": return method(([value]) => build([...inner].filter((item) => !other(value).has(item))))
    case "symmetricDifference": return method(([value]) => build([...[...inner].filter((item) => !other(value).has(item)), ...[...other(value)].filter((item) => !inner.has(item))]))
    case "isSubsetOf": return method(([value]) => [...inner].every((item) => other(value).has(item)))
    case "isSupersetOf": return method(([value]) => [...other(value)].every((item) => inner.has(item)))
    case "isDisjointFrom": return method(([value]) => [...inner].every((item) => !other(value).has(item)))
  }
  return undefined
}

const DATE_GETTERS: Record<string, (date: Date) => number> = {
  getTime: (date: Date) => date.getTime(), valueOf: (date: Date) => date.getTime(), getTimezoneOffset: () => 0,
  getFullYear: (date) => date.getUTCFullYear(), getMonth: (date) => date.getUTCMonth(), getDate: (date) => date.getUTCDate(), getDay: (date) => date.getUTCDay(),
  getHours: (date) => date.getUTCHours(), getMinutes: (date) => date.getUTCMinutes(), getSeconds: (date) => date.getUTCSeconds(), getMilliseconds: (date) => date.getUTCMilliseconds(),
  getUTCFullYear: (date) => date.getUTCFullYear(), getUTCMonth: (date) => date.getUTCMonth(), getUTCDate: (date) => date.getUTCDate(), getUTCDay: (date) => date.getUTCDay(),
  getUTCHours: (date) => date.getUTCHours(), getUTCMinutes: (date) => date.getUTCMinutes(), getUTCSeconds: (date) => date.getUTCSeconds(), getUTCMilliseconds: (date) => date.getUTCMilliseconds(),
}
const DATE_SETTERS = ["FullYear", "Month", "Date", "Hours", "Minutes", "Seconds", "Milliseconds"]
function dateMember(rt: Runtime, date: CDate, key: string): unknown {
  const getter = DATE_GETTERS[key]
  if (getter) return method(() => getter(new Date(date.ms)))
  const setter = /^set(?:UTC)?(\w+)$/.exec(key)?.[1]
  if (key === "setTime") return method(([value]) => { date.ms = clip(rt.number(value)); return date.ms })
  if (setter && DATE_SETTERS.includes(setter)) return method((args) => {
    const native = new Date(date.ms)
    ;(native as unknown as Record<string, (...values: number[]) => number>)[`setUTC${setter}`]!(...args.map((arg) => rt.number(arg)))
    date.ms = clip(native.getTime())
    return date.ms
  })
  const iso = () => { if (!Number.isFinite(date.ms)) fail("RangeError", "Invalid time value"); return new Date(date.ms).toISOString() }
  switch (key) {
    case "toISOString": return method(iso)
    case "toJSON": return method(() => Number.isFinite(date.ms) ? new Date(date.ms).toISOString() : null)
    case "toString": case "toUTCString": return method(() => Number.isFinite(date.ms) ? new Date(date.ms).toUTCString() : "Invalid Date")
    case "toDateString": return method(() => iso().slice(0, 10))
  }
  return undefined
}

function makeDate(rt: Runtime, args: unknown[]): CDate {
  if (args.length === 0) return new CDate(Date.now())
  if (args.length === 1) {
    const [value] = args
    if (value instanceof CDate) return new CDate(value.ms)
    return new CDate(clip(typeof value === "string" ? Date.parse(value) : rt.number(value)))
  }
  const [year, month, day = 1, hours = 0, minutes = 0, seconds = 0, millis = 0] = args.map((arg) => rt.number(arg))
  return new CDate(clip(Date.UTC(year!, month!, day, hours, minutes, seconds, millis)))
}

function regexpMember(re: CRegExp, rt: Runtime, key: string): unknown {
  const native = re.native
  switch (key) {
    case "source": return native.source
    case "flags": return native.flags
    case "global": return native.global
    case "ignoreCase": return native.ignoreCase
    case "multiline": return native.multiline
    case "sticky": return native.sticky
    case "unicode": return native.unicode
    case "dotAll": return native.dotAll
    case "lastIndex": return native.lastIndex
    case "test": return method(([input]) => { const text = rt.text(input); checkInput(re, text); return native.test(text) })
    case "exec": return method(([input]) => { const text = rt.text(input); checkInput(re, text); const match = native.exec(text); return match ? rt.budget(matchResult(match)) : null })
    case "toString": return method(() => `/${native.source}/${native.flags}`)
  }
  return undefined
}

function paramsMember(rt: Runtime, params: CParams, key: string): unknown {
  const inner = params.inner
  const text = (value: unknown) => rt.text(value)
  switch (key) {
    case "size": return inner.size
    case "get": return method(([name]) => inner.get(text(name)))
    case "getAll": return method(([name]) => inner.getAll(text(name)))
    case "has": return method(([name]) => inner.has(text(name)))
    case "set": return method(([name, value]) => { inner.set(text(name), text(value)) })
    case "append": return method(([name, value]) => { inner.append(text(name), text(value)) })
    case "delete": return method(([name]) => { inner.delete(text(name)) })
    case "sort": return method(() => { inner.sort() })
    case "toString": return method(() => inner.toString())
    case "keys": return method(() => [...inner.keys()])
    case "values": return method(() => [...inner.values()])
    case "entries": return method(() => [...inner].map(([k, v]) => [k, v]))
    case "forEach": return method(async ([callback], depth) => {
      if (!(callback instanceof Callable)) fail("InvalidDataValue", "forEach needs a function")
      for (const [k, v] of [...inner]) { await rt.tick(); await (callback as Callable).call([v, k, params], depth) }
    })
  }
  return undefined
}

function urlMember(rt: Runtime, url: CURL, key: string): unknown {
  switch (key) {
    case "href": case "origin": case "protocol": case "username": case "password": case "host": case "hostname": case "port": case "pathname": case "search": case "hash": return url.url[key]
    case "searchParams": return url.params
    case "toString": case "toJSON": return method(() => url.url.href)
  }
  return undefined
}

/** Property access on every non-plain value: arrays, strings, numbers, promises, generators and built-in wrappers. */
export function libraryMember(rt: Runtime, value: unknown, key: string): unknown {
  if (Array.isArray(value)) return arrayMember(rt, value, key)
  if (typeof value === "string") return stringMember(rt, value, key)
  if (typeof value === "number") return numberMember(rt, value, key)
  if (typeof value === "boolean") return key === "toString" ? method(() => String(value)) : undefined
  if (value instanceof Deferred) return promiseMember(rt, value, key)
  if (value instanceof Gen) return generatorMember(rt, value, key)
  if (value instanceof CMap) return mapMember(rt, value, key)
  if (value instanceof CSet) return setMember(rt, value, key)
  if (value instanceof CDate) return dateMember(rt, value, key)
  if (value instanceof CRegExp) return regexpMember(value, rt, key)
  if (value instanceof CParams) return paramsMember(rt, value, key)
  if (value instanceof CURL) return urlMember(rt, value, key)
  return undefined
}

function clone(rt: Runtime, value: unknown, depth: number, context: { visits: number }): unknown {
  if (++context.visits > 262_144) fail("ValueLimitExceeded", "Data traversal limit exceeded")
  if (depth > 32) fail("InvalidDataValue", "Data exceeds 32 levels")
  if (value === null || value === undefined || typeof value !== "object") { if (typeof value === "function") fail("InvalidDataValue", "Functions cannot be cloned"); return value }
  if (value instanceof CDate) return new CDate(value.ms)
  if (value instanceof CMap) { const copy = new CMap(); for (const [k, v] of value.inner) copy.inner.set(clone(rt, k, depth + 1, context), clone(rt, v, depth + 1, context)); return copy }
  if (value instanceof CSet) { const copy = new CSet(); for (const item of value.inner) copy.inner.add(clone(rt, item, depth + 1, context)); return copy }
  if (!isPlain(value)) return fail("InvalidDataValue", "Value cannot be cloned")
  if (Array.isArray(value)) return value.map((item) => clone(rt, item, depth + 1, context))
  if (isError(value)) return makeError(String(value.name), String(value.message))
  const copy = object()
  for (const [key, item] of Object.entries(value)) copy[rt.key(key)] = clone(rt, item, depth + 1, context)
  return copy
}

export function installGlobals(rt: Runtime, scope: Scope, search?: (query: string, limit?: number) => unknown) {
  const define = (name: string, value: unknown) => scope.declare(name, value, true)
  const namespace = (name: string, members: Record<string, unknown>) => define(name, Object.assign(object(), members))
  const text = (value: unknown) => rt.text(value)
  const parseInteger = method(([value, radix]) => parseInt(text(value), radix === undefined ? 10 : rt.number(radix)))
  const parseDecimal = method(([value]) => parseFloat(text(value)))
  const native = (label: string, call: Callable["call"], construct: Native["construct"], test: (value: unknown) => boolean, members: Record<string, unknown> = object()) => define(label, new Native(label, call, construct, test, members))
  const needsNew = (label: string) => async () => fail("UnsupportedSyntax", `${label} requires new`)

  define("undefined", undefined); define("NaN", NaN); define("Infinity", Infinity)
  const log = method((args) => {
    const line = args.map((item) => rt.inspect(item)).join(" ")
    const room = rt.limits.maxOutputBytes - rt.logBytes
    if (room <= 0 || rt.logs.length >= 256) rt.truncated = true
    else {
      const retained = utf8(line, room)
      rt.logs.push(retained); rt.logBytes += Buffer.byteLength(retained) + 4
      rt.truncated ||= retained !== line
    }
  })
  namespace("console", { log, info: log, warn: log, error: log, debug: log })
  namespace("JSON", {
    parse: method(([source]) => rt.budget(data(JSON.parse(text(source))))),
    stringify: method(([value, replacer, space]) => {
      if (replacer !== undefined && replacer !== null) fail("UnsupportedSyntax", "JSON replacers are not supported")
      return rt.budget(JSON.stringify(data(value, true), null, typeof space === "number" ? Math.min(10, space) : undefined))
    }),
  })
  const plain = (value: unknown) => isPlain(value) ? value : fail("InvalidDataValue", "Expected a plain object or array")
  native("Object", needsNew("Object"), undefined, (value) => isPlain(value) && !Array.isArray(value), Object.assign(object(), {
    keys: method(([value]) => rt.budget(Object.keys(plain(value)))),
    values: method(([value]) => rt.budget(Object.values(plain(value)))),
    entries: method(([value]) => rt.budget(Object.entries(plain(value)))),
    fromEntries: method(async ([value]) => {
      const result = object()
      for (const entry of await rt.collect(value)) {
        if (!Array.isArray(entry) || entry.length !== 2) fail("InvalidDataValue", "Expected [key, value]")
        result[rt.key(entry[0])] = entry[1]
      }
      return rt.budget(result)
    }),
    assign: method(([target, ...sources]) => {
      const receiver = plain(target) as Record<string, unknown>
      for (const source of sources) if (source !== null && source !== undefined) for (const [key, item] of Object.entries(plain(source))) receiver[rt.key(key)] = item
      return rt.budget(receiver)
    }),
    hasOwn: method(([value, key]) => Object.hasOwn(plain(value), rt.key(key))),
  }))
  native("Array", async ([length]) => length === undefined ? [] : fail("UnsupportedSyntax", "Use new Array(n) or Array.from"), ([...items]) => {
    if (items.length === 1 && typeof items[0] === "number") {
      const length = items[0]
      if (!Number.isInteger(length) || length < 0 || length > MAX_ITEMS) fail("RangeError", "Invalid array length")
      return new Array<unknown>(length).fill(undefined)
    }
    return rt.budget(items)
  }, Array.isArray, Object.assign(object(), {
    isArray: method(([value]) => Array.isArray(value)),
    of: method((items) => rt.budget(items)),
    from: method(async ([source, mapper], depth) => {
      let items: unknown[]
      if (source !== null && typeof source === "object" && !Array.isArray(source) && !isWrapper(source) && !(source instanceof Gen) && Object.hasOwn(source, "length")) {
        const length = (source as Record<string, unknown>).length
        if (typeof length !== "number" || !Number.isSafeInteger(length) || length < 0 || length > MAX_ITEMS) fail("ValueLimitExceeded", "Array length exceeds budget")
        items = Array.from({ length }, (_, index) => (source as Record<string, unknown>)[String(index)])
      } else items = await rt.collect(source)
      if (mapper !== undefined) {
        if (!(mapper instanceof Callable)) fail("InvalidDataValue", "Array.from needs a function")
        const mapped: unknown[] = []
        for (const [index, item] of items.entries()) { await rt.tick(); mapped.push(await (mapper as Callable).call([item, index], depth)) }
        items = mapped
      }
      return rt.budget(items)
    }),
  }))
  native("Number", async ([value]) => rt.number(value), undefined, (value) => typeof value === "number", Object.assign(object(), {
    isFinite: method(([value]) => Number.isFinite(value)), isInteger: method(([value]) => Number.isInteger(value)), isNaN: method(([value]) => Number.isNaN(value)), isSafeInteger: method(([value]) => Number.isSafeInteger(value)),
    parseInt: parseInteger, parseFloat: parseDecimal,
    MAX_SAFE_INTEGER: Number.MAX_SAFE_INTEGER, MIN_SAFE_INTEGER: Number.MIN_SAFE_INTEGER, EPSILON: Number.EPSILON, MAX_VALUE: Number.MAX_VALUE, MIN_VALUE: Number.MIN_VALUE,
    POSITIVE_INFINITY: Infinity, NEGATIVE_INFINITY: -Infinity, NaN,
  }))
  native("String", async (args) => args.length ? text(args[0]) : "", undefined, (value) => typeof value === "string", Object.assign(object(), {
    fromCharCode: method((codes) => String.fromCharCode(...codes.map((code) => rt.number(code)))),
    fromCodePoint: method((codes) => { try { return String.fromCodePoint(...codes.map((code) => rt.number(code))) } catch { return fail("RangeError", "Invalid code point") } }),
  }))
  native("Boolean", async ([value]) => Boolean(value), undefined, (value) => typeof value === "boolean")
  define("parseInt", parseInteger); define("parseFloat", parseDecimal)
  define("isNaN", method(([value]) => Number.isNaN(rt.number(value)))); define("isFinite", method(([value]) => Number.isFinite(rt.number(value))))
  namespace("Math", {
    ...Object.fromEntries(["abs", "ceil", "floor", "round", "trunc", "sqrt", "cbrt", "pow", "min", "max", "sign", "log", "log2", "log10", "log1p", "exp", "expm1", "sin", "cos", "tan", "asin", "acos", "atan", "atan2", "sinh", "cosh", "tanh", "hypot", "fround", "clz32", "random"].map((name) => [name, method((args) => (Math[name as keyof Math] as (...values: number[]) => number)(...args.map((arg) => rt.number(arg))))])),
    PI: Math.PI, E: Math.E, LN2: Math.LN2, LN10: Math.LN10, SQRT2: Math.SQRT2,
  })
  const uri = (convert: (value: string) => string) => method(([value]) => { try { return rt.budget(convert(text(value))) } catch { return fail("InvalidDataValue", "Malformed URI sequence") } })
  define("encodeURIComponent", uri(encodeURIComponent)); define("decodeURIComponent", uri(decodeURIComponent)); define("encodeURI", uri(encodeURI)); define("decodeURI", uri(decodeURI))
  define("structuredClone", method(([value]) => rt.budget(clone(rt, value, 0, { visits: 0 }))))

  for (const name of ["Error", "TypeError", "RangeError", "SyntaxError", "ReferenceError", "EvalError", "URIError"]) {
    const make = ([message]: unknown[]) => makeError(name, message === undefined ? "" : text(message))
    native(name, async (args) => make(args), (args) => make(args), (value) => isError(value) && (name === "Error" || value.name === name))
  }

  const reason = (error: unknown) => rt.caught(error)
  const items = async (iterable: unknown) => (await rt.collect(iterable)).map((item) => rt.settle(item))
  native("Promise", needsNew("Promise"), (args, depth) => {
    const [executor] = args
    if (!(executor instanceof Callable)) return fail("InvalidDataValue", "Promise needs an executor function")
    let resolve!: (value: unknown) => void, reject!: (error: unknown) => void
    const promise = new Promise<unknown>((ok, no) => { resolve = ok; reject = no })
    const settleWith = new Callable(async ([value]) => { resolve(rt.settle(value)) })
    const rejectWith = new Callable(async ([error]) => { reject(new Thrown(error, describe(error))) })
    void executor.call([settleWith, rejectWith], depth).catch(reject)
    return rt.tracked(promise)
  }, (value) => value instanceof Deferred, Object.assign(object(), {
    all: method(([iterable]) => rt.tracked((async () => Promise.all(await items(iterable)))())),
    allSettled: method(([iterable]) => rt.tracked((async () => Promise.all((await items(iterable)).map(async (entry) => {
      try { return Object.assign(object(), { status: "fulfilled", value: await entry }) } catch (error) { return Object.assign(object(), { status: "rejected", reason: reason(error) }) }
    })))())),
    race: method(([iterable]) => rt.tracked((async () => { const list = await items(iterable); if (!list.length) fail("RangeError", "Promise.race needs at least one promise"); return Promise.race(list) })())),
    any: method(([iterable]) => rt.tracked((async () => {
      const list = await items(iterable)
      try { return await Promise.any(list) } catch { throw new Thrown(makeError("AggregateError", "All promises were rejected"), "AggregateError: All promises were rejected") }
    })())),
    resolve: method(([value]) => rt.tracked(rt.settle(value))),
    reject: method(([error]) => rt.tracked(Promise.reject(new Thrown(error, describe(error))))),
  }))

  native("Map", needsNew("Map"), async ([iterable]) => {
    const map = new CMap()
    if (iterable !== undefined && iterable !== null) for (const entry of await rt.collect(iterable)) {
      if (!Array.isArray(entry) || entry.length < 2) fail("InvalidDataValue", "Map entries must be [key, value] pairs")
      map.inner.set(entry[0], entry[1])
    }
    rt.budget(map)
    return map
  }, (value) => value instanceof CMap)
  native("Set", needsNew("Set"), async ([iterable]) => {
    const set = new CSet()
    if (iterable !== undefined && iterable !== null) for (const item of await rt.collect(iterable)) set.inner.add(item)
    rt.budget(set)
    return set
  }, (value) => value instanceof CSet)
  native("Date", async () => new Date().toUTCString(), (args) => makeDate(rt, args), (value) => value instanceof CDate, Object.assign(object(), {
    now: method(() => Date.now()),
    parse: method(([value]) => clip(Date.parse(text(value)))),
    UTC: method((args) => clip(Date.UTC(...(args.map((arg) => rt.number(arg)) as [number, number])))),
  }))
  native("RegExp", needsNew("RegExp"), ([pattern, flags]) => pattern instanceof CRegExp ? compileRegExp(pattern.native.source, flags === undefined ? pattern.native.flags : text(flags)) : compileRegExp(text(pattern ?? "(?:)"), flags === undefined ? "" : text(flags)), (value) => value instanceof CRegExp)
  const parseUrl = (input: unknown, base?: unknown) => {
    try {
      const url = base === undefined ? new URL(text(input)) : new URL(text(input), text(base))
      return new CURL(url, new CParams(url.searchParams))
    } catch { return fail("InvalidDataValue", "Invalid URL") }
  }
  native("URL", needsNew("URL"), ([input, base]) => parseUrl(input, base), (value) => value instanceof CURL, Object.assign(object(), {
    canParse: method(([input, base]) => { try { parseUrl(input, base); return true } catch { return false } }),
  }))
  native("URLSearchParams", needsNew("URLSearchParams"), async ([init]) => {
    const params = new URLSearchParams()
    if (typeof init === "string") return new CParams(new URLSearchParams(init))
    if (init instanceof CParams) return new CParams(new URLSearchParams(init.inner))
    if (isPlain(init) && !Array.isArray(init)) for (const [key, value] of Object.entries(init)) params.append(key, text(value))
    else if (init !== undefined && init !== null) for (const pair of await rt.collect(init)) {
      if (!Array.isArray(pair) || pair.length !== 2) fail("InvalidDataValue", "URLSearchParams entries must be [name, value] pairs")
      params.append(text(pair[0]), text(pair[1]))
    }
    return new CParams(params)
  }, (value) => value instanceof CParams)

  if (search) define("search", method(([input]) => {
    const args = data(input) as { query?: unknown; limit?: unknown }
    if (!args || typeof args !== "object" || Array.isArray(args) || Object.keys(args).some((key) => key !== "query" && key !== "limit") || args.query !== undefined && (typeof args.query !== "string" || args.query.length > 500) || args.limit !== undefined && (typeof args.limit !== "number" || !Number.isInteger(args.limit) || args.limit < 1 || args.limit > 8)) throw new CodeError("InvalidToolInput", "search takes {query?: string (at most 500 chars), limit?: 1..8}")
    return rt.budget(search(typeof args.query === "string" ? args.query : "", typeof args.limit === "number" ? args.limit : undefined))
  }))
}
