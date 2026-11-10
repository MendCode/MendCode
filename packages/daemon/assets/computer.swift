import Cocoa
import ApplicationServices
import QuartzCore

// Private stdio protocol. AX objects and authority never leave this process.
typealias Object = [String: Any]
struct Failure: Error { let message: String; var code: String? = nil }
var cancelled = false
signal(SIGTERM) { _ in cancelled = true }
signal(SIGINT) { _ in cancelled = true }
func fail(_ message: String) throws -> Never { throw Failure(message: message) }
// Delivery semantics as agent-desktop names them (CONCEPTS.md, "Delivery Semantics"): what matters about a failure is whether input
// can have reached the app. Until the request starts an effect (an AX action or value, a posted event, a window raise, a launch) a
// failure sent nothing and is safe to retry from a new observation; after it, the effect may have landed.
var effectStarted = false
func effect() { effectStarted = true }
func attribute(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
    var result: CFTypeRef?
    return AXUIElementCopyAttributeValue(element, name as CFString, &result) == .success ? result : nil
}
func elementAttribute(_ element: AXUIElement, _ name: String) -> AXUIElement? {
    guard let value = attribute(element, name), CFGetTypeID(value) == AXUIElementGetTypeID() else { return nil }
    return (value as! AXUIElement)
}
func text(_ element: AXUIElement, _ name: String) -> String { attribute(element, name) as? String ?? "" }
func clipped(_ value: String) -> String {
    var units = Array(value.utf16.prefix(256))
    if let last = units.last, last >= 0xD800 && last <= 0xDBFF { units.removeLast() }
    return String(decoding: units, as: UTF16.self).replacingOccurrences(of: "\n", with: " ").replacingOccurrences(of: "\r", with: " ").replacingOccurrences(of: "\t", with: " ")
}
// AppKit text views (TextEdit's document) do not report AXEnabled at all; without AXTextArea here they offered no action.
let enabledWithoutAttribute: Set<String> = ["AXWindow", "AXScrollArea", "AXGroup", "AXWebArea", "AXImage", "AXTextArea"]
func enabled(_ element: AXUIElement) -> Bool {
    if let value = attribute(element, kAXEnabledAttribute) as? Bool { return value }
    return enabledWithoutAttribute.contains(text(element, kAXRoleAttribute))
}
func rect(position: CFTypeRef?, size: CFTypeRef?) -> CGRect? {
    guard let p = position, let s = size, CFGetTypeID(p) == AXValueGetTypeID(), CFGetTypeID(s) == AXValueGetTypeID() else { return nil }
    var point = CGPoint.zero, extent = CGSize.zero
    guard AXValueGetValue(p as! AXValue, .cgPoint, &point), AXValueGetValue(s as! AXValue, .cgSize, &extent), point.x.isFinite, point.y.isFinite, extent.width > 0, extent.height > 0 else { return nil }
    return CGRect(origin: point, size: extent)
}
func bounds(_ element: AXUIElement) -> CGRect? { rect(position: attribute(element, kAXPositionAttribute), size: attribute(element, kAXSizeAttribute)) }
// One round trip per node, as agent-desktop reads its nodes (crates/macos/src/tree/properties/node_attribute_fetch.rs, Apache-2.0):
// AXUIElementCopyMultipleAttributeValues answers every attribute a node needs at once, where one call per attribute made about
// fifteen times the calls (measured read-only, same nodes and actions: Ghostty's window, 239 nodes, 465–528 ms before and 61–73 ms
// now; Finder's sidebar walk 5,822 calls and 471 ms before, 381 calls and 68 ms now). The value is read separately, and only once
// the role says the node is not a secure field.
let nodeAttributes = [kAXRoleAttribute, kAXSubroleAttribute, kAXTitleAttribute, kAXDescriptionAttribute, kAXIdentifierAttribute, kAXEnabledAttribute, kAXFocusedAttribute, kAXPositionAttribute, kAXSizeAttribute] as CFArray
let nodeAttributesWithChildren = [kAXRoleAttribute, kAXSubroleAttribute, kAXTitleAttribute, kAXDescriptionAttribute, kAXIdentifierAttribute, kAXEnabledAttribute, kAXFocusedAttribute, kAXPositionAttribute, kAXSizeAttribute, kAXChildrenAttribute] as CFArray
struct NodeRead { var role = "", subrole = "", title = "", description = "", identifier = "", enabled = false, focused = false, bounds: CGRect?, children: [AXUIElement] = [] }
func readNode(_ element: AXUIElement, children: Bool = false) -> NodeRead {
    var values: CFArray?
    let names = children ? nodeAttributesWithChildren : nodeAttributes
    guard AXUIElementCopyMultipleAttributeValues(element, names, AXCopyMultipleAttributeOptions(rawValue: 0), &values) == .success, let list = values as? [AnyObject], list.count == CFArrayGetCount(names) else {
        // An app that cannot answer the batch still answers each attribute.
        var slow = NodeRead(role: text(element, kAXRoleAttribute), subrole: text(element, kAXSubroleAttribute), title: text(element, kAXTitleAttribute), description: text(element, kAXDescriptionAttribute), identifier: text(element, kAXIdentifierAttribute), enabled: enabled(element), focused: (attribute(element, kAXFocusedAttribute) as? Bool) == true, bounds: bounds(element))
        if children { slow.children = attribute(element, kAXChildrenAttribute) as? [AXUIElement] ?? [] }
        return slow
    }
    // A slot the app could not answer holds an AXValue of the error type instead of the attribute.
    let slots = list.map { value -> AnyObject? in CFGetTypeID(value) == AXValueGetTypeID() && AXValueGetType(value as! AXValue) == .axError ? nil : value }
    var node = NodeRead(role: slots[0] as? String ?? "", subrole: slots[1] as? String ?? "", title: slots[2] as? String ?? "", description: slots[3] as? String ?? "", identifier: slots[4] as? String ?? "")
    node.enabled = (slots[5] as? Bool) ?? enabledWithoutAttribute.contains(node.role)
    node.focused = (slots[6] as? Bool) == true
    node.bounds = rect(position: slots[7], size: slots[8])
    if children { node.children = slots[9] as? [AXUIElement] ?? [] }
    return node
}
func rectObject(_ rect: CGRect) -> Object { ["x": rect.minX, "y": rect.minY, "width": rect.width, "height": rect.height] }
// Web pages nest deeply: in a browser the page itself starts about ten levels below the window, and a tab label sits ten
// to twenty below that (measured on GitHub in Brave: with 12 levels its tabs were unnamed groups with no children).
let observeDepth = 32
// Every ancestry walk covers the deepest observed node, its window and the application above it.
let ancestryLimit = 64
func secure(_ element: AXUIElement) -> Bool {
    var current: AXUIElement? = element
    for _ in 0..<ancestryLimit {
        guard let node = current else { return false }
        if text(node, kAXRoleAttribute) == "AXSecureTextField" || text(node, kAXSubroleAttribute) == "AXSecureTextField" { return true }
        current = elementAttribute(node, kAXParentAttribute)
    }
    return current != nil // Unknown ancestry is not authority to type.
}
func descendant(_ element: AXUIElement, of ancestor: AXUIElement) -> Bool {
    var current: AXUIElement? = element
    for _ in 0..<ancestryLimit {
        guard let node = current else { return false }
        if CFEqual(node, ancestor) { return true }
        current = elementAttribute(node, kAXParentAttribute)
    }
    return false
}
/** What revalidation compares: the node's identity and state, with its value unless `value` is nil. */
func signature(_ node: NodeRead, value: String?) -> String {
    let values = [node.role, node.subrole, node.identifier, node.title, node.description, value ?? "\u{0}"]
    return String(data: try! JSONSerialization.data(withJSONObject: values + [String(node.enabled), String(describing: node.bounds)]), encoding: .utf8)!
}
func fingerprint(_ element: AXUIElement, value: Bool = true) -> String { signature(readNode(element), value: value ? text(element, kAXValueAttribute) : nil) }
/** `stable` leaves the value out: a node an earlier step of the same batch changed is still that node when only its value moved. */
struct Reference { let element: AXUIElement; let signature: String; let stable: String; let window: AXUIElement; let pid: pid_t }
func retain(_ element: AXUIElement, window: AXUIElement, pid: pid_t) -> Reference {
    let node = readNode(element)
    return Reference(element: element, signature: signature(node, value: text(element, kAXValueAttribute)), stable: signature(node, value: nil), window: window, pid: pid)
}
var references: [String: Reference] = [:]
var windowHandles: [String: AXUIElement] = [:]
var windowPIDs: [String: pid_t] = [:]
var nodeCounter: UInt64 = UInt64.random(in: 100_000_000_000...900_000_000_000)
var badge: NSPanel?
var cursorLocation: CGPoint?
var cursorProgram = false
var lease: Int32 = -1
func acquireLease() throws {
    if lease >= 0 { return }
    let file = "/tmp/mendcode-computer-\(getuid()).lock"
    let fd = open(file, O_CREAT | O_RDWR | O_NOFOLLOW, mode_t(0o600))
    guard fd >= 0 else { try fail("Cannot acquire exclusive computer input lease") }
    var info = stat()
    guard fstat(fd, &info) == 0, info.st_uid == getuid(), (info.st_mode & S_IFMT) == S_IFREG, flock(fd, LOCK_EX | LOCK_NB) == 0 else { close(fd); try fail("Another MendCode process owns computer input") }
    lease = fd
}
func releaseLease() { if lease >= 0 { flock(lease, LOCK_UN); close(lease); lease = -1 } }
let app = NSApplication.shared
app.setActivationPolicy(.accessory)

