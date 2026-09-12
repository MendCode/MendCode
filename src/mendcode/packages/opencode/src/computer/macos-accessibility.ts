import type { ComputerNode, ComputerTarget } from "./types"

const MAX_NODES = 500
const MAX_PAYLOAD_BYTES = 64 * 1024

export async function runNativeComputerCommand(command: string[], signal: AbortSignal, timeoutMs = 15_000) {
  signal.throwIfAborted()
  const child = Bun.spawn(command, { stdout: "pipe", stderr: "pipe" })
  const stop = () => child.kill()
  signal.addEventListener("abort", stop, { once: true })
  if (signal.aborted) stop()
  const timeout = setTimeout(stop, timeoutMs)
  try {
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    signal.throwIfAborted()
    if (code !== 0) {
      throw new Error(
        `Native computer operation failed: ${stderr.slice(0, 1200)}. Check macOS Screen Recording or Accessibility permissions for the terminal running MendCode.`,
      )
    }
    return stdout.trim()
  } finally {
    clearTimeout(timeout)
    signal.removeEventListener("abort", stop)
  }
}

const FRONT_TARGET = String.raw`
ObjC.import("Foundation")
const se = Application("System Events")
const process = se.applicationProcesses.whose({ frontmost: true })()[0]
if (!process) throw new Error("No foreground application")
const windows = process.windows()
const result = {
  pid: Number(process.unixId()),
  bundleID: String(process.bundleIdentifier() || ""),
  appName: String(process.name() || "Unknown application"),
  windowName: windows.length ? String(windows[0].name() || "") : ""
}
JSON.stringify(result)
`

export async function foregroundTarget(signal: AbortSignal): Promise<ComputerTarget> {
  if (process.platform !== "darwin") throw new Error("Built-in Computer Use is currently supported only on macOS.")
  const raw = await runNativeComputerCommand(["/usr/bin/osascript", "-l", "JavaScript", "-e", FRONT_TARGET], signal)
  const target = JSON.parse(raw) as ComputerTarget
  if (!Number.isSafeInteger(target.pid) || target.pid <= 0 || !target.bundleID) {
    throw new Error("Could not identify the foreground application.")
  }
  return target
}

const OBSERVE = String.raw`
on cleanText(valueText)
  set valueText to valueText as text
  set AppleScript's text item delimiters to {tab, return, linefeed}
  set pieces to text items of valueText
  set AppleScript's text item delimiters to " "
  set valueText to pieces as text
  set AppleScript's text item delimiters to ""
  if (count characters of valueText) > 256 then set valueText to text 1 thru 256 of valueText
  return valueText
end cleanText

on walkElement(theElement, locator, depth)
  global outputText, nodeCount, didTruncate
  if nodeCount >= 500 or depth > 12 then
    set didTruncate to true
    return
  end if
  set nodeCount to nodeCount + 1
  set roleText to "unknown"
  set nameText to ""
  set valueText to ""
  set stateText to ""
  set actionText to ""
  set boundsText to ""
  try
    set roleText to role of theElement as text
  end try
  try
    set nameText to name of theElement as text
  end try
  set isSecure to roleText is "AXSecureTextField"
  if isSecure then
    set stateText to "secure"
  else
    try
      set valueText to value of theElement as text
    end try
  end if
  try
    if enabled of theElement is true then set stateText to stateText & ",enabled"
  end try
  if roleText is "AXButton" or roleText is "AXCheckBox" or roleText is "AXRadioButton" or roleText is "AXMenuItem" then set actionText to "press"
  if roleText is "AXTextField" or roleText is "AXTextArea" then set actionText to "setValue"
  try
    set p to position of theElement
    set s to size of theElement
    set boundsText to (item 1 of p as text) & "," & (item 2 of p as text) & "," & (item 1 of s as text) & "," & (item 2 of s as text)
  end try
  set outputText to outputText & locator & tab & my cleanText(roleText) & tab & my cleanText(nameText) & tab & my cleanText(valueText) & tab & stateText & tab & actionText & tab & boundsText & linefeed
  try
    set childrenList to UI elements of theElement
    repeat with childIndex from 1 to count childrenList
      if nodeCount >= 500 then
        set didTruncate to true
        exit repeat
      end if
      my walkElement(item childIndex of childrenList, locator & "." & childIndex, depth + 1)
    end repeat
  end try
end walkElement

on run argv
  global outputText, nodeCount, didTruncate
  set outputText to ""
  set nodeCount to 0
  set didTruncate to false
  set targetID to item 1 of argv as integer
  tell application "System Events"
    set currentID to unix id of first application process whose frontmost is true
    if currentID is not targetID then error "Foreground application changed"
    tell first application process whose unix id is targetID
      if (count windows) is 0 then error "Foreground application has no accessible window"
      my walkElement(front window, "0", 0)
    end tell
  end tell
  if didTruncate then set outputText to outputText & "#TRUNCATED" & linefeed
  return outputText
end run
`

