import Cocoa
import ApplicationServices
import QuartzCore

// Private stdio protocol. AX objects and authority never leave this process.
typealias Object = [String: Any]
struct Failure: Error { let message: String }
var cancelled = false
signal(SIGTERM) { _ in cancelled = true }
signal(SIGINT) { _ in cancelled = true }
func fail(_ message: String) throws -> Never { throw Failure(message: message) }
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
func enabled(_ element: AXUIElement) -> Bool {
    if let value = attribute(element, kAXEnabledAttribute) as? Bool { return value }
    // AppKit text views (TextEdit's document) do not report AXEnabled at all; without AXTextArea here they offered no action.
    return ["AXWindow", "AXScrollArea", "AXGroup", "AXWebArea", "AXImage", "AXTextArea"].contains(text(element, kAXRoleAttribute))
}
func bounds(_ element: AXUIElement) -> CGRect? {
    guard let p = attribute(element, kAXPositionAttribute), let s = attribute(element, kAXSizeAttribute), CFGetTypeID(p) == AXValueGetTypeID(), CFGetTypeID(s) == AXValueGetTypeID() else { return nil }
    var point = CGPoint.zero, size = CGSize.zero
    guard AXValueGetValue(p as! AXValue, .cgPoint, &point), AXValueGetValue(s as! AXValue, .cgSize, &size), point.x.isFinite, point.y.isFinite, size.width > 0, size.height > 0 else { return nil }
    return CGRect(origin: point, size: size)
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
func fingerprint(_ element: AXUIElement) -> String {
    let values = [kAXRoleAttribute, kAXSubroleAttribute, kAXIdentifierAttribute, kAXTitleAttribute, kAXDescriptionAttribute, kAXValueAttribute].map { text(element, $0) }
    return String(data: try! JSONSerialization.data(withJSONObject: values + [String(enabled(element)), String(describing: bounds(element))]), encoding: .utf8)!
}
struct Reference { let element: AXUIElement; let signature: String; let window: AXUIElement; let pid: pid_t }
var references: [String: Reference] = [:]
var windowHandles: [String: AXUIElement] = [:]
var windowPIDs: [String: pid_t] = [:]
var nodeCounter: UInt64 = UInt64.random(in: 100_000_000_000...900_000_000_000)
var badge: NSPanel?
var cursorView: NativeCursorView?
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

func trusted() throws {
    if !AXIsProcessTrusted() { try fail("Accessibility permission is missing for MendCode's native helper. In System Settings > Privacy & Security > Accessibility press +, then cmd+shift+G and paste \(Bundle.main.executablePath ?? CommandLine.arguments[0]); no permission prompt was opened. Tell the user this path; do not retry until they confirm.") }
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
    return (running, ax, focused)
}
// Cursor silhouette adapted from Lucide mouse-pointer-2 (ISC License).
// Copyright (c) 2026 Lucide Icons and Contributors
// Permission to use, copy, modify, and/or distribute this software for any
// purpose with or without fee is hereby granted, provided that the above
// copyright notice and this permission notice appear in all copies.
// THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
// WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
// MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
// ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
// WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
// ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF
// OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.
final class NativeCursorView: NSView {
    override var isFlipped: Bool { true }
    var tip = CGPoint(x: 16, y: 16)
    var label = "Ready"
    var dragging = false
    override func draw(_ dirtyRect: NSRect) {
        NSGraphicsContext.saveGraphicsState()
        defer { NSGraphicsContext.restoreGraphicsState() }
        NSColor.clear.setFill(); dirtyRect.fill(using: .copy)
        let accent = dragging ? NSColor.systemOrange : NSColor(calibratedRed: 0.08, green: 0.72, blue: 0.60, alpha: 1)
        let dx: CGFloat = tip.x + 16 > bounds.width ? -1 : 1
        let dy: CGFloat = tip.y + 16 > bounds.height ? -1 : 1
        func point(_ x: CGFloat, _ y: CGFloat) -> CGPoint {
            CGPoint(x: tip.x + (x - 4) * 0.9 * dx, y: tip.y + (y - 4) * 0.9 * dy)
        }
        let pointer = NSBezierPath()
        pointer.move(to: point(4.037, 4.688))
        pointer.curve(to: point(4.688, 4.037), controlPoint1: point(3.887, 4.32), controlPoint2: point(4.32, 3.887))
        pointer.line(to: point(20.688, 10.537))
        pointer.curve(to: point(20.625, 11.484), controlPoint1: point(21.15, 10.725), controlPoint2: point(21.118, 11.357))
        pointer.line(to: point(14.501, 13.064))
        pointer.curve(to: point(13.063, 14.499), controlPoint1: point(13.796, 13.246), controlPoint2: point(13.245, 13.795))
        pointer.line(to: point(11.484, 20.625))
        pointer.curve(to: point(10.537, 20.688), controlPoint1: point(11.364, 21.091), controlPoint2: point(10.722, 21.137))
        pointer.close()
        let glow = NSShadow(); glow.shadowColor = accent.withAlphaComponent(0.55)
        glow.shadowBlurRadius = 7; glow.shadowOffset = .zero; glow.set()
        accent.setFill(); pointer.fill()
        NSShadow().set()
    }
}
func cocoaPoint(_ point: CGPoint) -> CGPoint {
    CGPoint(x: point.x, y: (NSScreen.screens.first?.frame.maxY ?? 0) - point.y)
}
func presentCursor(_ point: CGPoint, label: String) {
    guard let panel = badge, let view = cursorView else { return }
    let cocoa = cocoaPoint(point)
    let screen = NSScreen.screens.first(where: { $0.frame.contains(cocoa) }) ?? NSScreen.screens.first
    let frame = screen?.frame ?? NSRect(x: cocoa.x - 48, y: cocoa.y - 48, width: 96, height: 96)
    let origin = NSPoint(x: min(max(cocoa.x - 48, frame.minX), max(frame.minX, frame.maxX - 96)), y: min(max(cocoa.y - 48, frame.minY), max(frame.minY, frame.maxY - 96)))
    panel.setFrameOrigin(origin)
    view.tip = CGPoint(x: cocoa.x - origin.x, y: panel.frame.height - (cocoa.y - origin.y))
    view.label = label
    cursorLocation = point
    view.needsDisplay = true; panel.displayIfNeeded()
    CATransaction.flush()
}
func animateCursor(to end: CGPoint, label: String) throws {
    guard badge?.isVisible == true else { try fail("Virtual cursor is not visible") }
    let start = cursorLocation ?? end
    let distance = hypot(end.x - start.x, end.y - start.y)
    if NSWorkspace.shared.accessibilityDisplayShouldReduceMotion || distance < 2 { presentCursor(end, label: label); return }
    let duration = min(0.75, max(0.28, distance / 1200)), began = ProcessInfo.processInfo.systemUptime
    repeat {
        if cancelled { try fail("Cursor movement cancelled; no input sent") }
        let t = min(1, (ProcessInfo.processInfo.systemUptime - began) / duration), eased = t * t * (3 - 2 * t)
        let point = CGPoint(x: start.x + (end.x - start.x) * eased, y: start.y + (end.y - start.y) * eased)
        presentCursor(point, label: label)
        if t >= 1 { break }
        RunLoop.current.run(until: Date(timeIntervalSinceNow: 1 / 60))
    } while true
    presentCursor(end, label: label)
}
func cursorPulse(_ label: String) {
    guard let point = cursorLocation else { return }
    presentCursor(point, label: label)
}
func showBadge(_ show: Bool) throws {
    if show && badge?.isVisible == true { return }
    if !show && cursorProgram { return }
    // The main thread sits in readLine() between requests, so the window server only learns the panel is gone if the run loop turns
    // once here: without it the helper answered "hidden" and the cursor stayed on screen (measured: 1 on-screen window after hide).
    if let panel = badge { panel.orderOut(nil); panel.close(); RunLoop.current.run(until: Date(timeIntervalSinceNow: 0.05)) }
    badge = nil; cursorView = nil
    guard show else { releaseLease(); return }
    try acquireLease()
    let panel = NSPanel(contentRect: NSRect(x: 0, y: 0, width: 96, height: 96), styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
    panel.isFloatingPanel = true; panel.level = .statusBar; panel.ignoresMouseEvents = true
    panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
    panel.isOpaque = false; panel.backgroundColor = .clear; panel.hasShadow = false
    panel.isReleasedWhenClosed = false; panel.sharingType = .none
    // No fade: an animation needs the run loop to keep turning, and it stops as soon as the next request is awaited.
    panel.animationBehavior = .none
    let view = NativeCursorView(frame: NSRect(x: 0, y: 0, width: 96, height: 96))
    view.setAccessibilityElement(false); panel.setAccessibilityElement(false)
    panel.contentView = view; badge = panel; cursorView = view
    let mouse = NSEvent.mouseLocation
    let initial = cursorLocation ?? CGPoint(x: mouse.x, y: (NSScreen.screens.first?.frame.maxY ?? 0) - mouse.y)
    presentCursor(initial, label: "Ready")
    panel.orderFrontRegardless(); panel.displayIfNeeded()
    RunLoop.current.run(until: Date(timeIntervalSinceNow: 0.02))
}
// Chromium (Chrome, Brave, Edge, Electron apps) offers a page's own actions only once an assistive app asks for them, and a
// click posted to its process never reaches the page (measured in Chrome, in front and behind: links offered no AXPress,
// and neither a posted click nor AXPress changed the page). After this attribute, the one VoiceOver sets, links and buttons
// offer AXPress about 2 s later and it works with the window behind others. It is cleared when the app's last session ends.
let enhancedInterface = "AXEnhancedUserInterface"
var webAccessibility = Set<pid_t>()
func enableWebAccessibility(_ pid: pid_t) -> Bool {
    if webAccessibility.contains(pid) { return false }
    let app = AXUIElementCreateApplication(pid)
    // Already on (VoiceOver is running): not ours to switch, or to clear later.
    if (attribute(app, enhancedInterface) as? Bool) == true { return false }
    // Chrome answers "not implemented" and switches anyway.
    _ = AXUIElementSetAttributeValue(app, enhancedInterface as CFString, kCFBooleanTrue)
    webAccessibility.insert(pid)
    return true
}
func restoreWebAccessibility(_ pid: pid_t) {
    guard webAccessibility.remove(pid) != nil else { return }
    _ = AXUIElementSetAttributeValue(AXUIElementCreateApplication(pid), enhancedInterface as CFString, kCFBooleanFalse)
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
        let role = text(element, kAXRoleAttribute), isSecure = inheritedSecure || secure(element), isEnabled = enabled(element)
        let inPage = inWeb || role == "AXWebArea"
        if inPage && webProbe == nil && ["AXLink", "AXButton"].contains(role) { webProbe = element }
        let name = text(element, kAXTitleAttribute).isEmpty ? text(element, kAXDescriptionAttribute) : text(element, kAXTitleAttribute)
        nodeCounter += 1; let id = "0.\(nodeCounter)"
        var actions: [String] = []
        var supported: CFArray?
        AXUIElementCopyActionNames(element, &supported)
        if isEnabled && !isSecure {
            if (supported as? [String] ?? []).contains(kAXPressAction) { actions.append("press") }
            var writable = DarwinBoolean(false)
            if AXUIElementIsAttributeSettable(element, kAXValueAttribute as CFString, &writable) == .success && writable.boolValue && ["AXTextField", "AXTextArea", "AXComboBox"].contains(role) { actions.append("setValue") }
            if bounds(element) != nil {
                actions += ["click", "key", "scroll", "drag"]
                if ["AXTextField", "AXTextArea", "AXComboBox"].contains(role) { actions.append("typeText") }
            }
        }
        var node: Object = ["id": id, "role": clipped(role), "name": isSecure ? "" : clipped(name), "states": (isEnabled ? ["enabled"] : []) + ((attribute(element, kAXFocusedAttribute) as? Bool) == true ? ["focused"] : []), "actions": actions]
        if isSecure { node["secure"] = true; node["states"] = ["secure"] }
        else { let value = text(element, kAXValueAttribute); if !value.isEmpty { node["value"] = clipped(value) } }
        if let rect = bounds(element) { node["bounds"] = rectObject(rect) }
        let length = (try? JSONSerialization.data(withJSONObject: node).count) ?? 0
        if bytes + length > 58_000 { truncated = true; return }
        bytes += length; nodes.append(node)
        if !isSecure { references[id] = Reference(element: element, signature: fingerprint(element), window: window, pid: pid) }
        if isSecure { return }
        let children = attribute(element, kAXChildrenAttribute) as? [AXUIElement] ?? []
        for child in children { if nodes.count >= 500 || bytes >= 58_000 { truncated = true; break }; walk(child, depth: depth + 1, inheritedSecure: isSecure, inWeb: inPage) }
    }
    walk(window, depth: 0, inheritedSecure: false, inWeb: false)
    return (nodes, truncated, webProbe)
}
func validateReference(_ ref: Reference, target: Object, foreground: Bool = true) throws {
    let (running, _, window) = try selected(target, foreground: foreground)
    guard ref.pid == running.processIdentifier, CFEqual(ref.window, window), descendant(ref.element, of: window), !secure(ref.element), enabled(ref.element), fingerprint(ref.element) == ref.signature else { try fail("Semantic node changed, is secure, or is stale; observe again") }
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
    overlay?.orderOut(nil)
    defer { if visible && !cancelled { overlay?.orderFrontRegardless(); overlay?.displayIfNeeded() } }
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
    event.postToPid(pid)
}
let keyCodes: [String: CGKeyCode] = ["tab":48,"escape":53,"enter":36,"space":49,"left":123,"right":124,"down":125,"up":126,"backspace":51,"delete":117,"home":115,"end":119,"pageUp":116,"pageDown":121,"a":0,"c":8,"v":9,"x":7,"z":6,"s":1,"f":3,"l":37,"n":45,"w":13]
func flags(_ names: [String]) -> CGEventFlags {
    names.reduce(CGEventFlags()) { result, name in result.union(["command": .maskCommand, "shift": .maskShift, "option": .maskAlternate, "control": .maskControl][name] ?? []) }
}
func action(_ target: Object, input: Object) throws -> Object {
    guard badge?.isVisible == true, lease >= 0 else { try fail("Visible control indicator or input lease is missing") }
    guard let id = input["nodeID"] as? String, let name = input["action"] as? String else { try fail("Invalid action") }
    // AXPress and AXSetValue are delivered to the element itself; every other action is an event posted to the approved process,
    // so none needs the app in front and none raises it or moves the user's own pointer.
    let foreground = false
    let ref = try reference(id, target: target, foreground: foreground)
    var destination: Reference?
    if name == "drag" {
        guard let to = input["toNodeID"] as? String else { try fail("Drag requires a destination node") }
        destination = try reference(to, target: target, foreground: false)
    }
    // Consume all handles before effects, including partial failures.
    references.removeAll()
    let labels = ["press": "Press", "setValue": "Text", "typeText": "Typing", "key": "Key", "scroll": "Scroll", "drag": "Drag", "click": input["button"] as? String == "right" ? "Right click" : input["count"] as? Int == 2 ? "Double click" : "Click"]
    let label = labels[name] ?? "Control"
    if let rect = bounds(ref.element) { try animateCursor(to: CGPoint(x: rect.midX, y: rect.midY), label: label) }
    try validateReference(ref, target: target, foreground: foreground)
    if name == "press" {
        guard AXUIElementPerformAction(ref.element, kAXPressAction as CFString) == .success else { try fail("AXPress failed; inspect the target before retrying") }
        cursorPulse(label)
        return ["dispatched": true]
    }
    if name == "setValue" {
        guard ["AXTextField", "AXTextArea", "AXComboBox"].contains(text(ref.element, kAXRoleAttribute)), let value = input["value"] as? String else { try fail("Not a writable text node") }
        // The caret moves only while the app is in front: moving AX focus inside a background app is not needed to set a value, and is not ours to do.
        if frontmost()?.processIdentifier == ref.pid { try focus(ref) }
        _ = try selected(target, foreground: false)
        guard AXUIElementSetAttributeValue(ref.element, kAXValueAttribute as CFString, value as CFString) == .success else { try fail("AXSetValue failed; inspect the target before retrying") }
        let deadline = Date(timeIntervalSinceNow: 1)
        while text(ref.element, kAXValueAttribute) != value && Date() < deadline {
            _ = try selected(target, foreground: false)
            if secure(ref.element) { try fail("Text field became secure; write result is unknown") }
            RunLoop.current.run(until: Date(timeIntervalSinceNow: 0.05))
        }
        guard text(ref.element, kAXValueAttribute) == value else { try fail("AXSetValue was accepted but its value was not confirmed; observe before retrying") }
        cursorPulse(label)
        return ["dispatched": true]
    }
    if name == "key" || name == "typeText" {
        try focus(ref); _ = try selected(target, foreground: false)
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
        cursorPulse(label)
        return ["dispatched": true]
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
        guard AXUIElementPerformAction(element, kAXPressAction as CFString) == .success else { try fail("AXPress on the clicked element failed; observe before retrying") }
        cursorPulse(label)
        return ["dispatched": true]
    }
    if name == "scroll" {
        let amount = min(1000, max(1, input["amount"] as? Int ?? 300)), direction = input["direction"] as? String ?? "down"
        let vertical = direction == "up" ? amount : direction == "down" ? -amount : 0
        let horizontal = direction == "left" ? amount : direction == "right" ? -amount : 0
        let event = CGEvent(scrollWheelEvent2Source: nil, units: .pixel, wheelCount: 2, wheel1: Int32(vertical), wheel2: Int32(horizontal), wheel3: 0)
        event?.location = point; aim(event, at: point, pid: ref.pid); try post(event, pid: ref.pid)
        cursorPulse(label)
        return ["dispatched": true]
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
        cursorPulse(label)
        return ["dispatched": true]
    }
    if name == "drag", let destination = destination, let endRect = bounds(destination.element) {
        let end = CGPoint(x: endRect.midX, y: endRect.midY)
        try validateReference(destination, target: target, foreground: false)
        _ = try hit(end, ref: destination)
        try post(CGEvent(mouseEventSource: nil, mouseType: .leftMouseDown, mouseCursorPosition: point, mouseButton: .left), pid: ref.pid)
        var current = point
        cursorView?.dragging = true
        defer {
            CGEvent(mouseEventSource: nil, mouseType: .leftMouseUp, mouseCursorPosition: current, mouseButton: .left)?.postToPid(ref.pid)
            cursorView?.dragging = false
            presentCursor(current, label: "Dropped")
            cursorPulse("Dropped")
        }
        for step in 1...18 {
            _ = try selected(target, foreground: false)
            let t = Double(step) / 18, eased = t * t * (3 - 2 * t)
            current = CGPoint(x: point.x + (end.x - point.x) * eased, y: point.y + (end.y - point.y) * eased)
            try post(CGEvent(mouseEventSource: nil, mouseType: .leftMouseDragged, mouseCursorPosition: current, mouseButton: .left), pid: ref.pid)
            presentCursor(current, label: "Dragging")
            RunLoop.current.run(until: Date(timeIntervalSinceNow: 1 / 60))
        }
        return ["dispatched": true]
    }
    try fail("Unsupported native action")
}
func dispatch(_ request: Object) throws -> Any {
    guard let name = request["method"] as? String else { try fail("Missing method") }
    let target = request["target"] as? Object ?? [:]
    switch name {
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
    case "action": return try action(target, input: request["input"] as? Object ?? [:])
    case "navigation":
        try trusted()
        guard let pid = request["pid"] as? Int, let current = frontmost(), Int(current.processIdentifier) == pid else { try fail("Foreground application changed; capture again") }
        let target = targetObject(current)
        let (_, ax, window) = try selected(target)
        guard let focused = elementAttribute(ax, kAXFocusedUIElementAttribute), !secure(focused), descendant(focused, of: window) else { try fail("Cannot send a key to a secure or unknown focused element") }
        nodeCounter += 1; let id = "0.\(nodeCounter)"
        references[id] = Reference(element: focused, signature: fingerprint(focused), window: window, pid: current.processIdentifier)
        return try action(target, input: ["nodeID": id, "action": "key", "key": request["key"] as? String ?? ""])
    case "program":
        if request["active"] as? Bool == true {
            guard !cursorProgram else { try fail("Another native computer program is running") }
            _ = try running(target, foreground: false)
            try showBadge(true); cursorProgram = true
        } else { cursorProgram = false; try showBadge(false) }
        return ["active": cursorProgram]
    case "indicator": try showBadge(request["visible"] as? Bool == true); return ["visible": badge?.isVisible == true]
    case "release":
        references.removeAll()
        let pid = pid_t(target["pid"] as? Int ?? 0)
        for id in Array(windowHandles.keys) where windowPIDs[id] == pid { windowHandles.removeValue(forKey: id); windowPIDs.removeValue(forKey: id) }
        restoreWebAccessibility(pid)
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
    let subtitle = NSTextField(wrappingLabelWithString: "Only this demo window is opened. Movement, click rings and dragging are visual simulations; no browser, clipboard or user application is controlled.")
    subtitle.frame = NSRect(x: 30, y: 217, width: 550, height: 50)
    window.contentView?.addSubview(title); window.contentView?.addSubview(subtitle)
    let labels = ["Search", "Save", "Drag here"]
    var points: [CGPoint] = []
    for (index, label) in labels.enumerated() {
        let button = NSButton(title: label, target: nil, action: nil)
        button.bezelStyle = .rounded; button.frame = NSRect(x: 40 + index * 190, y: 130, width: 155, height: 44)
        window.contentView?.addSubview(button)
        points.append(cocoaPoint(window.convertPoint(toScreen: NSPoint(x: button.frame.midX, y: button.frame.midY))))
    }
    window.makeKeyAndOrderFront(nil); app.activate(ignoringOtherApps: true)
    RunLoop.current.run(until: Date(timeIntervalSinceNow: 0.15))
    cursorLocation = points[0]
    try showBadge(true)
    defer { try? showBadge(false); window.close() }
    for (index, point) in points.enumerated() {
        try animateCursor(to: point, label: labels[index]); cursorPulse(index == 1 ? "Click" : "Ready")
        RunLoop.current.run(until: Date(timeIntervalSinceNow: 0.35))
    }
    cursorView?.dragging = true
    try animateCursor(to: points[0], label: "Dragging")
    cursorView?.dragging = false; cursorPulse("Dropped")
    RunLoop.current.run(until: Date(timeIntervalSinceNow: 0.4))
    if let view = cursorView, let bitmap = view.bitmapImageRepForCachingDisplay(in: view.bounds) {
        view.cacheDisplay(in: view.bounds, to: bitmap)
        if let png = bitmap.representation(using: .png, properties: [:]) {
            let file = FileManager.default.temporaryDirectory.appendingPathComponent("mendcode-cursor-\(UUID().uuidString).png")
            try png.write(to: file, options: .atomic)
            print("Cursor-only render: \(file.path)")
        }
    }
    print("Demo completed; no input events were sent.")
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
while !cancelled, let line = readLine() {
    autoreleasepool {
        var reply: Object
        do {
            guard line.utf8.count <= 131_072, let data = line.data(using: .utf8), let request = try JSONSerialization.jsonObject(with: data) as? Object else { try fail("Invalid bounded JSON request") }
            reply = ["ok": true, "value": try dispatch(request)]
        } catch { reply = ["ok": false, "error": (error as? Failure)?.message ?? "Native computer operation failed"] }
        let data = (try? JSONSerialization.data(withJSONObject: reply, options: [.sortedKeys])) ?? Data("{\"ok\":false,\"error\":\"Invalid native output\"}".utf8)
        FileHandle.standardOutput.write(data); FileHandle.standardOutput.write(Data([10]))
    }
}
cursorProgram = false
try? showBadge(false)
for pid in Array(webAccessibility) { restoreWebAccessibility(pid) }
