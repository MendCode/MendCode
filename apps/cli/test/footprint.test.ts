import { expect, test } from "bun:test"
import path from "node:path"
import { LAZY_MODULE_FILES } from "../src/ui/lazy-pages"

const cli = path.join(import.meta.dir, "..")

/** Runs a script in a fresh process (this test file's own imports must not count) and returns its JSON output. */
function probe(script: string) {
  const result = Bun.spawnSync(["bun", "-e", script], { cwd: cli, stdout: "pipe", stderr: "pipe" })
  expect(result.stderr.toString()).toBe("")
  expect(result.exitCode).toBe(0)
  return JSON.parse(result.stdout.toString().trim())
}

/**
 * P5 budget guard: a terminal client must not load zod or the protocol schemas (they cost ~20–35 MB of
 * RSS per terminal). The daemon validates; clients use "@mendcode/protocol/wire".
 */
test("the terminal client's module graph stays free of zod and the protocol schemas", () => {
  const script = `await import("./src/ui/app"); await import("@mendcode/client"); await import("./src/ui/screen");
const keys = Object.keys(require.cache);
console.log(JSON.stringify({ zod: keys.filter((k) => k.includes("/zod/")).length, schemas: keys.filter((k) => /protocol\\/src\\/(commands|events|queries|frames)\\.ts$/.test(k)).length }))`
  expect(probe(script)).toEqual({ zod: 0, schemas: 0 })
})

test("the real CLI entry in help mode never loads daemon modules, zod or protocol schemas", () => {
  const script = `const { mkdtempSync, rmSync } = await import("node:fs");
const dir = mkdtempSync("/tmp/mendcode-footprint-");
const write = process.stdout.write.bind(process.stdout);
const exit = process.exit;
const stopped = new Error("help exited");
process.argv = [process.execPath, "./src/entry.ts", "--dir", dir, "help"];
process.stdout.write = () => true;
process.exit = (code) => { if (code !== 0) throw new Error("unexpected exit " + code); throw stopped };
try { await import("./src/entry") } catch (error) { if (error !== stopped) throw error }
finally { process.stdout.write = write; process.exit = exit; rmSync(dir, { recursive: true, force: true }) }
const keys = Object.keys(require.cache);
console.log(JSON.stringify({ daemon: keys.filter((k) => k.includes("/packages/daemon/")).length, zod: keys.filter((k) => k.includes("/zod/")).length, schemas: keys.filter((k) => /protocol\\/src\\/(commands|events|queries|frames)\\.ts$/.test(k)).length }))`
  expect(probe(script)).toEqual({ daemon: 0, zod: 0, schemas: 0 })
})

/**
 * Page views load on first use (lazy-pages.ts): the startup graph must not contain them, and opening one
 * must load it (and only it, plus what it imports).
 */
test("page views are not in the startup module graph and load on first use", () => {
  const files = JSON.stringify([...LAZY_MODULE_FILES])
  const script = `const files = ${files};
const has = (name) => Object.keys(require.cache).some((k) => k.endsWith("/view/" + name + ".ts"));
await import("./src/ui/app");
const atStart = files.filter(has);
const pages = await import("./src/ui/lazy-pages");
await pages.preload("usage");
const afterUsage = files.filter(has);
await pages.preload("storage");
console.log(JSON.stringify({ atStart, afterUsage, afterStorage: files.filter(has), chat: ["transcript", "markdown", "editor", "footer"].every(has) }))`
  const graph = probe(script)
  expect(graph.atStart).toEqual([])
  expect(graph.afterUsage).toEqual(["usage-page"])
  expect(graph.afterStorage).toEqual(["usage-page", "storage-page"])
  expect(graph.chat).toBe(true)
})

/** /connect and /providers handle API keys and provider lists: their pages load on use and, like the rest of the client, never pull in zod. */
test("the provider pages load on use, alone, and without zod or the protocol schemas", () => {
  const script = `const has = (name) => Object.keys(require.cache).some((k) => k.endsWith("/view/" + name + ".ts"));
await import("./src/ui/app");
const atStart = { connect: has("connect-page"), providers: has("providers-page") };
const pages = await import("./src/ui/lazy-pages");
await pages.preload("connect");
const afterConnect = { connect: has("connect-page"), providers: has("providers-page") };
await pages.preload("providers");
const keys = Object.keys(require.cache);
console.log(JSON.stringify({ atStart, afterConnect, afterProviders: { connect: has("connect-page"), providers: has("providers-page") }, zod: keys.filter((k) => k.includes("/zod/")).length, schemas: keys.filter((k) => /protocol\\/src\\/(commands|events|queries|frames|providers)\\.ts$/.test(k)).length }))`
  expect(probe(script)).toEqual({
    atStart: { connect: false, providers: false },
    afterConnect: { connect: true, providers: false },
    afterProviders: { connect: true, providers: true },
    zod: 0,
    schemas: 0,
  })
})

