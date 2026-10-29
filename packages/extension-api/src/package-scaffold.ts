import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import path from "node:path"
import { EXTENSION_API_VERSION } from "./index"
import { viewStarter } from "./view-starter"
import { workflowStarter } from "./workflow-starter"

/**
 * `mendcode package new <name>`: a complete, commented package that already loads and passes `package check`. Every file is a
 * starting point for one thing a package can change (docs/packages.md); delete what you do not need. It reuses the view and
 * workflow starters, so there is one source of those files.
 */

export const PACKAGE_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/
const TITLE = (name: string) => name.replace(/[-_.]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase())
const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`

export type PackageScaffold = { dir: string; files: string[] }
export type ScaffoldPackageResult = ({ ok: true } & PackageScaffold) | { ok: false; message: string }

/** The files of a new package, relative to its folder. Pure: nothing is written here. */
export function packageFiles(name: string, program = "mendcode"): Record<string, string> {
  const title = TITLE(name)
  const manifest = {
    name,
    version: "0.1.0",
    description: `${title}: a look for MendCode`,
    license: "MIT",
    // The MendCode versions and extension API this was tried with; enable refuses outside them.
    compatibility: { mendcode: ">=0.0.1", api: EXTENSION_API_VERSION },
    extensions: true,
    capabilities: [],
    // Applied as an overlay while the package is enabled; disabling or removing it puts everything back. Your own choices
    // made afterwards stay yours. Forbidden here: permissions, approvals, providers, credentials, trust, budgets.
    activate: {
      theme: name,
      tuiProfile: {
        logoText: name.toUpperCase().slice(0, 24),
        slashMenu: "groups",
        slashCommands: [{ name: `${name}-hello`, pinned: true }],
        sidebarWidgets: [
          { type: "text", title: title.slice(0, 40), options: { text: `Edit this card in ${name}/mendcode-package.json (activate.tuiProfile.sidebarWidgets).` } },
          { type: "context", options: { priority: "high" } },
          { type: "todos", options: {} },
        ],
        rightSidebar: true,
      },
      keybindings: "keybindings.json",
      views: { "message.assistant": "message-assistant", "tool.card": "tool-card" },
    },
  }
  const theme = {
    label: title,
    background: "#14110f",
    colors: { primary: "#e8a33d", text: "#f2e9dc", body: "#d9cdbb", muted: "#8c7f6f", border: "#4a4137", heading: "#e8a33d", code: "#9fd3a8", link: "#7db4d6", success: "#8fc98a", warning: "#e8a33d", error: "#e0645c" },
  }
  return {
    "mendcode-package.json": json(manifest),
    [`themes/${name}.json`]: json(theme),
    "extensions/message-assistant.ts": viewStarter("message.assistant", `${name}-message-assistant`),
    "extensions/tool-card.ts": viewStarter("tool.card", `${name}-tool-card`),
    [`commands/${name}-hello.md`]: `---\ndescription: Say hello from ${name}\nargument-hint: "[topic]"\n---\nGreet the user in one friendly sentence, then ask what they want to work on. Arguments: $ARGUMENTS\n`,
    [`skills/${name}-tips/SKILL.md`]: `---\nname: ${name}-tips\ndescription: Short working tips from the ${name} package. Use when the user asks how this setup is meant to be used.\n---\n# ${title} tips\n\n- Keep answers short and concrete.\n- Show the command before running anything slow.\n`,
    "keybindings.json": json({ "alt+g": "sidebar.toggle", "alt+m": "messages.open" }),
    [`workflows/${name}-review.js`]: workflowStarter(`${name}-review`),
    // Not loaded: copy it to hooks.json to switch it on. A hook runs a shell command, so users are asked before it does.
    "docs/hooks.example.json": json({ hooks: { PostToolUse: [{ matcher: "write|edit", hooks: [{ type: "command", command: "echo a file was edited", timeout: 5 }] }] } }),
    "README.md": `# ${title}

A MendCode package, made with \`${program} package new ${name}\`.

## Try it

\`\`\`sh
${program} package check .          # schema, compat, capabilities, activation
${program} package install .        # installs and enables it (asks before it replaces another look)
\`\`\`

Then \`/packages\` shows what it overrides, with \`d\` to turn it off and \`k\` to keep one of your own settings.
Disabling or removing the package puts everything back; nothing was written into your settings.

## What is in here

| File | What it changes |
|---|---|
| \`mendcode-package.json\` | name, version, \`compatibility\`, and \`activate\`: the look it brings as one unit |
| \`themes/${name}.json\` | the color theme (\`activate.theme\`) |
| \`extensions/message-assistant.ts\`, \`extensions/tool-card.ts\` | a view for assistant messages and one for tool cards (\`activate.views\`: loaded only while the package owns the look) |
| \`activate.tuiProfile\` | home title, slash menu layout and the right panel's cards |
| \`commands/${name}-hello.md\` | a slash command: \`/${name}-hello\` |
| \`skills/${name}-tips/SKILL.md\` | a skill the model can load |
| \`keybindings.json\` | keys, in the format of \`keybindings.json\` (\`activate.keybindings\`) |
| \`workflows/${name}-review.js\` | a script workflow: \`/workflows run ${name}-review\` |
| \`docs/hooks.example.json\` | a hook example, off until you copy it to \`hooks.json\` |

## Share it

Put the folder in a git repository, or \`${program} packages create\` from your own setup. Anyone installs it with \`${program} package install github:you/${name}\`.
Extension and view code runs with the user's permissions: say what yours does here.
`,
  }
}

export function scaffoldPackage(options: { name: string; parent: string; program?: string }): ScaffoldPackageResult {
  if (!PACKAGE_NAME_PATTERN.test(options.name)) return { ok: false, message: `package name must use lowercase letters, digits, . _ - (max 64), got "${options.name}"` }
  const dir = path.resolve(options.parent, options.name)
  if (existsSync(dir)) return { ok: false, message: `${dir} exists; pick another name or --dir` }
  const files = packageFiles(options.name, options.program)
  for (const [relative, text] of Object.entries(files)) {
    const file = path.join(dir, relative)
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, text)
  }
  return { ok: true, dir, files: Object.keys(files) }
}
