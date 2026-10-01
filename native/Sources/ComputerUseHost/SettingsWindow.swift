import AppKit
import HostCore

enum SettingsPane: Int, CaseIterable {
    case general, status, clients, connect, updates, about

    var title: String {
        switch self {
        case .general: return tr(.paneGeneral)
        case .status: return tr(.paneStatus)
        case .clients: return tr(.paneClients)
        case .connect: return tr(.paneConnect)
        case .updates: return tr(.paneUpdates)
        case .about: return tr(.paneAbout)
        }
    }

    var symbol: String {
        switch self {
        case .general: return "gearshape"
        case .status: return "checkmark.shield"
        case .clients: return "person.2"
        case .connect: return "link"
        case .updates: return "arrow.triangle.2.circlepath"
        case .about: return "info.circle"
        }
    }
}

/// 每个分区根据宿主状态刷新自己的控件。
protocol SettingsPaneView: AnyObject {
    func refresh()
}

/// 设置窗口：顶部工具栏图标切换 6 个分区，窗口高度随分区内容变化。
final class SettingsWindowController: NSWindowController, NSWindowDelegate {
    let tabs: SettingsTabViewController
    private var refreshTimer: Timer?

    init(context: HostContext) {
        tabs = SettingsTabViewController(context: context)
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: Form.pageWidth, height: 320),
                              styleMask: [.titled, .closable, .miniaturizable], backing: .buffered, defer: false)
        window.contentViewController = tabs
        window.toolbarStyle = .preference
        window.title = tr(.settingsTitle)
        window.isReleasedWhenClosed = false
        window.tabbingMode = .disallowed
        super.init(window: window)
        window.delegate = self
    }

    required init?(coder: NSCoder) { nil }

    func show(_ pane: SettingsPane?) {
        guard let window else { return }
        let wasVisible = window.isVisible
        if let pane { tabs.select(pane) }
        tabs.refreshAll()
        tabs.fitWindow(animated: wasVisible)
        if !wasVisible { window.center() }
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        startRefreshing()
    }

    func refresh() {
        guard window?.isVisible == true else { return }
        tabs.refreshAll()
        tabs.fitWindow(animated: true)
    }

    func windowDidBecomeKey(_ notification: Notification) { refresh() }

    func windowWillClose(_ notification: Notification) {
        refreshTimer?.invalidate()
        refreshTimer = nil
    }

    private func startRefreshing() {
        guard refreshTimer == nil else { return }
        // 系统设置里改动权限、登录项时没有通知；窗口打开期间定时刷新。
        refreshTimer = Timer.scheduledTimer(withTimeInterval: 2, repeats: true) { [weak self] _ in self?.refresh() }
    }
}

final class SettingsTabViewController: NSTabViewController {
    private var panes: [NSViewController & SettingsPaneView] = []

    init(context: HostContext) {
        super.init(nibName: nil, bundle: nil)
        tabStyle = .toolbar
        transitionOptions = []
        // 窗口标题固定为“设置”，不跟随分区名称变化。
        canPropagateSelectedChildViewControllerTitle = false
        title = tr(.settingsTitle)
        let controllers: [NSViewController & SettingsPaneView] = [
            GeneralPane(context: context), StatusPane(context: context), ClientsPane(context: context),
            ConnectPane(context: context), UpdatesPane(context: context), AboutPane(context: context),
        ]
        for (pane, controller) in zip(SettingsPane.allCases, controllers) {
            controller.title = pane.title
            let item = NSTabViewItem(viewController: controller)
            item.label = pane.title
            item.image = NSImage(systemSymbolName: pane.symbol, accessibilityDescription: pane.title)
            addTabViewItem(item)
        }
        panes = controllers
    }

    required init?(coder: NSCoder) { nil }

    func select(_ pane: SettingsPane) { selectedTabViewItemIndex = pane.rawValue }

    func refreshAll() {
        for pane in panes where pane.isViewLoaded { pane.refresh() }
    }

    override func tabView(_ tabView: NSTabView, didSelect tabViewItem: NSTabViewItem?) {
        super.tabView(tabView, didSelect: tabViewItem)
        (tabViewItem?.viewController as? SettingsPaneView)?.refresh()
        fitWindow(animated: true)
    }

