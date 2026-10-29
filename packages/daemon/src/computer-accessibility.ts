import { ComputerTarget, ComputerNode, type ComputerObservation, type ComputerActionInput, type ComputerWindow, type ComputerApp } from "@mendcode/protocol"
import type { CommandRunner } from "@mendcode/tools"

export type SemanticAction = ComputerActionInput & { action: "press" | "setValue" | "click" | "typeText" | "key" | "scroll" | "drag"; role: string }
export type ComputerAccessibility = {
  foreground(signal: AbortSignal): Promise<ComputerTarget>
  /** The live identity of an approved target, wherever it is on screen: undefined when its process ended or its bundle ID differs. Never activates it. */
  identify(target: ComputerTarget, signal: AbortSignal): Promise<ComputerTarget | undefined>
  observe(target: ComputerTarget, signal: AbortSignal): Promise<Pick<ComputerObservation, "nodes" | "truncated">>
  action(target: ComputerTarget, input: SemanticAction, signal: AbortSignal): Promise<void>
  indicator(signal: AbortSignal, action: () => Promise<void>): Promise<void>
  program?<T>(target: ComputerTarget, signal: AbortSignal, execute: () => Promise<T>): Promise<T>
  navigation?(pid: number, key: string, signal: AbortSignal): Promise<void>
  apps?(signal: AbortSignal): Promise<ComputerApp[]>
  resolve?(bundleID: string, signal: AbortSignal): Promise<ComputerTarget>
  /** Identifies a running target, or launches a missing one in the background; never brings it to the front. */
  activate?(target: ComputerTarget, signal: AbortSignal): Promise<ComputerTarget>
  windows?(target: ComputerTarget, signal: AbortSignal): Promise<ComputerWindow[]>
  selectWindow?(target: ComputerTarget, windowID: string, signal: AbortSignal): Promise<ComputerTarget>
  release?(target: ComputerTarget): void
  stop?(): void
}

/** Whatever a backend answers, a different process or bundle ID is never the approved target. */
export function identified(target: ComputerTarget, raw: unknown): ComputerTarget | undefined {
  const live = raw === null ? undefined : ComputerTarget.parse(raw)
  return live && live.pid === target.pid && live.bundleID === target.bundleID ? live : undefined
}

const FOREGROUND = `ObjC.import('AppKit')
const app = $.NSWorkspace.sharedWorkspace.frontmostApplication
JSON.stringify({pid:Number(app.processIdentifier),bundleID:ObjC.unwrap(app.bundleIdentifier),appName:ObjC.unwrap(app.localizedName)})`

// The approved process is addressed by its pid, not by being in front; its bundle ID is still checked on every call.
const IDENTIFY = `function run(argv) {
  const target = JSON.parse(argv[0]), se = Application('System Events')
  const app = se.applicationProcesses.whose({unixId:target.pid})()[0]
  if (!app || app.unixId() !== target.pid || app.bundleIdentifier() !== target.bundleID) return 'null'
  return JSON.stringify({pid:target.pid,bundleID:target.bundleID,appName:String(app.name())})
}`

const OBSERVE = `function run(argv) {
  const target = JSON.parse(argv[0]), se = Application('System Events')
  const app = se.applicationProcesses.whose({unixId:target.pid})()[0]
  if (!app || app.unixId() !== target.pid || app.bundleIdentifier() !== target.bundleID) throw Error('Computer target changed')
  const nodes = []; let truncated = false, bytes = 0
  const get = (fn, fallback) => { try { return fn() } catch (_) { return fallback } }
  const text = (value) => String(value == null ? '' : value).replace(/[\\r\\n\\t]/g,' ').slice(0,256)
  function walk(element,id,depth) {
    if (nodes.length >= 500 || depth > 12) { truncated = true; return }
    const role = text(get(() => element.role(),'unknown'))
    const secure = role === 'AXSecureTextField' || get(() => element.attributes.byName('AXSubrole').value(),'') === 'AXSecureTextField'
    const enabled = get(() => element.enabled(),false)
    const node = {id,role,name:secure ? '' : text(get(() => element.name(),'')),states:enabled ? ['enabled'] : [],actions:[]}
    if (secure) { node.secure = true; node.states.push('secure') }
    else { const value = text(get(() => element.value(),'')); if (value) node.value = value }
    if (enabled && !secure && ['AXButton','AXCheckBox','AXRadioButton','AXMenuItem'].includes(role)) node.actions.push('press')
    if (enabled && !secure && ['AXTextField','AXTextArea'].includes(role)) node.actions.push('setValue')
    const p = get(() => element.position(),null), size = get(() => element.size(),null)
    if (p && size) node.bounds = {x:p[0],y:p[1],width:size[0],height:size[1]}
    bytes += JSON.stringify(node).length * 3
    if (bytes > 60000) { truncated = true; return }
    nodes.push(node)
    const children = get(() => element.uiElements(),[])
    for (let i = 0; i < children.length; i++) {
      if (nodes.length >= 500 || bytes > 60000) { truncated = true; break }
      walk(children[i],id+'.'+(i+1),depth+1)
    }
  }
  const windows = app.windows()
  if (!windows.length) throw Error('No accessible window')
  walk(windows[0],'0',0)
  return JSON.stringify({nodes,truncated})
}`

