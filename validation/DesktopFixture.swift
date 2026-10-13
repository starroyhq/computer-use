import AppKit
import Foundation
// A disposable application for input verification. It never opens user documents.
final class Fixture: NSObject, NSApplicationDelegate {
    private var window: NSWindow!
    private let input = NSTextField(string: "")
    // A fixed dummy value used only to check that observations never expose secure-field contents.
    private let secret = NSSecureTextField(string: "fixture-secret-8431")
    private let result = NSTextField(labelWithString: "Ready")
    // Controls for value-setting actions: a pop-up button (picked by option title) and a slider (AXValue).
    private let choice = NSPopUpButton(frame: .zero, pullsDown: false)
    private let level = NSSlider(value: 0, minValue: 0, maxValue: 10, target: nil, action: nil)
    private var count = 0
    private var recordedText = ""
    private var lastControls = ""
    private var output: URL?
    func applicationDidFinishLaunching(_ notification: Notification) {
        if let index = CommandLine.arguments.firstIndex(of: "--output"), CommandLine.arguments.count > index + 1 {
            output = URL(fileURLWithPath: CommandLine.arguments[index + 1])
        }
        window = NSWindow(contentRect: NSRect(x: 120, y: 120, width: 520, height: 330), styleMask: [.titled, .closable, .resizable], backing: .buffered, defer: false)
        window.title = "Computer Use Fixture"
        let content = window.contentView!
        let title = NSTextField(labelWithString: "Computer Use — disposable input fixture")
        title.frame = NSRect(x: 24, y: 274, width: 470, height: 24)
        input.frame = NSRect(x: 24, y: 222, width: 470, height: 30)
        input.setAccessibilityLabel("Probe input")
        let record = NSButton(title: "Record", target: self, action: #selector(recordInput))
        record.frame = NSRect(x: 24, y: 172, width: 100, height: 32)
        let reset = NSButton(title: "Reset", target: self, action: #selector(resetInput))
        reset.frame = NSRect(x: 140, y: 172, width: 100, height: 32)
        secret.frame = NSRect(x: 256, y: 173, width: 238, height: 30)
        secret.setAccessibilityLabel("Probe secret")
        choice.addItems(withTitles: ["Small", "Medium", "Large"])
        choice.frame = NSRect(x: 24, y: 122, width: 180, height: 26)
        choice.setAccessibilityLabel("Probe choice")
        level.frame = NSRect(x: 256, y: 122, width: 238, height: 26)
        level.setAccessibilityLabel("Probe level")
        result.frame = NSRect(x: 24, y: 45, width: 470, height: 40)
        [title, input, record, reset, secret, choice, level, result].forEach(content.addSubview)
        NSApp.mainMenu = makeMenu()
        // Keep focus off the secure field: a focused secure field turns on system-wide secure keyboard input.
        window.initialFirstResponder = input
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        persist(text: "")
        // The pop-up and slider can change through accessibility without a mouse event; record what they hold.
        Timer.scheduledTimer(withTimeInterval: 0.25, repeats: true) { [weak self] _ in self?.syncControls() }
    }
    // A "Fixture" menu with a nested item, so menu paths can be checked against an independent counter.
    private func makeMenu() -> NSMenu {
        let main = NSMenu()
        let appItem = NSMenuItem()
        main.addItem(appItem)
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: "Quit Computer Use Fixture", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appItem.submenu = appMenu
        let fixtureItem = NSMenuItem(title: "Fixture", action: nil, keyEquivalent: "")
        main.addItem(fixtureItem)
        let fixtureMenu = NSMenu(title: "Fixture")
        fixtureItem.submenu = fixtureMenu
        for (name, action) in [("Record", #selector(recordInput)), ("Reset", #selector(resetInput))] {
            let item = NSMenuItem(title: name, action: action, keyEquivalent: "")
            item.target = self
            fixtureMenu.addItem(item)
        }
        let moreItem = NSMenuItem(title: "More", action: nil, keyEquivalent: "")
        let moreMenu = NSMenu(title: "More")
        let twice = NSMenuItem(title: "Record Twice", action: #selector(recordTwice), keyEquivalent: "")
        twice.target = self
        moreMenu.addItem(twice)
        let disabled = NSMenuItem(title: "Unavailable Command", action: nil, keyEquivalent: "")
        moreMenu.addItem(disabled)
        moreItem.submenu = moreMenu
        fixtureMenu.addItem(moreItem)
        return main
    }
    @objc private func recordInput() {
        window.makeFirstResponder(nil)
        count += 1
        result.stringValue = "Recorded \(count)"
        persist(text: input.stringValue)
    }
    @objc private func recordTwice() {
        count += 2
        result.stringValue = "Recorded \(count)"
        persist(text: recordedText)
    }
    @objc private func resetInput() {
        input.stringValue = ""
        choice.selectItem(at: 0)
        level.doubleValue = 0
        result.stringValue = "Ready"
        persist(text: "")
    }
    private func controlsState() -> String { "\(choice.titleOfSelectedItem ?? "")|\((level.doubleValue * 100).rounded() / 100)" }
    private func syncControls() {
        if controlsState() != lastControls { persist(text: recordedText) }
    }
    private func persist(text: String) {
        recordedText = text
        lastControls = controlsState()
        guard let output else { return }
        let data = try! JSONSerialization.data(
            withJSONObject: ["text": text, "count": count, "choice": choice.titleOfSelectedItem ?? "", "level": (level.doubleValue * 100).rounded() / 100]
        )
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