    /// 让窗口内容区等于当前分区的合适大小，保持窗口顶边不动。
    func fitWindow(animated: Bool) {
        guard let window = view.window, let content = window.contentView,
              let pane = tabView.selectedTabViewItem?.viewController else { return }
        pane.view.layoutSubtreeIfNeeded()
        let size = pane.view.fittingSize
        let widthChange = size.width - content.frame.width
        let heightChange = size.height - content.frame.height
        guard abs(widthChange) > 0.5 || abs(heightChange) > 0.5 else { return }
        var frame = window.frame
        frame.size.width += widthChange
        frame.size.height += heightChange
        frame.origin.y -= heightChange
        window.setFrame(frame, display: true, animate: animated && window.isVisible)
    }
}

/// 表单布局：左列右对齐的标签，右列左对齐的控件（与系统设置窗口的传统样式一致）。
enum Form {
    static let pageWidth: CGFloat = 580
    static let textWidth: CGFloat = 380

    static func label(_ text: String) -> NSTextField {
        let label = NSTextField(labelWithString: text)
        label.alignment = .right
        return label
    }

    /// 说明文字：灰色小字，自动换行。
    static func note(_ text: String = "") -> NSTextField {
        let field = NSTextField(wrappingLabelWithString: text)
        field.textColor = .secondaryLabelColor
        field.font = .systemFont(ofSize: NSFont.smallSystemFontSize)
        field.preferredMaxLayoutWidth = textWidth
        field.isSelectable = false
        return field
    }

    /// 可选中复制的值（版本号、地址、状态）。
    static func value(_ text: String = "") -> NSTextField {
        let field = NSTextField(wrappingLabelWithString: text)
        field.preferredMaxLayoutWidth = textWidth
        field.isSelectable = true
        return field
    }

    /// 横向一组控件，宽度贴合内容（否则放进表单或居中的纵向栈时宽度不确定）。
    static func row(_ views: [NSView], spacing: CGFloat = 8) -> NSStackView {
        let stack = NSStackView(views: views)
        stack.orientation = .horizontal
        stack.alignment = .centerY
        stack.spacing = spacing
        stack.setHuggingPriority(.defaultHigh, for: .horizontal)
        stack.setHuggingPriority(.defaultHigh, for: .vertical)
        return stack
    }

    static func column(_ views: [NSView], spacing: CGFloat = 10) -> NSStackView {
        let stack = NSStackView(views: views)
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = spacing
        return stack
    }

    static func button(_ title: String, _ target: AnyObject, _ action: Selector) -> NSButton {
        NSButton(title: title, target: target, action: action)
    }

    static func checkbox(_ title: String, _ target: AnyObject, _ action: Selector) -> NSButton {
        NSButton(checkboxWithTitle: title, target: target, action: action)
    }

    /// 分区根视图：内容距顶部 20pt、水平居中；底部约束优先级较低，窗口动画改变高度时不会冲突。
    static func page(_ content: NSView, fill: Bool = false) -> NSView {
        let view = NSView()
        content.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(content)
        let bottom = content.bottomAnchor.constraint(equalTo: view.bottomAnchor, constant: -22)
        bottom.priority = .defaultHigh
        var constraints = [
            view.widthAnchor.constraint(equalToConstant: pageWidth),
            content.topAnchor.constraint(equalTo: view.topAnchor, constant: 22),
            bottom,
        ]
        if fill {
            constraints += [
                content.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 28),
                content.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -28),
            ]
        } else {
            constraints += [
                content.centerXAnchor.constraint(equalTo: view.centerXAnchor),
                content.leadingAnchor.constraint(greaterThanOrEqualTo: view.leadingAnchor, constant: 28),
            ]
        }
        NSLayoutConstraint.activate(constraints)
        return view
    }
}

/// 两列表单。每行一个标签（可为空）和一个控件；需要按状态显示的内容单独成行，隐藏整行即可。
final class FormBuilder {
    let grid = NSGridView(numberOfColumns: 2, rows: 0)

    init() {
        grid.rowSpacing = 10
        grid.columnSpacing = 10
        grid.rowAlignment = .firstBaseline
        grid.column(at: 0).xPlacement = .trailing
        grid.column(at: 1).xPlacement = .leading
    }

    /// - center: 右侧是一组控件（横向排列）时，改为垂直居中对齐标签。
    /// - gap: 与上一行之间额外的间距，用于分隔不同主题的设置。
    @discardableResult
    func add(_ label: String?, _ content: NSView, center: Bool = false, gap: CGFloat = 0) -> NSGridRow {
        let labelView: NSView = label.map { Form.label($0) } ?? NSGridCell.emptyContentView
        let row = grid.addRow(with: [labelView, content])
        if center {
            row.rowAlignment = .none
            row.yPlacement = .center
        }
        if gap > 0 { row.topPadding = gap }
        return row
    }
}