test("every lazily loaded page module exists and is only imported through lazy-pages", async () => {
  const source = await Bun.file(path.join(cli, "src/ui/lazy-pages.ts")).text()
  for (const name of LAZY_MODULE_FILES) expect(source).toContain(`import("../view/${name}")`)
  const app = await Bun.file(path.join(cli, "src/ui/app.ts")).text()
  for (const name of LAZY_MODULE_FILES) expect(app).not.toMatch(new RegExp(`^import (?!type)[^\\n]*"\\.\\./view/${name}"`, "m"))
})

/** The external editor's launcher is the one place that runs a program: it is not in the startup graph and loads on first use, without zod. */
test("the external-editor launcher loads on use only", () => {
  const script = `const has = () => Object.keys(require.cache).some((k) => k.includes("/editor-launch/"));
await import("./src/ui/app");
const atStart = has();
const launcher = await (await import("./src/ui/external-editor")).loadEditorLauncher();
const keys = Object.keys(require.cache);
console.log(JSON.stringify({ atStart, afterLoad: has(), isFunction: typeof launcher === "function", zod: keys.filter((k) => k.includes("/zod/")).length }))`
  expect(probe(script)).toEqual({ atStart: false, afterLoad: true, isFunction: true, zod: 0 })
})

/** /permissions and /diagram load on use, one at a time, without zod; the diagram renderer itself stays lazy until a diagram needs it. */
test("the permissions and diagram pages load on use, alone, without zod or the mermaid renderer", () => {
  const script = `const has = (name) => Object.keys(require.cache).some((k) => k.endsWith("/view/" + name + ".ts"));
await import("./src/ui/app");
const state = () => ({ permissions: has("permissions-page"), viewer: has("mermaid-viewer"), renderer: has("mermaid") });
const atStart = state();
const pages = await import("./src/ui/lazy-pages");
await pages.preload("permissions");
const afterPermissions = state();
await pages.preload("diagram");
const keys = Object.keys(require.cache);
console.log(JSON.stringify({ atStart, afterPermissions, afterDiagram: state(), zod: keys.filter((k) => k.includes("/zod/")).length }))`
  expect(probe(script)).toEqual({
    atStart: { permissions: false, viewer: false, renderer: false },
    afterPermissions: { permissions: true, viewer: false, renderer: false },
    afterDiagram: { permissions: true, viewer: true, renderer: false },
    zod: 0,
  })
})

/** The file viewer (controller, renderer, highlighter use) loads when the first file opens; startup holds only the cheap checks and stays free of zod. */
test("the file viewer stays out of the startup graph and loads with the first file", () => {
  const script = `const has = (name) => Object.keys(require.cache).some((k) => k.endsWith(name));
await import("./src/ui/app");
const state = () => ({ facade: has("/ui/app/file-open.ts"), slot: has("/ui/app/file-slot.ts"), controller: has("/ui/app/file-viewer.ts"), renderer: has("/view/file-viewer.ts") });
const atStart = state();
await import("./src/ui/app/file-viewer");
const pages = await import("./src/ui/lazy-pages");
await pages.preload("fileViewer");
const keys = Object.keys(require.cache);
console.log(JSON.stringify({ atStart, afterLoad: state(), zod: keys.filter((k) => k.includes("/zod/")).length }))`
  expect(probe(script)).toEqual({
    atStart: { facade: true, slot: true, controller: false, renderer: false },
    afterLoad: { facade: true, slot: true, controller: true, renderer: true },
    zod: 0,
  })
})

/** Package activation (the overlay of an enabled package) is parsed only when an enabled package declares one, and never pulls in zod or the protocol schemas. */
test("the activation code stays out of the startup graph and loads without zod", () => {
  const script = `const has = () => Object.keys(require.cache).some((k) => k.includes("/extensions/activation"));
await import("./src/ui/app");
const atStart = has();
const loaded = await import("./src/extensions/activation");
const keys = Object.keys(require.cache);
console.log(JSON.stringify({ atStart, afterLoad: has(), isFunction: typeof loaded.loadActivation === "function", zod: keys.filter((k) => k.includes("/zod/")).length, schemas: keys.filter((k) => /protocol\\/src\\/(commands|events|queries|frames)\\.ts$/.test(k)).length }))`
  expect(probe(script)).toEqual({ atStart: false, afterLoad: true, isFunction: true, zod: 0, schemas: 0 })
})