export async function observeAccessibility(target: ComputerTarget, signal: AbortSignal) {
  const raw = await runNativeComputerCommand(
    ["/usr/bin/osascript", "-e", OBSERVE, String(target.pid)],
    signal,
    20_000,
  )
  const nodes: ComputerNode[] = []
  let truncated = false
  for (const line of raw.split("\n")) {
    if (line === "#TRUNCATED") {
      truncated = true
      continue
    }
    if (!line || Buffer.byteLength(JSON.stringify(nodes), "utf8") >= MAX_PAYLOAD_BYTES) {
      if (line) truncated = true
      continue
    }
    const [id, role = "unknown", name = "", value = "", states = "", actions = "", bounds = ""] = line.split("\t")
    const secure = states.split(",").includes("secure")
    const values = bounds.split(",").map(Number)
    nodes.push({
      id,
      role,
      name,
      ...(value && !secure ? { value } : {}),
      ...(secure ? { secure: true as const } : {}),
      states: states.split(",").filter(Boolean),
      actions: actions.split(",").filter(Boolean),
      ...(values.length === 4 && values.every(Number.isFinite)
        ? { bounds: { x: values[0], y: values[1], width: values[2], height: values[3] } }
        : {}),
    })
    if (nodes.length >= MAX_NODES) {
      truncated = true
      break
    }
  }
  return { nodes, truncated }
}

const ACTION = String.raw`
on splitText(valueText, delimiterText)
  set AppleScript's text item delimiters to delimiterText
  set valuesList to text items of valueText
  set AppleScript's text item delimiters to ""
  return valuesList
end splitText

on resolveElement(targetProcess, locator)
  set indexes to my splitText(locator, ".")
  tell application "System Events"
    tell targetProcess
      set currentElement to front window
      repeat with partIndex from 2 to count indexes
        set childIndex to item partIndex of indexes as integer
        set currentElement to UI element childIndex of currentElement
      end repeat
      return currentElement
    end tell
  end tell
end resolveElement

on run argv
  set targetID to item 1 of argv as integer
  set locator to item 2 of argv
  set actionName to item 3 of argv
  set actionValue to item 4 of argv
  tell application "System Events"
    set currentID to unix id of first application process whose frontmost is true
    if currentID is not targetID then error "Foreground application changed"
    set targetProcess to first application process whose unix id is targetID
    set targetElement to my resolveElement(targetProcess, locator)
    set roleName to role of targetElement as text
    if roleName is "AXSecureTextField" then error "Secure fields cannot be controlled"
    if actionName is "press" then
      click targetElement
    else if actionName is "setValue" then
      if roleName is not "AXTextField" and roleName is not "AXTextArea" then error "Target is not an editable text field"
      set value of targetElement to actionValue
    else
      error "Unsupported semantic action"
    end if
  end tell
  return "ok"
end run
`

export async function performSemanticAction(
  target: ComputerTarget,
  input: { nodeID: string; action: "press" | "setValue"; value?: string },
  signal: AbortSignal,
) {
  await runNativeComputerCommand(
    ["/usr/bin/osascript", "-e", ACTION, String(target.pid), input.nodeID, input.action, input.value ?? ""],
    signal,
  )
}