/** The Accessibility pane of System Settings; the app is listed there once it asked for access (AXIsProcessTrustedWithOptions below). */
let accessibilityPane = "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"
var permissionAsked = false
/** Lists this app under Accessibility (the system dialog) and opens the exact pane, once per run: only when a tool needs the permission. */
func askForAccessibility() {
    if permissionAsked { return }
    permissionAsked = true
    let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
    _ = AXIsProcessTrustedWithOptions(options)
    if let url = URL(string: accessibilityPane) { NSWorkspace.shared.open(url) }
}
func trusted() throws {
    if !AXIsProcessTrusted() {
        askForAccessibility()
        // `code` tells the daemon to wait for the grant and repeat the request itself; nothing was sent to any app.
        throw Failure(message: "Accessibility permission is missing for \"MendCode Computer Use\". System Settings > Privacy & Security > Accessibility is open: turn on \"MendCode Computer Use\" (it is already in the list).", code: "accessibility")
    }
}
// AppKit only learns which app is in front, and which apps run or ended, when the main run loop turns; this thread waits in readLine()
// between requests, so without a turn here the answer stays what it was at the last one (measured: another app came to the front and
// observe still passed for the old target). One pass with no wait delivers what is pending (about 0.2 ms).
func frontmost() -> NSRunningApplication? {
    CFRunLoopRunInMode(.defaultMode, 0, false)
    return NSWorkspace.shared.frontmostApplication
}
// The approved identity is the process AND its bundle ID; being in front is a separate fact that only input events need.
func alive(_ target: Object) -> NSRunningApplication? {
    guard let pid = target["pid"] as? Int, let bundle = target["bundleID"] as? String, pid > 0, pid <= Int(Int32.max) else { return nil }
    // LaunchServices occasionally answers "no such application" for a process that is running (measured on a background-launched app);
    // an ended process fails kill() at once, so only a live-but-unknown one waits (at most 150 ms) before it is treated as gone.
    for attempt in 0..<4 {
        CFRunLoopRunInMode(.defaultMode, attempt == 0 ? 0 : 0.05, false)
        if let running = NSRunningApplication(processIdentifier: pid_t(pid)) ?? NSWorkspace.shared.runningApplications.first(where: { Int($0.processIdentifier) == pid }) {
            return !running.isTerminated && running.bundleIdentifier == bundle ? running : nil
        }
        if kill(pid_t(pid), 0) != 0 { return nil }
    }
    return nil
}
let needsFront = "This action needs the app in front and another app is in front; no input was sent. Observe, press and setValue work while the app is in the background; ask the user to bring the app forward for this one"
// Observation, AXPress and AXSetValue address the approved process directly and work in the background (foreground: false).
// Key, text, pointer and window-raise events reach the app only through the focus, so they keep requiring it to be in front.
func running(_ target: Object, foreground: Bool = true) throws -> NSRunningApplication {
    if cancelled { try fail("Native operation cancelled; effects may be partial") }
    guard let running = alive(target) else { try fail("Computer target changed or exited; start a new session") }
    if foreground && frontmost()?.processIdentifier != running.processIdentifier { try fail(needsFront) }
    return running
}
func handle(_ window: AXUIElement, pid: pid_t) -> String {
    if let previous = windowHandles.first(where: { windowPIDs[$0.key] == pid && CFEqual($0.value, window) }) { return previous.key }
    if windowHandles.count >= 512, let oldest = windowHandles.keys.first { windowHandles.removeValue(forKey: oldest); windowPIDs.removeValue(forKey: oldest) }
    let id = UUID().uuidString
    windowHandles[id] = window; windowPIDs[id] = pid
    return id
}
func targetObject(_ running: NSRunningApplication) -> Object {
    var result: Object = ["pid": Int(running.processIdentifier), "bundleID": running.bundleIdentifier ?? "", "appName": clipped(running.localizedName ?? "")]
    let ax = AXUIElementCreateApplication(running.processIdentifier)
    AXUIElementSetMessagingTimeout(ax, 1)
    if let window = elementAttribute(ax, kAXFocusedWindowAttribute) {
        result["windowID"] = handle(window, pid: running.processIdentifier)
        result["windowName"] = clipped(text(window, kAXTitleAttribute))
    }
    return result
}
func selected(_ target: Object, foreground: Bool = true) throws -> (NSRunningApplication, AXUIElement, AXUIElement) {
    try trusted()
    let running = try running(target, foreground: foreground)
    let ax = AXUIElementCreateApplication(running.processIdentifier)
    AXUIElementSetMessagingTimeout(ax, 1)
    guard let focused = elementAttribute(ax, kAXFocusedWindowAttribute) else { try fail("No focused accessible window") }
    if let id = target["windowID"] as? String {
        guard let window = windowHandles[id], windowPIDs[id] == running.processIdentifier, CFEqual(window, focused) else { try fail("Selected window changed: the session's window closed or another window of the app has focus. In computer_code call tools.windows({}) then tools.selectWindow({windowID}) and observe, or start a new session") }
    }
    if badge != nil { anchor(focused) }
    return (running, ax, focused)
}
// MendCode's agent cursor: a violet dot in a white ring, a dark tag naming the action, a tap ring, corner marks around the element
// acted on and a dashed drag line. Everything is a layer of one transparent canvas window kept directly above the controlled app's
// window, so a window that covers the app covers its cursor too, and moving the cursor never moves a window.
/** Black and white, with one accent: colours that read on light and dark windows. */
let cursorAccents: [(Double, Double, Double)] = [
    (1.0, 0.42, 0.42), (0.96, 0.65, 0.14), (0.64, 0.90, 0.21), (0.18, 0.83, 0.75),
    (0.22, 0.74, 0.97), (0.51, 0.55, 0.97), (0.96, 0.45, 0.71), (0.98, 0.57, 0.24),
]
/**
 * Each helper takes an accent when it starts, at random among those no other running helper holds: two MendCode installs
 * controlling apps at once show different colours. Who holds which is a small shared file of `pid index` lines, under a lock;
 * lines of helpers that exited are dropped.
 */
func pickAccent(registry: String = (NSTemporaryDirectory() as NSString).appendingPathComponent("mendcode-cursor-accents")) -> Int {
    let fd = open(registry, O_RDWR | O_CREAT, 0o600)
    guard fd >= 0 else { return Int.random(in: 0..<cursorAccents.count) }
    defer { flock(fd, LOCK_UN); close(fd) }
    flock(fd, LOCK_EX)
    let current = (try? String(contentsOfFile: registry, encoding: .utf8)) ?? ""
    var held: [(pid: Int32, index: Int)] = current.split(separator: "\n").compactMap { line in
        let parts = line.split(separator: " ")
        guard parts.count == 2, let pid = Int32(parts[0]), let index = Int(parts[1]), pid != getpid(), kill(pid, 0) == 0 else { return nil }
        return (pid, index)
    }
    let taken = Set(held.map(\.index)), free = cursorAccents.indices.filter { !taken.contains($0) }
    let index = free.randomElement() ?? Int.random(in: 0..<cursorAccents.count)
    held.append((getpid(), index))
    let text = held.map { "\($0.pid) \($0.index)" }.joined(separator: "\n") + "\n"
    ftruncate(fd, 0); lseek(fd, 0, SEEK_SET)
    _ = text.withCString { write(fd, $0, strlen($0)) }
    return index
}
/** `--cursor-render` draws with the first accent, so its pixels can be checked; a helper that controls apps picks one. */
var pickedAccent: (Double, Double, Double)?
/** Picked the first time the cursor is drawn, not at start: the helper's decision-only modes never touch the shared file. */
var cursorAccent: (Double, Double, Double) {
    if let picked = pickedAccent { return picked }
    let picked = CommandLine.arguments.contains("--cursor-render") ? cursorAccents[0] : cursorAccents[pickAccent()]
    pickedAccent = picked
    return picked
}
let cursorInk = (0.04, 0.04, 0.05), cursorTag = (0.06, 0.06, 0.07)
func color(_ rgb: (Double, Double, Double), _ alpha: CGFloat = 1) -> CGColor { NSColor(srgbRed: rgb.0, green: rgb.1, blue: rgb.2, alpha: alpha).cgColor }
/** Layers move and change only when told to: no implicit animation lags behind the cursor. */
func frozen(_ layer: CALayer) { layer.actions = ["transform": NSNull(), "opacity": NSNull(), "position": NSNull(), "bounds": NSNull(), "hidden": NSNull(), "path": NSNull(), "string": NSNull(), "contents": NSNull(), "frame": NSNull()] }
/** A transparent, non-activating, click-through panel at the normal window level that screenshots and the accessibility tree do not see. */
func overlayPanel(_ frame: NSRect) -> NSPanel {
    let panel = NSPanel(contentRect: frame, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
    panel.isFloatingPanel = false; panel.level = .normal; panel.ignoresMouseEvents = true
    panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .ignoresCycle]
    panel.isOpaque = false; panel.backgroundColor = .clear; panel.hasShadow = false; panel.hidesOnDeactivate = false
    panel.isReleasedWhenClosed = false; panel.sharingType = .none; panel.animationBehavior = .none
    let view = NSView(frame: NSRect(origin: .zero, size: frame.size))
    view.wantsLayer = true; frozen(view.layer!)
    view.setAccessibilityElement(false); panel.setAccessibilityElement(false)
    panel.contentView = view
    return panel
}
let labelFont = NSFont.systemFont(ofSize: 12, weight: .semibold)
/** The cursor's own layer: the dot's center sits at `stageTip` and the tag beside it. */
let stageSize = CGSize(width: 260, height: 120), stageTip = CGPoint(x: 130, y: 60), dotSize: CGFloat = 18
final class CursorStage {
    let root = CALayer(), dot = CALayer(), core = CALayer(), tag = CALayer(), mark = CALayer(), caption = CATextLayer()
    var label = ""
    init() {
        root.bounds = CGRect(origin: .zero, size: stageSize); root.anchorPoint = CGPoint(x: stageTip.x / stageSize.width, y: stageTip.y / stageSize.height)
        frozen(root)
        // The dot follows the Accessibility cursor size, as the user's own pointer does.
        let arrow = NSCursor.arrow.image.size.height, scale = min(3, max(0.6, arrow > 0 ? arrow / 40 : 1))
        let size = dotSize * scale
        dot.bounds = CGRect(x: 0, y: 0, width: size, height: size); dot.position = stageTip; dot.cornerRadius = size / 2
        dot.backgroundColor = NSColor.white.cgColor; dot.borderColor = color(cursorInk); dot.borderWidth = 1.5 * scale
        dot.shadowColor = NSColor.black.cgColor; dot.shadowOpacity = 0.35; dot.shadowRadius = 4; dot.shadowOffset = CGSize(width: 0, height: -1.5)
        frozen(dot)
        let inner = size * 0.56
        core.bounds = CGRect(x: 0, y: 0, width: inner, height: inner); core.position = CGPoint(x: size / 2, y: size / 2); core.cornerRadius = inner / 2
        core.backgroundColor = color(cursorAccent)
        frozen(core)
        dot.addSublayer(core)
        tag.backgroundColor = color(cursorTag, 0.96); tag.borderColor = color(cursorAccent, 0.85); tag.borderWidth = 1; tag.cornerRadius = 6
        tag.shadowColor = NSColor.black.cgColor; tag.shadowOpacity = 0.3; tag.shadowRadius = 3; tag.shadowOffset = CGSize(width: 0, height: -1.5)
        tag.isHidden = true
        frozen(tag)
        mark.bounds = CGRect(x: 0, y: 0, width: 6, height: 6); mark.cornerRadius = 3; mark.backgroundColor = color(cursorAccent)
        frozen(mark)
        caption.font = labelFont; caption.fontSize = labelFont.pointSize; caption.foregroundColor = NSColor.white.cgColor
        caption.alignmentMode = .left; caption.truncationMode = .end
        caption.contentsScale = NSScreen.screens.map(\.backingScaleFactor).max() ?? 2
        frozen(caption)
        tag.addSublayer(mark); tag.addSublayer(caption)
        root.addSublayer(tag); root.addSublayer(dot)
    }
    /** Shows `text` in the tag; a new text slides in. */
    func show(_ text: String) {
        guard text != label else { return }
        label = text
        let width = min(120, ceil(NSAttributedString(string: text, attributes: [.font: labelFont]).size().width))
        tag.bounds = CGRect(x: 0, y: 0, width: width + 26, height: 22)
        mark.position = CGPoint(x: 10, y: 11)
        let line = ceil(labelFont.ascender - labelFont.descender + labelFont.leading)
        caption.frame = CGRect(x: 18, y: (22 - line) / 2, width: width, height: line)
        caption.string = text
        tag.isHidden = text.isEmpty
        tag.removeAllAnimations()
        guard !text.isEmpty, !reduceMotion() else { return }
        let fade = CABasicAnimation(keyPath: "opacity"); fade.fromValue = 0; fade.toValue = 1
        let slide = CABasicAnimation(keyPath: "transform.translation.x"); slide.fromValue = -6; slide.toValue = 0
        let reveal = CAAnimationGroup(); reveal.animations = [fade, slide]; reveal.duration = 0.14; reveal.timingFunction = CAMediaTimingFunction(name: .easeOut)
        tag.add(reveal, forKey: "reveal")
    }
    /** The tag sits right of the dot, or left of it where the screen ends. */
    func place(_ cocoa: CGPoint) {
        let screen = (NSScreen.screens.first(where: { $0.frame.contains(cocoa) }) ?? NSScreen.screens.first)?.frame ?? .infinite
        let size = tag.bounds.size, gap = dot.bounds.width / 2 + 8
        let x = cocoa.x + gap + size.width <= screen.maxX ? stageTip.x + gap : stageTip.x - gap - size.width
        tag.frame = CGRect(origin: CGPoint(x: x, y: stageTip.y - size.height / 2), size: size)
    }
}
var cursorStage: CursorStage?
/** The one canvas window and its effect layers; created once, ordered out while no program shows the cursor. */
var canvas: NSPanel?, rippleLayer: CAShapeLayer?, bracketLayer: CAShapeLayer?, trailLayer: CAShapeLayer?, trailPath = CGMutablePath()
/** When the click effects may go, and when the cursor last moved: after six idle seconds it rests (fades out) until the next move. */
var effectsUntil: TimeInterval = 0, cursorActiveAt: TimeInterval = 0, cursorResting = false
/** The controlled app's window the canvas sits above (0 before the first operation names one), and when it was last ordered there. */
var anchorWindow: CGWindowID = 0, anchoredAt: TimeInterval = 0
/** When the cursor's current travel ends (Core Animation time): effects of the action it travels to start then. */
var travelEndsAt: CFTimeInterval = 0
/** Set while a batch runs: the cursor jumps to each node, so a batch's speed is the app's own, not the cursor's. */
var instantTravel = false
@_silgen_name("_AXUIElementGetWindow") func axWindowNumber(_ element: AXUIElement, _ id: UnsafeMutablePointer<CGWindowID>) -> AXError
func uptime() -> TimeInterval { ProcessInfo.processInfo.systemUptime }
func reduceMotion() -> Bool { NSWorkspace.shared.accessibilityDisplayShouldReduceMotion }
func cocoaPoint(_ point: CGPoint) -> CGPoint {
    CGPoint(x: point.x, y: (NSScreen.screens.first?.frame.maxY ?? 0) - point.y)
}
func cocoaRect(_ rect: CGRect) -> NSRect {
    NSRect(x: rect.minX, y: (NSScreen.screens.first?.frame.maxY ?? 0) - rect.maxY, width: rect.width, height: rect.height)
}
/** A point of the screen (AX coordinates, y down) in the canvas's layer space. */
func canvasPoint(_ point: CGPoint) -> CGPoint {
    let cocoa = cocoaPoint(point), origin = canvas?.frame.origin ?? .zero
    return CGPoint(x: cocoa.x - origin.x, y: cocoa.y - origin.y)
}
func canvasRect(_ rect: CGRect) -> CGRect {
    let cocoa = cocoaRect(rect), origin = canvas?.frame.origin ?? .zero
    return cocoa.offsetBy(dx: -origin.x, dy: -origin.y)
}
func canvasLayer() -> CALayer? { canvas?.contentView?.layer }
/** The canvas covers every display, so the cursor can go wherever the controlled window is. */
func makeCanvas() -> NSPanel {
    let frame = NSScreen.screens.reduce(NSRect.null) { $0.union($1.frame) }
    let panel = overlayPanel(frame.isNull ? NSRect(x: 0, y: 0, width: 1, height: 1) : frame), root = panel.contentView!.layer!
    let ripple = CAShapeLayer(), brackets = CAShapeLayer(), trail = CAShapeLayer()
    for layer in [ripple, brackets, trail] { layer.fillColor = NSColor.clear.cgColor; layer.strokeColor = color(cursorAccent); layer.opacity = 0; frozen(layer); root.addSublayer(layer) }
    ripple.lineWidth = 2.5
    brackets.lineWidth = 2.5; brackets.lineCap = .round; brackets.lineJoin = .round
    brackets.shadowColor = color(cursorAccent); brackets.shadowOpacity = 0.45; brackets.shadowRadius = 6; brackets.shadowOffset = .zero
    trail.lineWidth = 2.5; trail.lineCap = .round; trail.lineDashPattern = [7, 5]; trail.strokeColor = color(cursorAccent, 0.9)
    rippleLayer = ripple; bracketLayer = brackets; trailLayer = trail
    return panel
}
/**
 * Keeps the canvas directly above the controlled window: another window in front of that window covers the cursor, and the cursor
 * is hidden while the window is off screen (minimized, another Space). Rate limited unless `force`, as the window order is asked
 * of the window server.
 */