const ACTION = `function run(argv) {
  const target = JSON.parse(argv[0]), input = JSON.parse(argv[1]), se = Application('System Events')
  const app = se.applicationProcesses.whose({unixId:target.pid})()[0]
  if (!app || app.unixId() !== target.pid || app.bundleIdentifier() !== target.bundleID) throw Error('Computer target changed')
  let node = app.windows()[0]
  for (const index of input.nodeID.split('.').slice(1)) node = node.uiElements()[Number(index)-1]
  const role = node.role()
  let subrole = ''; try { subrole = node.attributes.byName('AXSubrole').value() } catch (_) {}
  if (role === 'AXSecureTextField' || subrole === 'AXSecureTextField') throw Error('Secure fields cannot be controlled')
  if (role !== input.role || !node.enabled()) throw Error('Semantic node changed; observe again')
  if (input.action === 'press' && ['AXButton','AXCheckBox','AXRadioButton','AXMenuItem'].includes(role)) node.actions.byName('AXPress').perform()
  else if (input.action === 'setValue' && ['AXTextField','AXTextArea'].includes(role)) node.value = input.value
  else throw Error('Unsupported semantic action')
  return 'ok'
}`

const INDICATOR = `ObjC.import('Cocoa')
const point = $.NSEvent.mouseLocation
const window = $.NSWindow.alloc.initWithContentRectStyleMaskBackingDefer($.NSMakeRect(point.x+12,point.y-12,100,28),$.NSWindowStyleMaskBorderless,$.NSBackingStoreBuffered,false)
window.ignoresMouseEvents = true
window.level = $.NSStatusWindowLevel
window.backgroundColor = $.NSColor.colorWithSRGBRedGreenBlueAlpha(0.03,0.08,0.04,0.95)
window.collectionBehavior = $.NSWindowCollectionBehaviorCanJoinAllSpaces | $.NSWindowCollectionBehaviorFullScreenAuxiliary
const label = $.NSTextField.labelWithString('MendCode')
label.frame = $.NSMakeRect(8,5,88,20)
label.textColor = $.NSColor.colorWithSRGBRedGreenBlueAlpha(0.4,1,0.5,1)
window.contentView.addSubview(label)
window.orderFrontRegardless
$.NSFileHandle.fileHandleWithStandardOutput.writeData($('READY\\n').dataUsingEncoding($.NSUTF8StringEncoding))
$.NSRunLoop.currentRunLoop.runUntilDate($.NSDate.dateWithTimeIntervalSinceNow(25))
window.orderOut(null)`

async function indicator(signal: AbortSignal, action: () => Promise<void>) {
  signal.throwIfAborted()
  const child = Bun.spawn(["/usr/bin/osascript", "-l", "JavaScript", "-e", INDICATOR], { stdin: "ignore", stdout: "pipe", stderr: "ignore" })
  const readySignal = AbortSignal.any([signal, AbortSignal.timeout(1000)])
  const stop = () => child.kill()
  signal.addEventListener("abort", stop, { once: true })
  const reader = child.stdout.getReader()
  let rejectReady: (() => void) | undefined
  const timeout = new Promise<never>((_, reject) => { rejectReady = () => reject(new Error("Computer indicator did not become ready")); readySignal.addEventListener("abort", rejectReady, { once: true }); if (readySignal.aborted) rejectReady() })
  try {
    const chunk = await Promise.race([reader.read(), timeout])
    if (!new TextDecoder().decode(chunk.value).includes("READY")) throw new Error("Computer indicator did not become ready")
    signal.throwIfAborted()
    if (child.exitCode !== null) throw new Error("Computer indicator exited before the action")
    await action()
  } finally {
    readySignal.removeEventListener("abort", rejectReady!)
    signal.removeEventListener("abort", stop)
    stop()
    await reader.cancel().catch(() => {})
    reader.releaseLock()
    await child.exited
  }
}

export function createMacAccessibility(run: CommandRunner): ComputerAccessibility {
  async function command(script: string, args: string[], signal: AbortSignal) {
    signal.throwIfAborted()
    const result = await run(["/usr/bin/osascript", "-l", "JavaScript", "-e", script, ...args], signal)
    signal.throwIfAborted()
    if (result.code !== 0) throw new Error(result.stderr.includes("Computer target changed") ? "Computer target changed; start from a fresh capture" : "Computer accessibility operation failed. Check Accessibility permission for the terminal running MendCode.")
    return result.stdout.trim()
  }
  return {
    async foreground(signal) { return ComputerTarget.parse(JSON.parse(await command(FOREGROUND, [], signal))) },
    async identify(target, signal) { return identified(target, JSON.parse(await command(IDENTIFY, [JSON.stringify(target)], signal))) },
    async observe(target, signal) {
      const raw = await command(OBSERVE, [JSON.stringify(target)], signal)
      if (Buffer.byteLength(raw) > 65536) throw new Error("Accessibility snapshot exceeds 64 KiB")
      const result = JSON.parse(raw)
      if (!Array.isArray(result.nodes) || result.nodes.length > 500) throw new Error("Invalid accessibility snapshot")
      return { nodes: result.nodes.map((node: unknown) => ComputerNode.parse(node)), truncated: result.truncated === true }
    },
    async action(target, input, signal) { await command(ACTION, [JSON.stringify(target), JSON.stringify(input)], signal) },
    indicator,
  }
}