/** The tutorial's practice chat is a whole second app plus a scripted engine: none of it loads until /tutorial opens, and it never pulls in zod or the protocol schemas. */
test("the tutorial's practice chat and engine load on first use only, without zod or the protocol schemas", () => {
  const script = `const has = (name) => Object.keys(require.cache).some((k) => k.endsWith(name));
await import("./src/ui/app");
const names = ["/tutorial/tour.ts", "/tutorial/sandbox.ts", "/tutorial/engine.ts", "/tutorial/lessons.ts", "/view/tutorial-page.ts"];
const atStart = names.filter(has);
const pages = await import("./src/ui/lazy-pages");
await pages.preload("tutorial");
const keys = Object.keys(require.cache);
console.log(JSON.stringify({ atStart, afterTutorial: names.filter(has), zod: keys.filter((k) => k.includes("/zod/")).length, schemas: keys.filter((k) => /protocol\\/src\\/(commands|events|queries|frames)\\.ts$/.test(k)).length }))`
  const graph = probe(script)
  expect(graph.atStart).toEqual([])
  expect(graph.afterTutorial.sort()).toEqual(["/tutorial/engine.ts", "/tutorial/lessons.ts", "/tutorial/sandbox.ts", "/tutorial/tour.ts", "/view/tutorial-page.ts"])
  expect(graph.zod).toBe(0)
  expect(graph.schemas).toBe(0)
})

/** The reference cards (`mendcode docs`) are text in the binary: the terminal's startup graph never loads them, and running `docs` never loads the daemon, zod or the protocol schemas. The one daemon file it reads is `doc-search.ts`, which has no imports (the search shared with the card generator). */
test("the reference cards load only when docs runs, without the daemon, zod or the protocol schemas", () => {
  const script = `const has = (name) => Object.keys(require.cache).some((k) => k.endsWith(name));
const names = ["/docs-run.ts", "/docs-live.ts", "/cards.generated.json"];
await import("./src/ui/app");
const atStart = names.filter(has);
const { mkdtempSync, rmSync } = await import("node:fs");
const dir = mkdtempSync("/tmp/mendcode-footprint-");
const run = await import("./src/docs-run");
let out = "";
const code = await run.runDocsCommand({ help: false, words: ["theme"] }, { dataDir: dir, cwd: dir, out: { write: (text) => void (out += text) }, err: { write: () => {} }, live: async () => ({ settings: undefined, prompt: undefined }) });
rmSync(dir, { recursive: true, force: true });
const keys = Object.keys(require.cache);
console.log(JSON.stringify({ atStart, code, printed: out.startsWith("mendcode docs theme"), loaded: names.filter(has), daemon: keys.filter((k) => k.includes("/packages/daemon/src/") && !k.endsWith("/doc-search.ts")).length, zod: keys.filter((k) => k.includes("/zod/")).length, schemas: keys.filter((k) => /protocol\\/src\\/(commands|events|queries|frames)\\.ts$/.test(k)).length }))`
  expect(probe(script)).toEqual({ atStart: [], code: 0, printed: true, loaded: ["/docs-run.ts", "/docs-live.ts", "/cards.generated.json"], daemon: 0, zod: 0, schemas: 0 })
})

test("the real CLI entry prints a card with the data directory given, without a daemon, zod or the protocol schemas", () => {
  const script = `const { mkdtempSync, rmSync } = await import("node:fs");
const dir = mkdtempSync("/tmp/mendcode-footprint-");
const write = process.stdout.write.bind(process.stdout);
let out = "";
const exit = process.exit;
const stopped = new Error("docs exited");
process.argv = [process.execPath, "./src/entry.ts", "--dir", dir, "docs", "footer"];
process.stdout.write = (text) => { out += text; return true };
let code = -1;
process.exit = (value) => { code = value; throw stopped };
try { await import("./src/entry") } catch (error) { if (error !== stopped) throw error }
finally { process.stdout.write = write; process.exit = exit; rmSync(dir, { recursive: true, force: true }) }
const keys = Object.keys(require.cache);
console.log(JSON.stringify({ code, printed: out.startsWith("mendcode docs footer"), daemon: keys.filter((k) => k.includes("/packages/daemon/src/") && !k.endsWith("/doc-search.ts")).length, zod: keys.filter((k) => k.includes("/zod/")).length, schemas: keys.filter((k) => /protocol\\/src\\/(commands|events|queries|frames)\\.ts$/.test(k)).length }))`
  expect(probe(script)).toEqual({ code: 0, printed: true, daemon: 0, zod: 0, schemas: 0 })
})