func keepAbove(force: Bool = false) {
    guard let panel = canvas, badge != nil else { return }
    let now = uptime()
    if !force && now - anchoredAt < 0.2 { return }
    anchoredAt = now
    guard anchorWindow != 0 else { if !panel.isVisible { panel.orderFrontRegardless() }; return }
    let info = CGWindowListCopyWindowInfo(.optionIncludingWindow, anchorWindow) as? [[String: Any]]
    let onScreen = info?.first?[kCGWindowIsOnscreen as String] as? Bool ?? false
    panel.contentView?.layer?.isHidden = !onScreen
    if onScreen { panel.order(.above, relativeTo: Int(anchorWindow)) }
    // The canvas itself is always in the window list while a program runs (that is the visible indicator), its drawing hidden
    // when the controlled window is not on screen; a window number the server no longer orders against falls back to the front.
    if !panel.isVisible { panel.orderFrontRegardless() }
}
/** The window an operation acts in becomes the canvas's anchor. */
func anchor(_ window: AXUIElement) {
    var id: CGWindowID = 0
    guard axWindowNumber(window, &id) == .success, id != 0 else { return }
    if id != anchorWindow { anchorWindow = id; keepAbove(force: true) } else { keepAbove() }
}
/** Puts the cursor at `point`; with `from` it travels there over `seconds` on its own, while the action goes ahead. */
func presentCursor(_ point: CGPoint, label: String? = nil, from: CGPoint? = nil, seconds: Double = 0) {
    guard let stage = cursorStage else { return }
    if let label = label { stage.show(label) }
    stage.place(cocoaPoint(point))
    stage.root.removeAnimation(forKey: "travel")
    let end = canvasPoint(point)
    if let from = from, seconds > 0 {
        let travel = CABasicAnimation(keyPath: "position"); travel.fromValue = NSValue(point: canvasPoint(from)); travel.toValue = NSValue(point: end)
        travel.duration = seconds; travel.timingFunction = CAMediaTimingFunction(controlPoints: 0.2, 0.8, 0.2, 1)
        stage.root.add(travel, forKey: "travel")
        travelEndsAt = CACurrentMediaTime() + seconds
    } else { travelEndsAt = 0 }
    stage.root.position = end
    if cursorResting { stage.root.removeAnimation(forKey: "rest"); stage.root.opacity = 1; cursorResting = false }
    cursorLocation = point; cursorActiveAt = uptime()
    keepAbove()
    CATransaction.flush()
}
/** How long the cursor takes to reach a point `distance` away: 40 to 120 ms, growing with the square root of the distance. */
func travelSeconds(_ distance: Double) -> Double { distance < 1.5 ? 0 : min(120, max(40, 4 * distance.squareRoot())) / 1000 }
func animateCursor(to end: CGPoint, label: String) throws {
    guard badge?.isVisible == true else { try fail("Virtual cursor is not visible") }
    let start = cursorLocation ?? end, seconds = reduceMotion() || instantTravel ? 0 : travelSeconds(Double(hypot(end.x - start.x, end.y - start.y)))
    presentCursor(end, label: label, from: seconds > 0 ? start : nil, seconds: seconds)
}
/** An animation that starts when the cursor arrives and holds its last frame. */
func arriving<T: CAAnimation>(_ animation: T, _ seconds: Double) -> T {
    animation.duration = seconds; animation.beginTime = max(CACurrentMediaTime(), travelEndsAt)
    animation.fillMode = .both; animation.isRemovedOnCompletion = false
    return animation
}
/** A tap: one ring spreads from the dot and fades in 0.28 s. */
func ripple(at point: CGPoint) {
    guard let layer = rippleLayer else { return }
    let center = canvasPoint(point), radius: CGFloat = 22
    layer.removeAllAnimations()
    layer.bounds = CGRect(x: 0, y: 0, width: radius * 2, height: radius * 2); layer.position = center
    layer.path = CGPath(ellipseIn: layer.bounds.insetBy(dx: 2, dy: 2), transform: nil)
    let spread = CABasicAnimation(keyPath: "transform.scale"); spread.fromValue = 0.35; spread.toValue = 1.25
    let fade = CABasicAnimation(keyPath: "opacity"); fade.fromValue = 0.95; fade.toValue = 0
    let group = CAAnimationGroup(); group.animations = [spread, fade]; group.timingFunction = CAMediaTimingFunction(name: .easeOut)
    layer.add(arriving(group, 0.28), forKey: "ripple")
    effectsUntil = max(effectsUntil, uptime() + 0.5)
}
/** Corner marks around the element acted on: they close in and fade within 0.6 s. */
func highlight(_ rect: CGRect) {
    guard let layer = bracketLayer else { return }
    let frame = canvasRect(rect).insetBy(dx: -5, dy: -5), arm = max(6, min(14, min(frame.width, frame.height) / 3))
    layer.removeAllAnimations()
    layer.bounds = CGRect(origin: .zero, size: frame.size); layer.position = CGPoint(x: frame.midX, y: frame.midY)
    let path = CGMutablePath(), w = frame.width, h = frame.height
    for (x, y, dx, dy) in [(0, 0, 1, 1), (w, 0, -1, 1), (0, h, 1, -1), (w, h, -1, -1)] as [(CGFloat, CGFloat, CGFloat, CGFloat)] {
        path.move(to: CGPoint(x: x + dx * arm, y: y)); path.addLine(to: CGPoint(x: x, y: y)); path.addLine(to: CGPoint(x: x, y: y + dy * arm))
    }
    layer.path = path
    let fade = CAKeyframeAnimation(keyPath: "opacity"); fade.values = [0, 1, 1, 0]; fade.keyTimes = [0, 0.15, 0.6, 1]
    let close = CABasicAnimation(keyPath: "transform.scale"); close.fromValue = 1.12; close.toValue = 1
    close.timingFunction = CAMediaTimingFunction(name: .easeOut)
    let group = CAAnimationGroup(); group.animations = [fade, close]
    layer.add(arriving(group, 0.6), forKey: "brackets")
    effectsUntil = max(effectsUntil, uptime() + 0.8)
}
/** What an action shows once it is dispatched: a tap ring for a click, press or drop, and corner marks around the element. */
func cursorEffect(click: Bool, around rect: CGRect?) {
    guard !reduceMotion(), cursorStage != nil else { return }
    if click, let point = cursorLocation { ripple(at: point) }
    if let rect = rect { highlight(rect) }
    CATransaction.flush()
}
/** A drag draws its path as a dashed line in the accent colour, and fades it once it is dropped. */
func trailBegin(_ from: CGPoint, to: CGPoint) {
    guard let layer = trailLayer else { return }
    layer.removeAllAnimations()
    trailPath = CGMutablePath(); trailPath.move(to: canvasPoint(from))
    layer.path = trailPath; layer.opacity = 1
}
func trailAppend(_ point: CGPoint) {
    guard let layer = trailLayer else { return }
    trailPath.addLine(to: canvasPoint(point)); layer.path = trailPath
}
func trailEnd(fade: Bool) {
    guard let layer = trailLayer, layer.opacity > 0 else { return }
    if fade && !reduceMotion() {
        let out = CABasicAnimation(keyPath: "opacity"); out.fromValue = 1; out.toValue = 0; out.duration = 0.5
        layer.add(out, forKey: "fade")
        effectsUntil = max(effectsUntil, uptime() + 0.6)
    }
    layer.opacity = 0
}
/** Ends what the effects still show: before a hit test, so nothing of ours is under the point, and when they have played. */
func stopEffects() {
    for layer in [rippleLayer, bracketLayer, trailLayer] { layer?.removeAllAnimations(); layer?.opacity = 0 }
    effectsUntil = 0
}
/** Between requests: end played effects, keep the canvas above the controlled window, and let an idle cursor rest after six seconds. */
let restingOpacity: Float = 0.45
func idle() {
    if effectsUntil > 0 && uptime() >= effectsUntil { stopEffects() }
    keepAbove()
    guard let stage = cursorStage, badge != nil, !cursorResting, uptime() - cursorActiveAt >= 6 else { return }
    // A resting cursor dims where it last went instead of vanishing, so the user still sees where MendCode is.
    let rest = CABasicAnimation(keyPath: "opacity"); rest.fromValue = 1; rest.toValue = restingOpacity; rest.duration = 0.16
    stage.root.add(rest, forKey: "rest"); stage.root.opacity = restingOpacity; cursorResting = true
    CATransaction.flush()
}
func showBadge(_ show: Bool) throws {
    // Shown between programs (dimmed, without the input lease): the next program takes the lease again.
    if show && badge?.isVisible == true { try acquireLease(); return }
    if !show && cursorProgram { return }
    if let panel = badge {
        // The main thread sits in readLine() between requests, so the window server only learns the canvas is gone if the run loop
        // turns once here: without it the helper answered "hidden" and the cursor stayed on screen.
        panel.orderOut(nil); stopEffects(); cursorStage?.root.removeFromSuperlayer(); CATransaction.flush()
        RunLoop.current.run(until: Date(timeIntervalSinceNow: 0.01))
    }
    badge = nil; cursorStage = nil; cursorResting = false
    guard show else { releaseLease(); return }
    try acquireLease()
    if canvas == nil { canvas = makeCanvas() }
    let stage = CursorStage()
    canvasLayer()?.addSublayer(stage.root)
    cursorStage = stage; badge = canvas
    let mouse = NSEvent.mouseLocation
    let initial = cursorLocation ?? CGPoint(x: mouse.x, y: (NSScreen.screens.first?.frame.maxY ?? 0) - mouse.y)
    presentCursor(initial, label: "MendCode")
    keepAbove(force: true)
    canvas?.displayIfNeeded()
    RunLoop.current.run(until: Date(timeIntervalSinceNow: 0.01))
}
// Chromium (Chrome, Brave, Edge, Electron apps) offers a page's own actions only once an assistive app asks for them, and a
// click posted to its process never reaches the page (measured in Chrome, in front and behind: links offered no AXPress,
// and neither a posted click nor AXPress changed the page). After this attribute, the one VoiceOver sets, links and buttons
// offer AXPress about 2 s later and it works with the window behind others. It is cleared when the app's last session ends.
let enhancedInterface = "AXEnhancedUserInterface"
// Electron builds its page tree only when this one is set (Chromium alone answers to the one above).
let manualAccessibility = "AXManualAccessibility"
/** What this helper switched on for each app, so that only those are cleared when the last session ends. */
var webAccessibility: [pid_t: [String]] = [:]
/** A window tree this small has not shown its web content: a page offers links or buttons once exposed. Decision only. */
func poorTree(count: Int, hasProbe: Bool) -> Bool { !hasProbe && count <= 12 }
/** How a key reaches an app: through its node when that can be focused safely, to the app when nothing safe is focused, never past a secure field. Decision only. */
func keyRoute(nodeFocusable: Bool, focusedSecure: Bool, focusedOutside: Bool) -> String {
    if nodeFocusable { return "node" }
    return focusedSecure || focusedOutside ? "refuse" : "app"
}
func enableWebAccessibility(_ pid: pid_t, names: [String] = [enhancedInterface]) -> Bool {
    let app = AXUIElementCreateApplication(pid)
    var switched = webAccessibility[pid] ?? []
    for name in names where !switched.contains(name) {
        // Already on (VoiceOver is running): not ours to switch, or to clear later.
        if (attribute(app, name) as? Bool) == true { continue }
        // Chrome answers "not implemented" and switches anyway.
        _ = AXUIElementSetAttributeValue(app, name as CFString, kCFBooleanTrue)
        switched.append(name)
    }
    let added = switched.count != (webAccessibility[pid]?.count ?? 0)
    if !switched.isEmpty { webAccessibility[pid] = switched }
    return added
}
func restoreWebAccessibility(_ pid: pid_t) {
    guard let names = webAccessibility.removeValue(forKey: pid) else { return }
    for name in names { _ = AXUIElementSetAttributeValue(AXUIElementCreateApplication(pid), name as CFString, kCFBooleanFalse) }
}
func pressable(_ element: AXUIElement) -> Bool {
    var supported: CFArray?
    AXUIElementCopyActionNames(element, &supported)
    return (supported as? [String] ?? []).contains(kAXPressAction)
}
func observe(_ target: Object) throws -> Object {
    let (running, _, window) = try selected(target, foreground: false)
    var snapshot = walkWindow(window, pid: running.processIdentifier)
    if let probe = snapshot.webProbe, !pressable(probe), enableWebAccessibility(running.processIdentifier) {
        // The first look at a page waits for its actions, so a click in the same program can already use them.
        let deadline = Date(timeIntervalSinceNow: 3)
        while !pressable(probe) && Date() < deadline && !cancelled { RunLoop.current.run(until: Date(timeIntervalSinceNow: 0.05)) }
        _ = try selected(target, foreground: false)
        snapshot = walkWindow(window, pid: running.processIdentifier)
    } else if poorTree(count: snapshot.nodes.count, hasProbe: snapshot.webProbe != nil), enableWebAccessibility(running.processIdentifier, names: [enhancedInterface, manualAccessibility]) {
        // A webview (Tauri, WebKit, Electron) shows its content only once an assistive app asks: look again while it builds the tree.
        let deadline = Date(timeIntervalSinceNow: 2)
        while Date() < deadline && !cancelled {
            RunLoop.current.run(until: Date(timeIntervalSinceNow: 0.25))
            _ = try selected(target, foreground: false)
            snapshot = walkWindow(window, pid: running.processIdentifier)
            if !poorTree(count: snapshot.nodes.count, hasProbe: snapshot.webProbe != nil) { break }
        }
    }
    _ = try selected(target, foreground: false)
    return ["nodes": snapshot.nodes, "truncated": snapshot.truncated]
}
/** The window's bounded tree; `webProbe` is a link or button of a web page in it, which offers AXPress once the page's actions are on. */
func walkWindow(_ window: AXUIElement, pid: pid_t) -> (nodes: [Object], truncated: Bool, webProbe: AXUIElement?) {
    references.removeAll()
    var nodes: [Object] = [], bytes = 0, truncated = false, visited: [AXUIElement] = [], webProbe: AXUIElement?
    func walk(_ element: AXUIElement, depth: Int, inheritedSecure: Bool, inWeb: Bool) {
        if nodes.count >= 500 || depth > observeDepth || bytes >= 58_000 { truncated = true; return }
        if visited.contains(where: { CFEqual($0, element) }) { return }
        visited.append(element)
        AXUIElementSetMessagingTimeout(element, 0.3)
        let info = readNode(element, children: true), role = info.role
        // The walk starts at the window and carries a secure ancestor down, so the node's own role completes the check.
        let isSecure = inheritedSecure || role == "AXSecureTextField" || info.subrole == "AXSecureTextField", isEnabled = info.enabled
        let inPage = inWeb || role == "AXWebArea"
        if inPage && webProbe == nil && ["AXLink", "AXButton"].contains(role) { webProbe = element }
        let name = info.title.isEmpty ? info.description : info.title
        nodeCounter += 1; let id = "0.\(nodeCounter)"
        var actions: [String] = []
        if isEnabled && !isSecure {
            var supported: CFArray?
            AXUIElementCopyActionNames(element, &supported)
            if (supported as? [String] ?? []).contains(kAXPressAction) { actions.append("press") }
            let textual = ["AXTextField", "AXTextArea", "AXComboBox"].contains(role)
            var writable = DarwinBoolean(false)
            if textual && AXUIElementIsAttributeSettable(element, kAXValueAttribute as CFString, &writable) == .success && writable.boolValue { actions.append("setValue") }
            if info.bounds != nil {
                actions += ["click", "key", "scroll", "drag"]
                if textual { actions.append("typeText") }
            }
        }
        var node: Object = ["id": id, "role": clipped(role), "name": isSecure ? "" : clipped(name), "states": (isEnabled ? ["enabled"] : []) + (info.focused ? ["focused"] : []), "actions": actions]
        let value = isSecure ? "" : text(element, kAXValueAttribute)
        if isSecure { node["secure"] = true; node["states"] = ["secure"] }
        else if !value.isEmpty { node["value"] = clipped(value) }
        if let rect = info.bounds { node["bounds"] = rectObject(rect) }
        let length = (try? JSONSerialization.data(withJSONObject: node).count) ?? 0
        if bytes + length > 58_000 { truncated = true; return }
        bytes += length; nodes.append(node)
        if isSecure { return }
        references[id] = Reference(element: element, signature: signature(info, value: value), stable: signature(info, value: nil), window: window, pid: pid)
        for child in info.children { if nodes.count >= 500 || bytes >= 58_000 { truncated = true; break }; walk(child, depth: depth + 1, inheritedSecure: isSecure, inWeb: inPage) }
    }
    walk(window, depth: 0, inheritedSecure: false, inWeb: false)
    return (nodes, truncated, webProbe)
}
/** Strict re-resolution right before an effect: the retained object, its window and ancestry, and its signature (`stable` leaves the value out). */
func validateReference(_ ref: Reference, target: Object, foreground: Bool = true, stable: Bool = false) throws {
    let (running, _, window) = try selected(target, foreground: foreground)
    guard ref.pid == running.processIdentifier, CFEqual(ref.window, window), descendant(ref.element, of: window), !secure(ref.element), enabled(ref.element), stable ? fingerprint(ref.element, value: false) == ref.stable : fingerprint(ref.element) == ref.signature else { try fail("Semantic node changed, is secure, or is stale; observe again") }
}
func reference(_ id: String, target: Object, foreground: Bool = true) throws -> Reference {
    guard let ref = references[id] else { try fail("Semantic node is stale; observe again") }
    try validateReference(ref, target: target, foreground: foreground)
    return ref
}
enum PointerPlan<Element> { case press(Element), post, covered(Element?) }
// The page, a scroll view or the window: landing on one of these is not landing on the node.
let pointerContainers: Set<String> = ["AXApplication", "AXWindow", "AXSheet", "AXDrawer", "AXWebArea", "AXScrollArea", "AXSplitGroup"]
// A click here is not what AXPress does (it places the caret, or moves to the point), so pointer events stay.
let pointerOnly: Set<String> = ["AXTextField", "AXTextArea", "AXComboBox", "AXSearchField", "AXSecureTextField", "AXSlider", "AXIncrementor", "AXScrollBar", "AXValueIndicator"]
/**
 * What a pointer action at a node's center reaches. `hit` is what the app reports under the pointer and its ancestors, nearest first;
 * `node` is the node and its ancestors; `under` is the node's own descendants under the point, deepest first. The pointer reaches the
 * node when it lands inside it, or on one of its three nearest ancestors below the page or window (Chromium answers a label's center
 * with the label's link, and an unnamed list item's with its parent). Anything else covers the node.
 * A plain click becomes AXPress on the element the pointer would activate, from the point outwards: a click posted to a Chromium
 * process never reaches the page, and AXPress reaches a window behind others. A text field or slider on the way keeps pointer events.
 */
