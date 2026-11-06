import { expect, test } from "bun:test"
import path from "node:path"

// Import modules, never the CLI entry: no daemon, terminal, login or user data is opened.
function probe(script: string) {
  const result = Bun.spawnSync([process.execPath, "-e", script], {
    cwd: path.join(import.meta.dir, "../../.."), stdout: "pipe", stderr: "pipe",
  })
  expect(result.stderr.toString()).toBe("")
  expect(result.exitCode).toBe(0)
  return JSON.parse(result.stdout.toString())
}

test("command-only pages stay absent until their first preload, including concurrent opens", () => {
  const result = probe(`
    await import("./apps/cli/src/ui/app");
    await import("./apps/cli/src/remote");
    const helpText = Object.keys(require.cache).some(key => key.endsWith("/help-text.ts"));
    const names = ["help-page", "model-page", "environment-page", "tasks-page", "usage-tabs", "ai-config-page"];
    const loaded = () => names.filter(name => Object.keys(require.cache).some(key => key.endsWith("/view/" + name + ".ts")));
    const before = loaded();
    const pages = await import("./apps/cli/src/ui/lazy-pages");
    await Promise.all([pages.preload("help"), pages.preload("help")]);
    const help = loaded();
    await pages.preload("modelPicker");
    const model = loaded();
    const state = pages.createModelPageState();
    await pages.preload("env");
    const env = loaded();
    const environment = pages.createEnvironmentPageState();
    await pages.preload("tasks");
    const tasks = loaded();
    await pages.preload("usage");
    console.log(JSON.stringify({ helpText, before, help, model, state, env, scope: environment.scope, tasks, usage: loaded() }));
  `)
  expect(result).toEqual({
    helpText: false, before: [], help: ["help-page"], model: ["help-page", "model-page"], state: { row: 0 },
    env: ["help-page", "model-page", "environment-page"], scope: "project",
    tasks: ["help-page", "model-page", "environment-page", "tasks-page"],
    usage: ["help-page", "model-page", "environment-page", "tasks-page", "usage-tabs"],
  })
})

test("first help open and direct model search return load the renderer before drawing", () => {
  const result = probe(String.raw`
    const { appHarness } = await import("./apps/cli/test/session-ui-harness");
    const h = appHarness({ mode: "full", directory: "/project" });
    h.app.applySettings({ onboarded: true, reducedMotion: true });
    h.app.render();
    const before = Object.keys(require.cache).filter(key => /view\/(help-page|model-page|environment-page|tasks-page)\.ts$/.test(key));
    const prompt = h.text().join("\n").includes("Ask anything");
    await h.type("/help\r");
    const help = h.app.page;
    const helpDrawn = h.text().join("\n").includes("Keys");
    await h.type("\x1b");
    await h.type("/model search\r");
    const picker = h.app.page;
    await h.type("\x1b");
    const returned = h.app.page;
    const modelDrawn = h.text().join("\n").includes("Model");
    console.log(JSON.stringify({ before, prompt, help, helpDrawn, picker, returned, modelDrawn }));
  `)
  expect(result).toEqual({ before: [], prompt: true, help: "help", helpDrawn: true, picker: "model-picker", returned: "model", modelDrawn: true })
})
