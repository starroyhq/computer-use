import AppKit
import Foundation

// A disposable application for input verification. It never opens user documents.
final class Fixture: NSObject, NSApplicationDelegate {
    private var window: NSWindow!
    private let input = NSTextField(string: "")
    private let result = NSTextField(labelWithString: "Ready")
    private var count = 0
    private var output: URL?
    func applicationDidFinishLaunching(_ notification: Notification) {
        if let index = CommandLine.arguments.firstIndex(of: "--output"), CommandLine.arguments.count > index + 1 {
            output = URL(fileURLWithPath: CommandLine.arguments[index + 1])
        }
        window = NSWindow(contentRect: NSRect(x: 120, y: 120, width: 520, height: 260), styleMask: [.titled, .closable, .resizable], backing: .buffered, defer: false)
        window.title = "Computer Use Fixture"
        let content = window.contentView!
        let title = NSTextField(labelWithString: "Computer Use — disposable input fixture")
        title.frame = NSRect(x: 24, y: 204, width: 470, height: 24)
        input.frame = NSRect(x: 24, y: 152, width: 470, height: 30)
        input.setAccessibilityLabel("Probe input")
        let record = NSButton(title: "Record", target: self, action: #selector(recordInput))
        record.frame = NSRect(x: 24, y: 102, width: 100, height: 32)
        let reset = NSButton(title: "Reset", target: self, action: #selector(resetInput))
        reset.frame = NSRect(x: 140, y: 102, width: 100, height: 32)
        result.frame = NSRect(x: 24, y: 45, width: 470, height: 40)
        [title, input, record, reset, result].forEach(content.addSubview)
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        persist(text: "")
    }
    @objc private func recordInput() {
        window.makeFirstResponder(nil)
        count += 1
        result.stringValue = "Recorded \(count)"
        persist(text: input.stringValue)
    }
    @objc private func resetInput() {
        input.stringValue = ""
        result.stringValue = "Ready"
        persist(text: "")
    }
    private func persist(text: String) {
        guard let output else { return }
        let data = try! JSONSerialization.data(withJSONObject: ["text": text, "count": count])
        do { try data.write(to: output, options: .atomic) }
        catch { result.stringValue = "Unable to write fixture evidence" }
    }
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
}
let app = NSApplication.shared
let delegate = Fixture()
app.setActivationPolicy(.regular)
app.delegate = delegate
app.run()