func pointerPlan<Element>(hit: [Element], node: [Element], under: [Element], same: (Element, Element) -> Bool, role: (Element) -> String, pressable: (Element) -> Bool, click: Bool) -> PointerPlan<Element> {
    guard let first = hit.first, let target = node.first else { return .covered(nil) }
    let near = Array(node.dropFirst().prefix(3).prefix(while: { !pointerContainers.contains(role($0)) }))
    let path: [Element]
    // When the app answers with the node itself, what is drawn under the point inside it is found by bounds.
    if let inside = hit.firstIndex(where: { same($0, target) }) { path = (inside == 0 ? under : []) + Array(hit[...inside]) + near }
    else if let index = near.firstIndex(where: { same($0, first) }) { path = under + [target] + Array(near[...index]) }
    else { return .covered(first) }
    guard click else { return .post }
    for element in path {
        if pointerOnly.contains(role(element)) { return .post }
        if pressable(element) { return .press(element) }
    }
    return .post
}
func ancestry(_ element: AXUIElement) -> [AXUIElement] {
    var chain: [AXUIElement] = [], current: AXUIElement? = element
    while let node = current, chain.count < ancestryLimit { chain.append(node); current = elementAttribute(node, kAXParentAttribute) }
    return chain
}
/** The node's descendants whose bounds hold the point, deepest first; the last such child is the one drawn on top. */
func descendants(of element: AXUIElement, at point: CGPoint) -> [AXUIElement] {
    var chain: [AXUIElement] = [], current = element
    for _ in 0..<12 {
        guard let child = (attribute(current, kAXChildrenAttribute) as? [AXUIElement] ?? []).prefix(256).last(where: { bounds($0)?.contains(point) == true }) else { break }
        chain.insert(child, at: 0); current = child
    }
    return chain
}
func label(_ element: AXUIElement) -> String {
    let name = [kAXTitleAttribute, kAXDescriptionAttribute].map { text(element, $0) }.first { !$0.isEmpty } ?? (text(element, kAXRoleAttribute) == "AXStaticText" ? text(element, kAXValueAttribute) : "")
    return String(clipped(name).prefix(80))
}
/** What covers a node, as the model sees nodes: role and name, or the nearest named container of an unnamed element. */
func describe(_ element: AXUIElement) -> String {
    if secure(element) { return "a secure field" }
    let role = text(element, kAXRoleAttribute).isEmpty ? "an unknown element" : text(element, kAXRoleAttribute)
    if !label(element).isEmpty { return "\(role) \"\(label(element))\"" }
    guard let named = ancestry(element).dropFirst().prefix(3).first(where: { !label($0).isEmpty }) else { return role }
    return "\(role) in \(text(named, kAXRoleAttribute)) \"\(label(named))\""
}
func coveredMessage(_ found: AXUIElement?, ref: Reference) -> String {
    let advice = "no input was sent. Use press if the node offers it, or close or scroll away what covers it, then observe again"
    guard let found = found else { return "Nothing accessible answers at the node's center; \(advice)" }
    var pid: pid_t = 0
    AXUIElementGetPid(found, &pid)
    if pid != ref.pid { return "Another app's window covers the node's center (\(describe(found))); \(advice)" }
    if let window = elementAttribute(found, kAXWindowAttribute), !CFEqual(window, ref.window) { return "Another window of this app covers the node's center (\(describe(found))); \(advice)" }
    return "The pointer would hit \(describe(found)) at the node's center, not the node; \(advice)"
}
/** Where a pointer action lands, and whether a plain click is AXPress there instead. Throws when something else covers the node. */
func hit(_ point: CGPoint, ref: Reference, click: Bool = false) throws -> AXUIElement? {
    // The visual overlay is never accepted as input evidence or an AX hit target.
    let overlay = badge, visible = overlay?.isVisible == true
    overlay?.orderOut(nil); stopEffects()
    defer { if visible && !cancelled { keepAbove(force: true) } }
    // In front, the screen decides what the pointer would hit; in the background, the app's own window does (what covers it is
    // another app's, and the event goes to this process only).
    let inFront = frontmost()?.processIdentifier == ref.pid
    let scope = inFront ? AXUIElementCreateSystemWide() : AXUIElementCreateApplication(ref.pid); var found: AXUIElement?
    guard AXUIElementCopyElementAtPosition(scope, Float(point.x), Float(point.y), &found) == .success, let element = found else { try fail(coveredMessage(nil, ref: ref)) }
    if secure(element) { try fail("A secure field is under the node's center; no input was sent") }
    let plan = pointerPlan(hit: ancestry(element), node: ancestry(ref.element), under: descendants(of: ref.element, at: point), same: { CFEqual($0, $1) }, role: { text($0, kAXRoleAttribute) }, pressable: { enabled($0) && !secure($0) && pressable($0) }, click: click)
    switch plan {
    case .covered(let found): try fail(coveredMessage(found, ref: ref))
    case .press(let element): return element
    case .post: return nil
    }
}
func shown(_ element: AXUIElement, at point: CGPoint) -> Bool {
    ancestry(element).dropFirst().filter { ["AXScrollArea", "AXWebArea", "AXWindow"].contains(text($0, kAXRoleAttribute)) }.allSatisfy { bounds($0)?.contains(point) ?? true }
}
/** A node scrolled out of its scroll area, page or window is brought into view when it offers AXScrollToVisible (web pages do). */
func reveal(_ ref: Reference) -> (rect: CGRect, shown: Bool)? {
    guard let rect = bounds(ref.element) else { return nil }
    if shown(ref.element, at: CGPoint(x: rect.midX, y: rect.midY)) { return (rect, true) }
    var supported: CFArray?
    AXUIElementCopyActionNames(ref.element, &supported)
    guard (supported as? [String] ?? []).contains("AXScrollToVisible"), AXUIElementPerformAction(ref.element, "AXScrollToVisible" as CFString) == .success else { return (rect, false) }
    RunLoop.current.run(until: Date(timeIntervalSinceNow: 0.2))
    guard let moved = bounds(ref.element) else { return (rect, false) }
    return (moved, shown(ref.element, at: CGPoint(x: moved.midX, y: moved.midY)))
}
func focus(_ ref: Reference) throws {
    let ax = AXUIElementCreateApplication(ref.pid)
    if let focused = elementAttribute(ax, kAXFocusedUIElementAttribute), descendant(focused, of: ref.element), !secure(focused) { return }
    guard AXUIElementSetAttributeValue(ref.element, kAXFocusedAttribute as CFString, kCFBooleanTrue) == .success, let focused = elementAttribute(ax, kAXFocusedUIElementAttribute), descendant(focused, of: ref.element), !secure(focused) else { try fail("Cannot safely focus this node for keyboard input") }
}
/** A key goes to the node when it can be focused; otherwise to the app, as long as no secure field or element outside the window holds the focus. */
func focusForKey(_ ref: Reference) throws {
    do { try focus(ref) } catch {
        let focused = elementAttribute(AXUIElementCreateApplication(ref.pid), kAXFocusedUIElementAttribute)
        let route = keyRoute(nodeFocusable: false, focusedSecure: focused.map { secure($0) } ?? false, focusedOutside: focused.map { !descendant($0, of: ref.window) } ?? false)
        if route != "app" { throw error }
    }
}
/** A pointer event for a window that may be behind others: it names the app's window under the point, so the app takes it as its own. */
func aim(_ event: CGEvent?, at point: CGPoint, pid: pid_t) {
    guard let event = event, let windows = CGWindowListCopyWindowInfo([.optionAll, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else { return }
    for info in windows {
        guard (info[kCGWindowOwnerPID as String] as? Int).map(pid_t.init) == pid, (info[kCGWindowLayer as String] as? Int) == 0,
              let frame = info[kCGWindowBounds as String] as? [String: Any], let rect = CGRect(dictionaryRepresentation: frame as CFDictionary), rect.contains(point),
              let number = info[kCGWindowNumber as String] as? Int else { continue }
        if let under = CGEventField(rawValue: 91), let handles = CGEventField(rawValue: 92) {
            event.setIntegerValueField(under, value: Int64(number)); event.setIntegerValueField(handles, value: Int64(number))
        }
        return
    }
}
func post(_ event: CGEvent?, pid: pid_t) throws {
    guard let event = event else { try fail("Cannot create native input event") }
    effect(); event.postToPid(pid)
}
let keyCodes: [String: CGKeyCode] = ["tab":48,"escape":53,"enter":36,"space":49,"left":123,"right":124,"down":125,"up":126,"backspace":51,"delete":117,"home":115,"end":119,"pageUp":116,"pageDown":121,"a":0,"c":8,"v":9,"x":7,"z":6,"s":1,"f":3,"l":37,"n":45,"w":13]
func flags(_ names: [String]) -> CGEventFlags {
    names.reduce(CGEventFlags()) { result, name in result.union(["command": .maskCommand, "shift": .maskShift, "option": .maskAlternate, "control": .maskControl][name] ?? []) }
}
/** One action on observed nodes. `stable` and `destinationStable` mark a node an earlier step of the same batch acted on. */
struct Step { let name: String; let input: Object; let nodeID: String; let ref: Reference; let destination: Reference?; var stable = false; var destinationStable = false }
func resolve(_ input: Object, target: Object) throws -> Step {
    guard let id = input["nodeID"] as? String, let name = input["action"] as? String else { try fail("Invalid action") }
    // AXPress and AXSetValue are delivered to the element itself; every other action is an event posted to the approved process,
    // so none needs the app in front and none raises it or moves the user's own pointer.
    let ref = try reference(id, target: target, foreground: false)
    var destination: Reference?
    if name == "drag" {
        guard let to = input["toNodeID"] as? String else { try fail("Drag requires a destination node") }
        destination = try reference(to, target: target, foreground: false)
    }
    return Step(name: name, input: input, nodeID: id, ref: ref, destination: destination)
}
func action(_ target: Object, input: Object) throws -> Object {
    guard badge?.isVisible == true, lease >= 0 else { try fail("Visible control indicator or input lease is missing") }
    let step = try resolve(input, target: target)
    // Consume all handles before effects, including partial failures.
    references.removeAll()
    try perform(step, target: target)
    return ["dispatched": true]
}
let batchLimit = 16
/**
 * Several actions on one observation in one request, as agent-desktop's batch runs commands on refs held from one snapshot
 * (src/batch/execution.rs, Apache-2.0): every step is resolved before the first one runs, so a stale or unknown node refuses the whole
 * batch with nothing sent, and each step is resolved again right before its own effect. Unlike agent-desktop's default, the first step
 * that fails stops the batch, and the steps after it do not start. A node an earlier step acted on is compared without its value.
 */
func batch(_ target: Object, steps: [Object]) throws -> [Object] {
    guard badge?.isVisible == true, lease >= 0 else { try fail("Visible control indicator or input lease is missing") }
    guard (1...batchLimit).contains(steps.count) else { try fail("A batch holds 1 to \(batchLimit) steps") }
    let resolved = try steps.map { try resolve($0, target: target) }
    references.removeAll()
    instantTravel = true
    defer { instantTravel = false }
    var results: [Object] = [], acted = Set<String>(), posted = false
    for (index, var step) in resolved.enumerated() {
        effectStarted = false
        // Events posted to the app wait in its queue: it takes them before the next step reaches it, perhaps another way (AXPress).
        if posted { RunLoop.current.run(until: Date(timeIntervalSinceNow: 0.05)) }
        let destination = step.input["toNodeID"] as? String
        step.stable = acted.contains(step.nodeID)
        step.destinationStable = destination.map(acted.contains) ?? false
        do { try perform(step, target: target) }
        catch {
            results.append(["index": index, "outcome": effectStarted ? "unknown" : "failed", "error": (error as? Failure)?.message ?? "Native computer operation failed"])
            break
        }
        results.append(["index": index, "outcome": "dispatched"])
        acted.insert(step.nodeID); if let destination = destination { acted.insert(destination) }
        posted = !["press", "setValue"].contains(step.name)
    }
    effectStarted = false
    return results
}
func perform(_ step: Step, target: Object) throws {
    let ref = step.ref, input = step.input, name = step.name, destination = step.destination, foreground = false
    let labels = ["press": "Press", "setValue": "Text", "typeText": "Typing", "key": "Key", "scroll": "Scroll", "drag": "Drag", "click": input["button"] as? String == "right" ? "Right click" : input["count"] as? Int == 2 ? "Double click" : "Click"]
    let label = labels[name] ?? "Control"
    // A resting cursor comes back before anything is sent, also for a node it does not travel to.
    if cursorResting, let point = cursorLocation { presentCursor(point) }
    if let rect = bounds(ref.element) { try animateCursor(to: CGPoint(x: rect.midX, y: rect.midY), label: label) }
    try validateReference(ref, target: target, foreground: foreground, stable: step.stable)
    if name == "press" {
        effect()
        guard AXUIElementPerformAction(ref.element, kAXPressAction as CFString) == .success else { try fail("AXPress failed; inspect the target before retrying") }
        cursorEffect(click: true, around: bounds(ref.element))
        return
    }
    if name == "setValue" {
        guard ["AXTextField", "AXTextArea", "AXComboBox"].contains(text(ref.element, kAXRoleAttribute)), let value = input["value"] as? String else { try fail("Not a writable text node") }
        // The caret moves only while the app is in front: moving AX focus inside a background app is not needed to set a value, and is not ours to do.
        if frontmost()?.processIdentifier == ref.pid { try focus(ref) }
        _ = try selected(target, foreground: false)
        effect()
        guard AXUIElementSetAttributeValue(ref.element, kAXValueAttribute as CFString, value as CFString) == .success else { try fail("AXSetValue failed; inspect the target before retrying") }
        let deadline = Date(timeIntervalSinceNow: 1)
        while text(ref.element, kAXValueAttribute) != value && Date() < deadline {
            _ = try selected(target, foreground: false)
            if secure(ref.element) { try fail("Text field became secure; write result is unknown") }
            RunLoop.current.run(until: Date(timeIntervalSinceNow: 0.05))
        }
        guard text(ref.element, kAXValueAttribute) == value else { try fail("AXSetValue was accepted but its value was not confirmed; observe before retrying") }
        cursorEffect(click: false, around: bounds(ref.element))
        return
    }
    if name == "key" || name == "typeText" {
        if name == "key" { try focusForKey(ref) } else { try focus(ref) }
        _ = try selected(target, foreground: false)
        if name == "key" {
            guard let key = input["key"] as? String, let code = keyCodes[key] else { try fail("Unsupported key") }
            let modifiers = flags(input["modifiers"] as? [String] ?? [])
            let down = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: true), up = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: false)
            down?.flags = modifiers; up?.flags = modifiers
            try post(down, pid: ref.pid); try post(up, pid: ref.pid)
        } else {
            guard ["AXTextField", "AXTextArea", "AXComboBox"].contains(text(ref.element, kAXRoleAttribute)), let value = input["value"] as? String else { try fail("Not a text input") }
            // No pasteboard: Unicode is targeted to the approved process.
            let units = Array(value.utf16)
            var start = 0
            while start < units.count {
                _ = try selected(target, foreground: false)
                guard let focused = elementAttribute(AXUIElementCreateApplication(ref.pid), kAXFocusedUIElementAttribute), descendant(focused, of: ref.element), !secure(focused) else { try fail("Keyboard focus changed during typing; result may be partial") }
                var end = min(start + 128, units.count)
                if end < units.count && units[end - 1] >= 0xD800 && units[end - 1] <= 0xDBFF { end -= 1 }
                let chunk = Array(units[start..<end])
                let down = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: true), up = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: false)
                chunk.withUnsafeBufferPointer { buffer in down?.keyboardSetUnicodeString(stringLength: buffer.count, unicodeString: buffer.baseAddress!); up?.keyboardSetUnicodeString(stringLength: buffer.count, unicodeString: buffer.baseAddress!) }
                try post(down, pid: ref.pid); try post(up, pid: ref.pid)
                start = end
            }
        }
        cursorEffect(click: false, around: bounds(ref.element))
        return
    }
    guard let (rect, onScreen) = reveal(ref) else { try fail("Node has no screen bounds") }
    let point = CGPoint(x: rect.midX, y: rect.midY)
    let plainClick = name == "click" && input["button"] as? String != "right" && (input["count"] as? Int ?? 1) == 1
    let pressed: AXUIElement?
    if onScreen {
        if point != cursorLocation { try animateCursor(to: point, label: label) }
        pressed = try hit(point, ref: ref, click: plainClick)
    } else if plainClick && pressable(ref.element) && !pointerOnly.contains(text(ref.element, kAXRoleAttribute)) {
        // Nothing can cover what is out of view, and AXPress needs no point.
        pressed = ref.element
    } else { try fail("The node's center is outside the visible part of its scroll area or window; no input was sent. Scroll the area that holds it, observe again, then act") }
    _ = try selected(target, foreground: false)
    if let element = pressed {
        effect()
        guard AXUIElementPerformAction(element, kAXPressAction as CFString) == .success else { try fail("AXPress on the clicked element failed; observe before retrying") }
        cursorEffect(click: true, around: rect)
        return
    }
    if name == "scroll" {
        let amount = min(1000, max(1, input["amount"] as? Int ?? 300)), direction = input["direction"] as? String ?? "down"
        let vertical = direction == "up" ? amount : direction == "down" ? -amount : 0
        let horizontal = direction == "left" ? amount : direction == "right" ? -amount : 0
        let event = CGEvent(scrollWheelEvent2Source: nil, units: .pixel, wheelCount: 2, wheel1: Int32(vertical), wheel2: Int32(horizontal), wheel3: 0)
        event?.location = point; aim(event, at: point, pid: ref.pid); try post(event, pid: ref.pid)
        cursorEffect(click: false, around: rect)
        return
    }
    let right = input["button"] as? String == "right", button: CGMouseButton = right ? .right : .left
    let downType: CGEventType = right ? .rightMouseDown : .leftMouseDown, upType: CGEventType = right ? .rightMouseUp : .leftMouseUp
    if name == "click" {
        for count in 1...min(2, max(1, input["count"] as? Int ?? 1)) {
            _ = try selected(target, foreground: false); _ = try hit(point, ref: ref)
            let down = CGEvent(mouseEventSource: nil, mouseType: downType, mouseCursorPosition: point, mouseButton: button), up = CGEvent(mouseEventSource: nil, mouseType: upType, mouseCursorPosition: point, mouseButton: button)
            aim(down, at: point, pid: ref.pid); aim(up, at: point, pid: ref.pid)
            down?.setIntegerValueField(.mouseEventClickState, value: Int64(count)); up?.setIntegerValueField(.mouseEventClickState, value: Int64(count))
            try post(down, pid: ref.pid); try post(up, pid: ref.pid)
        }
        cursorEffect(click: true, around: rect)
        return
    }
    if name == "drag", let destination = destination, let endRect = bounds(destination.element) {
        let end = CGPoint(x: endRect.midX, y: endRect.midY)
        try validateReference(destination, target: target, foreground: false, stable: step.destinationStable)
        _ = try hit(end, ref: destination)
        trailBegin(point, to: end)
        try post(CGEvent(mouseEventSource: nil, mouseType: .leftMouseDown, mouseCursorPosition: point, mouseButton: .left), pid: ref.pid)
        var current = point
        defer {
            CGEvent(mouseEventSource: nil, mouseType: .leftMouseUp, mouseCursorPosition: current, mouseButton: .left)?.postToPid(ref.pid)
            presentCursor(current, label: "Dropped")
            trailEnd(fade: true)
            cursorEffect(click: true, around: nil)
        }
        for step in 1...18 {
            _ = try selected(target, foreground: false)
            let t = Double(step) / 18, eased = t * t * (3 - 2 * t)
            current = CGPoint(x: point.x + (end.x - point.x) * eased, y: point.y + (end.y - point.y) * eased)
            try post(CGEvent(mouseEventSource: nil, mouseType: .leftMouseDragged, mouseCursorPosition: current, mouseButton: .left), pid: ref.pid)
            presentCursor(current, label: "Dragging")
            trailAppend(current)
            RunLoop.current.run(until: Date(timeIntervalSinceNow: 1 / 60))
        }
        return
    }
    try fail("Unsupported native action")
}
func dispatch(_ request: Object) throws -> Any {
    guard let name = request["method"] as? String else { try fail("Missing method") }
    let target = request["target"] as? Object ?? [:]
    switch name {
    case "ping":
        // Who answers and whether macOS lets it control apps; never prompts. `request` is the explicit setup step: list the app and open the pane.
        if request["request"] as? Bool == true, !AXIsProcessTrusted() { askForAccessibility() }
        return ["pid": Int(getpid()), "trusted": AXIsProcessTrusted()]
    case "foreground":
        try trusted()
        guard let running = frontmost(), running.bundleIdentifier != nil else { try fail("No identifiable foreground app") }
        return targetObject(running)
    case "apps":
        CFRunLoopRunInMode(.defaultMode, 0, false)
        return NSWorkspace.shared.runningApplications.filter { $0.activationPolicy == .regular && $0.bundleIdentifier != nil }.prefix(128).map { ["pid": Int($0.processIdentifier), "bundleID": $0.bundleIdentifier!, "appName": clipped($0.localizedName ?? "")] as Object }
    case "resolve":
        guard let bundle = request["bundleID"] as? String else { try fail("Missing bundle ID") }
        CFRunLoopRunInMode(.defaultMode, 0, false)
        if let running = NSRunningApplication.runningApplications(withBundleIdentifier: bundle).first { return ["pid": Int(running.processIdentifier), "bundleID": bundle, "appName": clipped(running.localizedName ?? "")] }
        guard let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: bundle), let installed = Bundle(url: url), installed.bundleIdentifier == bundle else { try fail("Application is not installed") }
        return ["pid": 0, "bundleID": bundle, "appName": clipped(installed.object(forInfoDictionaryKey: "CFBundleDisplayName") as? String ?? installed.object(forInfoDictionaryKey: "CFBundleName") as? String ?? bundle)]
    case "activate":
        try trusted()
        guard badge?.isVisible == true, lease >= 0 else { try fail("Application activation requires an input lease and visible indicator") }
        guard let bundle = target["bundleID"] as? String else { try fail("Missing bundle ID") }
        // Never brings the app to the front: a running app is only identified, and a missing one is launched in the background (open -g).
        var launched: NSRunningApplication?, fresh = false
        if (target["pid"] as? Int ?? 0) > 0 { launched = try running(target, foreground: false) }
        else {
            guard let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: bundle) else { try fail("Application is not installed") }
            let configuration = NSWorkspace.OpenConfiguration(); configuration.activates = false
            var finished = false, launchError: Error?
            effect()
            NSWorkspace.shared.openApplication(at: url, configuration: configuration) { result, error in launched = result; launchError = error; finished = true }
            let deadline = Date(timeIntervalSinceNow: 8)
            while !finished && Date() < deadline { RunLoop.current.run(until: Date(timeIntervalSinceNow: 0.02)) }
            if launchError != nil || !finished { try fail("Application launch failed or timed out; it may have opened. Inspect before retrying.") }
            fresh = true
        }
        guard let launched = launched, launched.bundleIdentifier == bundle else { try fail("Cannot open approved application") }
        _ = try running(["pid": Int(launched.processIdentifier), "bundleID": bundle], foreground: false)
        // A new process takes a moment to create its first window; the session binds to that window.
        if fresh {
            let deadline = Date(timeIntervalSinceNow: 3)
            while targetObject(launched)["windowID"] == nil && Date() < deadline { RunLoop.current.run(until: Date(timeIntervalSinceNow: 0.05)) }
        }
        if let point = cursorLocation { presentCursor(point, label: "Opened") }
        return targetObject(launched)
    case "windows":
        let running = try running(target, foreground: false); try trusted()
        let ax = AXUIElementCreateApplication(running.processIdentifier)
        let windows = attribute(ax, kAXWindowsAttribute) as? [AXUIElement] ?? []
        return windows.prefix(64).map { window -> Object in
            var result: Object = ["id": handle(window, pid: running.processIdentifier), "name": clipped(text(window, kAXTitleAttribute))]
            if let rect = bounds(window) { result["bounds"] = rectObject(rect) }; return result
        }
    case "selectWindow":
        try trusted()
        guard badge?.isVisible == true, lease >= 0 else { try fail("Window selection requires an input lease and visible indicator") }
        let running = try running(target)
        guard let id = request["windowID"] as? String, let window = windowHandles[id], windowPIDs[id] == running.processIdentifier else { try fail("Unknown window handle") }
        let ax = AXUIElementCreateApplication(running.processIdentifier)
        guard (attribute(ax, kAXWindowsAttribute) as? [AXUIElement] ?? []).contains(where: { CFEqual($0, window) }) else { try fail("Window closed") }
        references.removeAll()
        if let rect = bounds(window) { try animateCursor(to: CGPoint(x: rect.midX, y: rect.midY), label: "Window") }
        if cancelled || running.isTerminated || frontmost()?.processIdentifier != running.processIdentifier { try fail("Application changed during window selection; no window was raised") }
        effect()
        guard AXUIElementPerformAction(window, kAXRaiseAction as CFString) == .success else { try fail("Cannot raise window") }
        _ = AXUIElementSetAttributeValue(window, kAXMainAttribute as CFString, kCFBooleanTrue)
        let result = targetObject(running)
        guard result["windowID"] as? String == id else { try fail("Window focus was not confirmed") }; return result
    case "identify":
        // Null, not an error, when the approved process ended or its bundle ID differs: the caller ends the session.
        try trusted()
        guard let running = alive(target) else { return NSNull() }
        return targetObject(running)
    case "observe": return try observe(target)
    case "batch": return try batch(target, steps: request["steps"] as? [Object] ?? [])
    case "action": return try action(target, input: request["input"] as? Object ?? [:])
    case "navigation":
        try trusted()
        guard let pid = request["pid"] as? Int, let current = frontmost(), Int(current.processIdentifier) == pid else { try fail("Foreground application changed; capture again") }
        let target = targetObject(current)
        let (_, ax, window) = try selected(target)
        guard let focused = elementAttribute(ax, kAXFocusedUIElementAttribute), !secure(focused), descendant(focused, of: window) else { try fail("Cannot send a key to a secure or unknown focused element") }
        nodeCounter += 1; let id = "0.\(nodeCounter)"
        references[id] = retain(focused, window: window, pid: current.processIdentifier)
        return try action(target, input: ["nodeID": id, "action": "key", "key": request["key"] as? String ?? ""])
    case "program":
        if request["active"] as? Bool == true {
            guard !cursorProgram else { try fail("Another native computer program is running") }
            _ = try running(target, foreground: false)
            try showBadge(true); cursorProgram = true
        } else {
            // The cursor stays where it last went until the session ends (`release`); only the input lease is given back now.
            cursorProgram = false; releaseLease(); cursorActiveAt = min(cursorActiveAt, uptime() - 6)
        }
        return ["active": cursorProgram]
    case "indicator": try showBadge(request["visible"] as? Bool == true); return ["visible": badge?.isVisible == true]
    case "release":
        references.removeAll()
        let pid = pid_t(target["pid"] as? Int ?? 0)
        for id in Array(windowHandles.keys) where windowPIDs[id] == pid { windowHandles.removeValue(forKey: id); windowPIDs.removeValue(forKey: id) }
        restoreWebAccessibility(pid)
        if !cursorProgram { try? showBadge(false) }
        return ["released": true]
    default: try fail("Unknown native method")
    }
}
// Visual-only acceptance: the exact overlay renderer, without AX or input events.
func runCursorDemo() throws {
    guard NSScreen.screens.first != nil else { try fail("Cursor demo requires a graphical macOS session") }
    app.setActivationPolicy(.regular)
    let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 620, height: 360), styleMask: [.titled, .closable], backing: .buffered, defer: false)
    window.title = "MendCode · virtual cursor demo"
    window.isReleasedWhenClosed = false; window.center()
    let title = NSTextField(labelWithString: "Virtual cursor · no real input")
    title.font = .systemFont(ofSize: 22, weight: .semibold); title.frame = NSRect(x: 30, y: 278, width: 560, height: 32)
    let subtitle = NSTextField(wrappingLabelWithString: "Only this demo window is opened. Movement, click ripples, outlines and the drag trail are visual simulations; no browser, clipboard or user application is controlled.")
    subtitle.frame = NSRect(x: 30, y: 217, width: 550, height: 50)
    window.contentView?.addSubview(title); window.contentView?.addSubview(subtitle)
    let labels = ["Search", "Save", "Drag here"]
    var points: [CGPoint] = [], frames: [CGRect] = []
    for (index, label) in labels.enumerated() {
        let button = NSButton(title: label, target: nil, action: nil)
        button.bezelStyle = .rounded; button.frame = NSRect(x: 40 + index * 190, y: 130, width: 155, height: 44)
        window.contentView?.addSubview(button)
        let screen = window.convertToScreen(button.frame), top = NSScreen.screens.first?.frame.maxY ?? 0
        frames.append(CGRect(x: screen.minX, y: top - screen.maxY, width: screen.width, height: screen.height))
        points.append(CGPoint(x: frames[index].midX, y: frames[index].midY))
    }
    window.makeKeyAndOrderFront(nil); app.activate(ignoringOtherApps: true)
    RunLoop.current.run(until: Date(timeIntervalSinceNow: 0.15))
    cursorLocation = points[0]
    try showBadge(true)
    anchorWindow = CGWindowID(window.windowNumber); keepAbove(force: true)
    defer { try? showBadge(false); window.close() }
    for (index, point) in points.enumerated() {
        try animateCursor(to: point, label: index == 1 ? "Click" : "Press"); cursorEffect(click: true, around: frames[index])
        RunLoop.current.run(until: Date(timeIntervalSinceNow: 0.9))
    }
    trailBegin(points[2], to: points[0])
    let began = uptime()
    while uptime() - began < 0.6 {
        let t = (uptime() - began) / 0.6, eased = t * t * (3 - 2 * t)
        let point = CGPoint(x: points[2].x + (points[0].x - points[2].x) * eased, y: points[2].y + (points[0].y - points[2].y) * eased)
        presentCursor(point, label: "Dragging"); trailAppend(point); RunLoop.current.run(until: Date(timeIntervalSinceNow: 1 / 60))
    }
    presentCursor(points[0], label: "Dropped"); trailEnd(fade: true); cursorEffect(click: true, around: nil)
    RunLoop.current.run(until: Date(timeIntervalSinceNow: 1))
    if let stage = cursorStage, let png = stagePNG(stage) {
        let file = FileManager.default.temporaryDirectory.appendingPathComponent("mendcode-cursor-\(UUID().uuidString).png")
        try png.write(to: file, options: .atomic)
        print("Cursor-only render: \(file.path)")
    }
    print("Demo completed; no input events were sent.")
}
/** The cursor stage drawn offscreen at twice its size: no window is shown and nothing is captured from the screen. */
func stageBitmap(_ stage: CursorStage) -> CGContext? {
    let scale: CGFloat = 2
    guard let context = CGContext(data: nil, width: Int(stageSize.width * scale), height: Int(stageSize.height * scale), bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return nil }
    context.scaleBy(x: scale, y: scale)
    stage.root.render(in: context)
    return context
}
func stagePNG(_ stage: CursorStage) -> Data? {
    guard let image = stageBitmap(stage)?.makeImage() else { return nil }
    return NSBitmapImageRep(cgImage: image).representation(using: .png, properties: [:])
}
// Decision-only, `--cursor-accent <registry>`: the accent this process takes in that registry, then held until stdin ends.
if let flag = CommandLine.arguments.firstIndex(of: "--cursor-accent"), flag + 1 < CommandLine.arguments.count {
    print(pickAccent(registry: CommandLine.arguments[flag + 1])); fflush(stdout)
    while readLine() != nil {}
    exit(0)
}
// Decision-only: the cursor's travel time for each stdin line {from, to}. No window or event.
if CommandLine.arguments.contains("--cursor-path") {
    while let line = readLine() {
        guard let data = line.data(using: .utf8), let input = try? JSONSerialization.jsonObject(with: data) as? Object, let from = input["from"] as? [Double], let to = input["to"] as? [Double], from.count == 2, to.count == 2 else { print("{\"error\":\"invalid\"}"); continue }
        let distance = hypot(to[0] - from[0], to[1] - from[1])
        print(String(data: try! JSONSerialization.data(withJSONObject: ["durationMs": (travelSeconds(distance) * 1000).rounded()]), encoding: .utf8)!)
    }
    exit(0)
}
// Render-only, `--cursor-render <label> [<png>]`: the stage with that label drawn offscreen (never shown), optionally written as a
// PNG, and sampled at the stage points given as stdin lines [x, y] (y up) as [r, g, b, a].
if let flag = CommandLine.arguments.firstIndex(of: "--cursor-render"), flag + 1 < CommandLine.arguments.count {
    let stage = CursorStage(), rest = CommandLine.arguments[(flag + 1)...]
    stage.show(rest.first!)
    stage.place(CGPoint(x: 400, y: 400))
    if rest.count > 1, let png = stagePNG(stage) { try? png.write(to: URL(fileURLWithPath: rest[rest.startIndex + 1]), options: .atomic) }
    guard let context = stageBitmap(stage), let pixels = context.data?.assumingMemoryBound(to: UInt8.self) else { exit(1) }
    while let line = readLine() {
        guard let data = line.data(using: .utf8), let at = try? JSONSerialization.jsonObject(with: data) as? [Double], at.count == 2 else { print("[]"); continue }
        let column = Int(at[0] * 2), row = context.height - 1 - Int(at[1] * 2)
        guard (0..<context.width).contains(column), (0..<context.height).contains(row) else { print("[]"); continue }
        let offset = row * context.bytesPerRow + column * 4
        print("[\(pixels[offset]),\(pixels[offset + 1]),\(pixels[offset + 2]),\(pixels[offset + 3])]")
    }
    exit(0)
}
// Decision-only: one webview/key case per stdin line, the routes per stdout line.
if CommandLine.arguments.contains("--web-plan") {
    while let line = readLine() {
        guard let data = line.data(using: .utf8), let input = try? JSONSerialization.jsonObject(with: data) as? Object else { print("{}"); continue }
        let poor = poorTree(count: input["count"] as? Int ?? 0, hasProbe: input["probe"] as? Bool ?? false)
        let route = keyRoute(nodeFocusable: input["focusable"] as? Bool ?? false, focusedSecure: input["secure"] as? Bool ?? false, focusedOutside: input["outside"] as? Bool ?? false)
        print("{\"poor\":\(poor),\"route\":\"\(route)\"}")
    }
    exit(0)
}
// Decision-only: one recorded accessibility tree per stdin line, the pointer plan per stdout line. No AX object, event or window.
if CommandLine.arguments.contains("--pointer-plan") {
    while let line = readLine() {
        guard let data = line.data(using: .utf8), let input = try? JSONSerialization.jsonObject(with: data) as? Object, let list = input["nodes"] as? [Object], let node = input["node"] as? String, let found = input["hit"] as? String, let at = input["point"] as? [Double], at.count == 2 else { print("{\"error\":\"invalid\"}"); continue }
        var parent: [String: String] = [:], role: [String: String] = [:], press = Set<String>(), rects: [String: CGRect] = [:], children: [String: [String]] = [:]
        for item in list {
            guard let id = item["id"] as? String else { continue }
            role[id] = item["role"] as? String ?? ""
            if let up = item["parent"] as? String { parent[id] = up; children[up, default: []].append(id) }
            if item["press"] as? Bool == true { press.insert(id) }
            if let b = item["bounds"] as? [Double], b.count == 4 { rects[id] = CGRect(x: b[0], y: b[1], width: b[2], height: b[3]) }
        }
        func chain(_ id: String) -> [String] { var result = [id]; while let up = parent[result.last!], result.count < ancestryLimit { result.append(up) }; return result }
        let point = CGPoint(x: at[0], y: at[1])
        var under: [String] = [], current = node
        while let child = (children[current] ?? []).last(where: { rects[$0]?.contains(point) == true }) { under.insert(child, at: 0); current = child }
        let plan = pointerPlan(hit: chain(found), node: chain(node), under: under, same: { $0 == $1 }, role: { role[$0] ?? "" }, pressable: { press.contains($0) }, click: input["click"] as? Bool ?? true)
        switch plan {
        case .press(let id): print("{\"plan\":\"press\",\"element\":\"\(id)\"}")
        case .post: print("{\"plan\":\"post\"}")
        case .covered(let id): print("{\"plan\":\"covered\",\"element\":\"\(id ?? "")\"}")
        }
    }
    exit(0)
}
if CommandLine.arguments.contains("--cursor-demo") {
    do { try runCursorDemo(); exit(0) }
    catch { fputs("\((error as? Failure)?.message ?? String(describing: error))\n", stderr); exit(1) }
}
// Requests come one line at a time. While the cursor or an effect is on screen the wait turns the run loop every 50 ms, so played
// effects end and an idle cursor rests; otherwise the helper sleeps in poll() until the next line or the end of its input.
/** Started by LaunchServices (`open -a`) the app is its own responsible process and macOS grants Accessibility to it, not to a terminal. It has no
 *  pipes then: the daemon names a private socket and the one connection to it replaces stdin and stdout. */
