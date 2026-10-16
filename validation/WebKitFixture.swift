import AppKit
import WebKit

// A disposable WebKit page that behaves like a browser terminal such as xterm.js: a self-clearing helper textarea
// receives keystrokes and pastes, and the visible text is drawn on a canvas that the accessibility tree cannot read.
// It loads no remote content and never opens user documents. With --output, every change is written to that JSON file
// so results can be checked independently of the automation tool.
final class WebKitFixture: NSObject, NSApplicationDelegate, WKScriptMessageHandler {
    private var window: NSWindow!
    private var cover: NSWindow?
    private var output: URL?
    private var state: [String: Any] = [:]

    func applicationDidFinishLaunching(_ notification: Notification) {
        let arguments = CommandLine.arguments
        if let index = arguments.firstIndex(of: "--output"), arguments.count > index + 1 {
            output = URL(fileURLWithPath: arguments[index + 1])
        }
        let configuration = WKWebViewConfiguration()
        configuration.userContentController.add(self, name: "fixture")
        let frame = NSRect(x: 160, y: 160, width: 720, height: 420)
        let web = WKWebView(frame: NSRect(origin: .zero, size: frame.size), configuration: configuration)
        window = NSWindow(contentRect: frame, styleMask: [.titled, .closable, .resizable], backing: .buffered, defer: false)
        window.title = "Computer Use WebKit Fixture"
        window.contentView = web
        web.loadHTMLString(Self.page, baseURL: nil)
        NSApp.mainMenu = makeMenu()
        window.makeKeyAndOrderFront(nil)
        window.makeFirstResponder(web)
        if arguments.contains("--cover") { toggleCover() }
    }

    // A standard Edit menu, so Command-V reaches the page as a paste event the way it does in Tauri or Electron apps,
    // and a Fixture menu whose items can be invoked through accessibility without moving focus.
    private func makeMenu() -> NSMenu {
        let main = NSMenu()
        let appItem = NSMenuItem()
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: "Quit Computer Use WebKit Fixture", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appItem.submenu = appMenu
        main.addItem(appItem)
        let editItem = NSMenuItem(title: "Edit", action: nil, keyEquivalent: "")
        let edit = NSMenu(title: "Edit")
        edit.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        edit.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        edit.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        edit.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        editItem.submenu = edit
        main.addItem(editItem)
        let fixtureItem = NSMenuItem(title: "Fixture", action: nil, keyEquivalent: "")
        let fixture = NSMenu(title: "Fixture")
        let toggle = NSMenuItem(title: "Toggle Cover", action: #selector(toggleCover), keyEquivalent: "")
        toggle.target = self
        fixture.addItem(toggle)
        fixtureItem.submenu = fixture
        main.addItem(fixtureItem)
        return main
    }

    // An opaque window of the same app placed exactly over the page window, to check covered-window reporting.
    @objc private func toggleCover() {
        if let cover {
            cover.orderOut(nil)
            self.cover = nil
        } else {
            let cover = NSWindow(contentRect: window.frame, styleMask: [.borderless], backing: .buffered, defer: false)
            cover.isReleasedWhenClosed = false
            cover.backgroundColor = .systemGray
            cover.isOpaque = true
            cover.title = "Computer Use WebKit Fixture Cover"
            let label = NSTextField(labelWithString: "Cover window")
            label.frame = NSRect(x: 24, y: 24, width: 300, height: 24)
            cover.contentView?.addSubview(label)
            cover.order(.above, relativeTo: window.windowNumber)
            self.cover = cover
        }
        state["covered"] = cover != nil
        persist()
    }

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let body = message.body as? [String: Any] else { return }
        for (key, value) in body { state[key] = value }
        persist()
    }

    private func persist() {
        guard let output, let data = try? JSONSerialization.data(withJSONObject: state, options: [.sortedKeys]) else { return }
        try? data.write(to: output, options: .atomic)
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }

    private static let page = #"""
    <!doctype html><html><head><meta charset="utf-8"><title>Terminal fixture</title>
    <style>
    html, body { margin: 0; height: 100%; background: #111; overflow: hidden; }
    #screen { position: absolute; inset: 0; width: 100%; height: 100%; }
    #input { position: absolute; left: 12px; top: 12px; width: 4px; height: 20px; opacity: 0; border: 0; padding: 0; resize: none; }
    </style></head><body>
    <canvas id="screen" aria-hidden="true"></canvas>
    <textarea id="input" aria-label="Terminal input" autocapitalize="off" autocomplete="off" autocorrect="off" spellcheck="false"></textarea>
    <script>
    const canvas = document.getElementById('screen'), input = document.getElementById('input');
    let lines = ['$ '], received = '', pasted = [], enter = 0, inputs = 0;
    function draw() {
      const ratio = window.devicePixelRatio || 1;
      canvas.width = canvas.clientWidth * ratio;
      canvas.height = canvas.clientHeight * ratio;
      const g = canvas.getContext('2d');
      g.scale(ratio, ratio);
      g.fillStyle = '#111';
      g.fillRect(0, 0, canvas.clientWidth, canvas.clientHeight);
      g.fillStyle = '#e6e6e6';
      g.font = '16px Menlo, monospace';
      g.textBaseline = 'top';
      const rows = Math.max(1, Math.floor((canvas.clientHeight - 16) / 22));
      lines.slice(-rows).forEach((line, index) => g.fillText(line, 12, 12 + index * 22));
    }
    function report() {
      window.webkit.messageHandlers.fixture.postMessage({ received, pasted, enter, inputs, screen: lines.join('\n') });
    }
    function append(text) {
      for (const character of text) {
        if (character === '\n' || character === '\r') lines.push('$ ');
        else lines[lines.length - 1] += character;
      }
      received += text;
      draw();
      report();
    }
    // Like xterm.js: take whatever the helper textarea received, then clear it, so reading its value back finds nothing.
    input.addEventListener('input', () => {
      inputs += 1;
      const value = input.value;
      input.value = '';
      if (value) append(value);
    });
    input.addEventListener('keydown', event => {
      if (event.key !== 'Enter' || event.isComposing) return;
      event.preventDefault();
      enter += 1;
      lines.push('$ ');
      draw();
      report();
    });
    input.addEventListener('paste', event => {
      event.preventDefault();
      const text = event.clipboardData.getData('text/plain');
      pasted.push(text);
      append(text);
    });
    document.addEventListener('mousedown', event => { event.preventDefault(); input.focus(); });
    window.addEventListener('resize', draw);
    draw();
    input.focus();
    report();
    </script></body></html>
    """#
}

let app = NSApplication.shared
let delegate = WebKitFixture()
app.setActivationPolicy(.regular)
app.delegate = delegate
app.run()
