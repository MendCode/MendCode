"use strict"
// MendCode for VS Code, Cursor, VSCodium and Windsurf. It runs the terminal client in an editor terminal, types
// `@file` mentions into its prompt, and (opt-in) publishes the active selection for `/ide on vscode`.
// No network access, no child processes of its own: the terminal is VS Code's, the command is the user's setting.
const vscode = require("vscode")
const path = require("node:path")
const bridge = require("./lib/bridge")

const TERMINAL_NAME = "MendCode"
const HEARTBEAT_MS = 30_000
const DEBOUNCE_MS = 150
const NEW_TERMINAL_DELAY_MS = 1_500
const MAX_DIAGNOSTICS = 20

function activate(context) {
  const settings = () => vscode.workspace.getConfiguration("mendcode")
  const output = vscode.window.createOutputChannel("MendCode")
  const published = new Set()
  let lastEditor
  let debounce
  let sessions = 0

  const isFileEditor = (editor) => Boolean(editor) && editor.document.uri.scheme === "file" && !editor.document.isUntitled
  const folders = () => (vscode.workspace.workspaceFolders || []).filter((folder) => folder.uri.scheme === "file")

  function currentEditor() {
    if (isFileEditor(vscode.window.activeTextEditor)) lastEditor = vscode.window.activeTextEditor
    // The terminal has focus when MendCode runs, so the last text editor keeps standing in for the active one.
    else if (!lastEditor || !vscode.window.visibleTextEditors.includes(lastEditor)) lastEditor = vscode.window.visibleTextEditors.find(isFileEditor)
    return lastEditor
  }

  function folderOf(uri) {
    return vscode.workspace.getWorkspaceFolder(uri) || folders()[0]
  }

  function dataDir() {
    return settings().get("dataDir") || undefined
  }

  function cleanup() {
    for (const file of published) bridge.removeRecord(file)
    published.clear()
  }

  function publish() {
    if (!settings().get("shareContext")) { cleanup(); return }
    const editor = currentEditor()
    const now = Date.now()
    for (const folder of folders()) {
      const workspace = folder.uri.fsPath
      const file = bridge.bridgeFile(dataDir(), workspace)
      const inside = editor && vscode.workspace.getWorkspaceFolder(editor.document.uri)?.uri.fsPath === workspace
      const ranges = inside ? editor.selections.map((selection) => ({
        text: selection.isEmpty ? "" : editor.document.getText(selection), start: selection.start, end: selection.end,
      })) : []
      try {
        bridge.writeRecord(file, bridge.buildRecord({ app: vscode.env.appName, workspace, filePath: inside ? editor.document.uri.fsPath : undefined, ranges, now }))
        published.add(file)
      } catch (error) { output.appendLine(`publish failed: ${error && error.code ? error.code : "error"}`) }
    }
  }

  function schedule() {
    clearTimeout(debounce)
    debounce = setTimeout(publish, DEBOUNCE_MS)
  }

  function terminalFor(folder, { fresh = false } = {}) {
    let terminal = fresh ? undefined : vscode.window.terminals.find((candidate) => candidate.name.startsWith(TERMINAL_NAME) && candidate.exitStatus === undefined)
    let created = false
    if (!terminal) {
      const args = [...(settings().get("args") || [])]
      if (dataDir()) args.unshift("--dir", dataDir())
      terminal = vscode.window.createTerminal({
        name: fresh ? `${TERMINAL_NAME} ${++sessions + 1}` : TERMINAL_NAME,
        cwd: folder ? folder.uri.fsPath : undefined,
        shellPath: settings().get("command") || "mendcode",
        shellArgs: args,
        location: settings().get("terminalLocation") === "editor" ? vscode.TerminalLocation.Editor : vscode.TerminalLocation.Panel,
      })
      created = true
    }
    terminal.show(false)
    return { terminal, created }
  }

  /** Types into the prompt without submitting: the user reads and edits it, then presses Enter. */
  function type(folder, text) {
    const { terminal, created } = terminalFor(folder)
    if (created) setTimeout(() => terminal.sendText(text, false), NEW_TERMINAL_DELAY_MS)
    else terminal.sendText(text, false)
  }

  function relativeTo(folder, uri) {
    return folder ? path.relative(folder.uri.fsPath, uri.fsPath) : uri.fsPath
  }

  function addSelection() {
    const editor = currentEditor()
    if (!editor) { vscode.window.showWarningMessage("MendCode: open a file first"); return }
    const folder = folderOf(editor.document.uri)
    const selection = editor.selection
    let range
    if (!selection.isEmpty) {
      // A selection ending at column 0 of a line does not include that line.
      const end = selection.end.character === 0 && selection.end.line > selection.start.line ? selection.end.line - 1 : selection.end.line
      range = { start: selection.start.line + 1, end: end + 1 }
    }
    type(folder, `${bridge.mention(relativeTo(folder, editor.document.uri), range)} `)
  }

  function addFile(uri) {
    const editor = currentEditor()
    const target = uri && uri.scheme === "file" ? uri : editor && editor.document.uri
    if (!target) { vscode.window.showWarningMessage("MendCode: no file selected"); return }
    const folder = folderOf(target)
    type(folder, `${bridge.mention(relativeTo(folder, target))} `)
  }

  function fixProblems() {
    const editor = currentEditor()
    if (!editor) { vscode.window.showWarningMessage("MendCode: open a file first"); return }
    const uri = editor.document.uri
    const problems = vscode.languages.getDiagnostics(uri)
      .filter((item) => item.severity === vscode.DiagnosticSeverity.Error || item.severity === vscode.DiagnosticSeverity.Warning)
      .slice(0, MAX_DIAGNOSTICS)
    if (!problems.length) { vscode.window.showInformationMessage("MendCode: no problems in this file"); return }
    const folder = folderOf(uri)
    const list = problems.map((item) => `line ${item.range.start.line + 1}: ${String(item.message).replace(/\s+/g, " ").slice(0, 200)}`).join("; ")
    type(folder, `Fix these problems in ${bridge.mention(relativeTo(folder, uri))}: ${list}`)
  }

  async function connect() {
    if (!settings().get("shareContext")) await settings().update("shareContext", true, vscode.ConfigurationTarget.Global)
    publish()
    const editor = currentEditor()
    type(editor ? folderOf(editor.document.uri) : folders()[0], "/ide on vscode")
    vscode.window.showInformationMessage("MendCode: press Enter in the terminal to turn the editor context on for this project")
  }

  async function toggleShare() {
    await settings().update("shareContext", !settings().get("shareContext"), vscode.ConfigurationTarget.Global)
  }

  function open() {
    const editor = currentEditor()
    terminalFor(editor ? folderOf(editor.document.uri) : folders()[0])
  }

  function newSession() {
    const editor = currentEditor()
    terminalFor(editor ? folderOf(editor.document.uri) : folders()[0], { fresh: true })
  }

  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 90)
  status.command = "mendcode.controlCenter"
  function refreshStatus() {
    const sharing = Boolean(settings().get("shareContext"))
    status.text = sharing ? "$(sparkle) MendCode · context" : "$(sparkle) MendCode"
    status.tooltip = sharing ? "MendCode: editor context is published to the local daemon bridge" : "MendCode: editor context is not shared"
  }

  async function controlCenter() {
    const sharing = Boolean(settings().get("shareContext"))
    const items = [
      { label: "$(terminal) Open MendCode", detail: "Show the terminal client, or start it in this project", run: open },
      { label: "$(add) New MendCode session", detail: "Another terminal client in the same project", run: newSession },
      { label: "$(selection) Add selection to prompt", detail: "Types @file?start=&end= into the prompt", run: addSelection },
      { label: "$(file) Add file to prompt", detail: "Types @file into the prompt", run: () => addFile() },
      { label: "$(bug) Fix problems in this file", detail: "Types the file's errors and warnings into the prompt", run: fixProblems },
      { label: "$(plug) Connect editor context", detail: "Share the selection and type /ide on vscode", run: connect },
      { label: sharing ? "$(eye-closed) Stop sharing editor context" : "$(eye) Share editor context", detail: "Publishes the selection to the local data dir only", run: toggleShare },
    ]
    const picked = await vscode.window.showQuickPick(items, { title: "MendCode", placeHolder: "Choose an action" })
    if (picked) await picked.run()
  }

  const commands = { open, newSession, addSelection, addFile, fixProblems, connect, toggleShare, controlCenter }
  for (const [name, handler] of Object.entries(commands)) context.subscriptions.push(vscode.commands.registerCommand(`mendcode.${name}`, handler))
  context.subscriptions.push(
    output, status,
    vscode.window.onDidChangeTextEditorSelection(schedule),
    vscode.window.onDidChangeActiveTextEditor(schedule),
    vscode.workspace.onDidChangeWorkspaceFolders(() => { cleanup(); schedule() }),
    vscode.workspace.onDidCloseTextDocument(() => { if (lastEditor && lastEditor.document.isClosed) lastEditor = undefined; schedule() }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (!event.affectsConfiguration("mendcode")) return
      cleanup()
      refreshStatus()
      schedule()
    }),
    { dispose: () => { clearTimeout(debounce); clearInterval(heartbeat); cleanup() } },
  )
  // The daemon treats a record that stops refreshing as gone, so a crashed window never leaves stale context behind.
  const heartbeat = setInterval(() => { if (settings().get("shareContext")) publish() }, HEARTBEAT_MS)
  refreshStatus()
  status.show()
  publish()
}

function deactivate() {}

module.exports = { activate, deactivate }