if let flag = CommandLine.arguments.firstIndex(of: "--socket"), flag + 1 < CommandLine.arguments.count {
    let path = CommandLine.arguments[flag + 1]
    var address = sockaddr_un()
    address.sun_family = sa_family_t(AF_UNIX)
    let capacity = MemoryLayout.size(ofValue: address.sun_path)
    guard path.utf8.count < capacity else { exit(2) }
    withUnsafeMutablePointer(to: &address.sun_path) { $0.withMemoryRebound(to: CChar.self, capacity: capacity) { _ = strncpy($0, path, capacity - 1) } }
    let server = socket(AF_UNIX, SOCK_STREAM, 0)
    unlink(path)
    let bound = withUnsafePointer(to: &address) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(server, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) } }
    guard server >= 0, bound == 0, chmod(path, 0o600) == 0, listen(server, 1) == 0 else { exit(2) }
    var wait = pollfd(fd: server, events: Int16(POLLIN), revents: 0)
    guard poll(&wait, 1, 30_000) > 0 else { unlink(path); exit(3) }
    let connection = accept(server, nil, nil)
    unlink(path); close(server)
    guard connection >= 0, dup2(connection, 0) >= 0, dup2(connection, 1) >= 0 else { exit(2) }
    if connection > 1 { close(connection) }
    signal(SIGPIPE, SIG_IGN)
}
var pending = [UInt8](), discarding = false
func nextLine() -> String? {
    while !cancelled {
        if let end = pending.firstIndex(of: 10) {
            let line = discarding ? "" : String(decoding: pending[..<end], as: UTF8.self)
            pending.removeSubrange(...end); discarding = false
            return line
        }
        // A line over the bound is dropped as it arrives and answered once, as invalid, when it ends.
        if pending.count > 131_072 { pending.removeAll(); discarding = true }
        var descriptor = pollfd(fd: 0, events: Int16(POLLIN), revents: 0)
        let ready = poll(&descriptor, 1, (badge != nil && !cursorResting) || effectsUntil > 0 ? 50 : -1)
        if ready < 0 { if errno == EINTR { continue }; return nil }
        if ready == 0 { CFRunLoopRunInMode(.defaultMode, 0, false); idle(); continue }
        var chunk = [UInt8](repeating: 0, count: 65_536)
        let count = Darwin.read(0, &chunk, chunk.count)
        if count <= 0 { return nil }
        pending.append(contentsOf: chunk[..<count])
    }
    return nil
}
while !cancelled, let line = nextLine() {
    autoreleasepool {
        var reply: Object
        effectStarted = false
        do {
            guard !line.isEmpty, line.utf8.count <= 131_072, let data = line.data(using: .utf8), let request = try JSONSerialization.jsonObject(with: data) as? Object else { try fail("Invalid bounded JSON request") }
            reply = ["ok": true, "value": try dispatch(request)]
        } catch {
            reply = ["ok": false, "error": (error as? Failure)?.message ?? "Native computer operation failed", "delivery": effectStarted ? "unknown" : "not_delivered"]
            if let code = (error as? Failure)?.code { reply["code"] = code }
        }
        let data = (try? JSONSerialization.data(withJSONObject: reply, options: [.sortedKeys])) ?? Data("{\"ok\":false,\"error\":\"Invalid native output\"}".utf8)
        FileHandle.standardOutput.write(data); FileHandle.standardOutput.write(Data([10]))
    }
}
cursorProgram = false
try? showBadge(false)
for pid in Array(webAccessibility.keys) { restoreWebAccessibility(pid) }
