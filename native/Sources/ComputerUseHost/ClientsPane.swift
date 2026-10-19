import AppKit
import HostCore

/// 客户端授权页：每个已配对客户端一张卡片，主操作直接出现在卡片上。
/// 精确范围与应用清单放在默认折叠的“高级”区，避免默认界面依赖选中行和底部按钮。
final class ClientsPane: PaneController, SettingsPaneView, NSSearchFieldDelegate, NSTableViewDataSource, NSTableViewDelegate {
    typealias RevokeConfirmation = (ClientRecord) -> Bool

    private static let contentWidth = Form.pageWidth - 56
    // 手动测量内容并更新行高，避免 AppKit 自调整行高在收起“高级”后缓存旧高度。
    // 这些值只作为最小高度；换行后的应用范围和操作反馈可以继续撑开卡片。
    private static let collapsedRowHeight: CGFloat = 124
    private static let expandedRowHeight: CGFloat = 300

    private let searchField = NSSearchField()
    private let scroll = NSScrollView()
    private let table = NSTableView()
    private let placeholder = Form.note()
    private let fallbackFeedback = Form.note()
    private lazy var hint = Form.note(tr(.clientsHint))
    private var rows: [ClientRecord] = []
    private var cards: [ClientCardView] = []
    private var rowHeights: [CGFloat] = []
    private var cardsByID: [String: ClientCardView] = [:]
    private var expanded: Set<String> = []
    private var lastQuery = ""
    private let confirmRevoke: RevokeConfirmation

    init(context: HostContext, confirmRevoke: @escaping RevokeConfirmation = ClientsPane.defaultRevokeConfirmation) {
        self.confirmRevoke = confirmRevoke
        super.init(context: context)
    }

    required init?(coder: NSCoder) { nil }

    static func defaultRevokeConfirmation(_ client: ClientRecord) -> Bool {
        Alerts.confirm(tr(.clientsRevokeTitle, client.name), tr(.clientsRevokeBody),
                       confirm: tr(.clientsRevoke).replacingOccurrences(of: "…", with: ""),
                       destructive: true)
    }

    override func loadView() {
        searchField.placeholderString = tr(.clientsSearchPlaceholder)
        searchField.delegate = self
        searchField.identifier = NSUserInterfaceItemIdentifier("clients-search")
        searchField.setAccessibilityLabel(tr(.clientsSearchPlaceholder))
        searchField.translatesAutoresizingMaskIntoConstraints = false

        let column = NSTableColumn(identifier: NSUserInterfaceItemIdentifier("clients-column"))
        column.resizingMask = .autoresizingMask
        table.addTableColumn(column)
        table.headerView = nil
        table.selectionHighlightStyle = .none
        table.allowsEmptySelection = true
        table.backgroundColor = .clear
        table.usesAlternatingRowBackgroundColors = false
        table.rowHeight = Self.collapsedRowHeight
        table.usesAutomaticRowHeights = false
        table.intercellSpacing = NSSize(width: 0, height: 10)
        table.style = .plain
        table.dataSource = self
        table.delegate = self
        table.identifier = NSUserInterfaceItemIdentifier("clients-list")
        scroll.documentView = table
        scroll.hasVerticalScroller = true
        scroll.autohidesScrollers = true
        scroll.drawsBackground = false
        scroll.borderType = .noBorder
        scroll.identifier = NSUserInterfaceItemIdentifier("clients-list")
        scroll.translatesAutoresizingMaskIntoConstraints = false
        scroll.heightAnchor.constraint(equalToConstant: 380).isActive = true

        placeholder.identifier = NSUserInterfaceItemIdentifier("clients-placeholder")
        placeholder.preferredMaxLayoutWidth = Self.contentWidth
        fallbackFeedback.identifier = NSUserInterfaceItemIdentifier("clients-grant-feedback")
        fallbackFeedback.preferredMaxLayoutWidth = Self.contentWidth
        hint.preferredMaxLayoutWidth = Self.contentWidth

        let stack = Form.column([searchField, scroll, placeholder, fallbackFeedback, hint], spacing: 12)
        for view in [searchField, scroll, placeholder, fallbackFeedback, hint] as [NSView] {
            view.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
        }
        view = Form.page(stack, fill: true)
    }

    func refresh() {
        guard isViewLoaded else { return }
        let all = context.isRunning ? context.clients : []
        let query = searchField.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        let filtered = query.isEmpty ? all : all.filter { Self.matches($0, query: query) }

        // 删掉的客户端不再保留展开状态；被搜索过滤掉的客户端保留，清空搜索后可恢复。
        expanded.formIntersection(Set(all.map(\.id)))

        if filtered != rows {
            let origin = scroll.contentView.bounds.origin
            rows = filtered
            rebuildCards()
            scroll.contentView.scroll(to: origin)
        }
        if query != lastQuery {
            lastQuery = query
            scrollToTop()
        }
        updatePlaceholder(allCount: all.count)
        updateCards()
        updateFallbackFeedback(all: all)
    }

    // MARK: 状态

    private func rebuildCards() {
        cards.removeAll()
        cardsByID.removeAll()
        rowHeights = rows.map { expanded.contains($0.id) ? Self.expandedRowHeight : Self.collapsedRowHeight }
        for client in rows {
            let card = ClientCardView()
            card.onGrant = { [weak self] in self?.grant(client.id) }
            card.onRevoke = { [weak self] in self?.revoke(client.id) }
            card.onToggleAdvanced = { [weak self] in self?.toggleAdvanced(client.id) }
            cards.append(card)
            cardsByID[client.id] = card
        }
        table.reloadData()
    }

    private func updateCards() {
        let state = context.clientGrantState
        for (index, client) in rows.enumerated() where index < cards.count {
            cards[index].update(Self.presentation(client: client, state: state, isRunning: context.isRunning),
                                expanded: expanded.contains(client.id))
        }
        updateRowHeights()
    }

    private func updateRowHeights() {
        let columnWidth = table.tableColumns.first?.width ?? Self.contentWidth
        let width = columnWidth >= 200 ? columnWidth : Self.contentWidth
        let measured = rows.enumerated().map { row, client in
            let minimum = expanded.contains(client.id) ? Self.expandedRowHeight : Self.collapsedRowHeight
            return max(minimum, cards[row].requiredHeight(forWidth: width))
        }
        let changed = IndexSet(measured.indices.filter { row in
            row >= rowHeights.count || abs(rowHeights[row] - measured[row]) > 0.5
        })
        // 在通知表格之前发布全部新高度；delegate 只读缓存，不在查询期间触发布局。
        rowHeights = measured
        guard !changed.isEmpty else { return }
        // 连续展开/收起时不叠加行高动画，避免旧动画把卡片留在错误的高度。
        NSAnimationContext.runAnimationGroup { animation in
            animation.duration = 0
            table.noteHeightOfRows(withIndexesChanged: changed)
            table.layoutSubtreeIfNeeded()
        }
    }

    /// 测试与快照使用的只读入口；不改变生产路径。
    var displayedClientIDs: [String] { rows.map(\.id) }

    func cardView(for clientID: String) -> ClientCardView? { cardsByID[clientID] }

    func numberOfRows(in tableView: NSTableView) -> Int { rows.count }

    func tableView(_ tableView: NSTableView, viewFor tableColumn: NSTableColumn?, row: Int) -> NSView? {
        guard row >= 0, row < cards.count else { return nil }
        return cards[row]
    }

    func tableView(_ tableView: NSTableView, heightOfRow row: Int) -> CGFloat {
        guard row >= 0, row < rowHeights.count else { return Self.collapsedRowHeight }
        return rowHeights[row]
    }

    func tableViewColumnDidResize(_ notification: Notification) {
        // 列宽通知可能发生在表格布局内，等该轮布局结束后再测量并通知行高变化。
        DispatchQueue.main.async { [weak self] in self?.updateRowHeights() }
    }

    private func updatePlaceholder(allCount: Int) {
        let text: String
        if !context.isRunning { text = tr(.clientsNotRunning) }
        else if allCount == 0 { text = tr(.clientsEmpty) }
        else if rows.isEmpty { text = tr(.clientsNoMatches) }
        else { text = "" }
        placeholder.stringValue = text
        placeholder.isHidden = text.isEmpty
        scroll.isHidden = rows.isEmpty
        searchField.isEnabled = context.isRunning && allCount > 0
    }

    /// 升级操作完成后客户端可能已被撤销；此时把结果保留在页面底部，避免反馈随卡片一起消失。
    private func updateFallbackFeedback(all: [ClientRecord]) {
        let state = context.clientGrantState
        guard let id = state.clientID, !all.contains(where: { $0.id == id }) else {
            fallbackFeedback.stringValue = ""
            fallbackFeedback.isHidden = true
            return
        }
        let text: String
        switch state {
        case .idle, .pending:
            text = ""
        case .succeeded:
            text = tr(.clientsGrantSucceeded)
        case .unconfirmed:
            text = tr(.clientsGrantUnconfirmed)
        case .failed(_, let code):
            text = code == "not_found" || code == "unauthorized" ? tr(.clientsGrantUnavailable) : tr(.clientsGrantFailed)
        }
        fallbackFeedback.stringValue = text
        fallbackFeedback.isHidden = text.isEmpty
    }

    private func scrollToTop() {
        scroll.contentView.scroll(to: NSPoint(x: 0, y: 0))
        scroll.reflectScrolledClipView(scroll.contentView)
    }

    // MARK: 动作

    private func grant(_ id: String) {
        guard context.isRunning, !context.clientGrantState.isPending,
              let client = context.clients.first(where: { $0.id == id }), client.canGrantAllApps else { return }
        context.grantAllApps(id)
        refresh()
    }

    private func revoke(_ id: String) {
        guard context.isRunning, let client = context.clients.first(where: { $0.id == id }),
              confirmRevoke(client) else { return }
        expanded.remove(id)
        context.revokeClient(id)
        refresh()
    }

    private func toggleAdvanced(_ id: String) {
        if expanded.contains(id) { expanded.remove(id) } else { expanded.insert(id) }
        updateCards()
        table.layoutSubtreeIfNeeded()
    }

    // MARK: 搜索

    func controlTextDidChange(_ notification: Notification) {
        refresh()
    }

    private static func matches(_ client: ClientRecord, query: String) -> Bool {
        let options: String.CompareOptions = [.caseInsensitive, .diacriticInsensitive]
        return [client.name, client.shortID, client.id].contains { $0.range(of: query, options: options) != nil }
            || (client.appIds ?? []).contains { $0.range(of: query, options: options) != nil }
    }

    // MARK: 展示模型

    static func presentation(client: ClientRecord, state: ClientGrantState, isRunning: Bool) -> ClientCardPresentation {
        let apps = client.appIds ?? []
        let desktopSummary: String
        let desktopDetail: String
        let badge: String
        if client.allApps == true {
            desktopSummary = tr(.clientsAllApps)
            desktopDetail = tr(.clientsAllApps)
            badge = tr(.clientsAllApps)
        } else if !apps.isEmpty {
            desktopSummary = tr(.clientsAppCount, apps.count)
            desktopDetail = apps.count <= 8
                ? apps.joined(separator: ", ")
                : apps.prefix(8).joined(separator: ", ") + "…"
            badge = tr(.clientsBadgeRestricted, apps.count)
        } else if client.browser == true {
            desktopSummary = tr(.clientsNo)
            desktopDetail = tr(.clientsNo)
            badge = tr(.clientsBadgeBrowserOnly)
        } else {
            desktopSummary = tr(.clientsNo)
            desktopDetail = tr(.clientsNo)
            badge = tr(.clientsNo)
        }
        let browser = client.browser == true ? tr(.clientsYes) : tr(.clientsNo)
        let foreground = client.foreground == true ? tr(.clientsYes) : tr(.clientsNo)
        let summary = tr(.clientsSummary, desktopSummary, browser, foreground)

        let action: ClientCardPresentation.Action
        if client.hasAllAppsAccess {
            action = .already
        } else if client.canGrantAllApps {
            action = .upgrade(title: tr(.clientsGrantAllApps), enabled: isRunning && !state.isPending)
        } else if client.browser == true && !client.hasDesktopAccess {
            action = .browserOnly
        } else {
            action = .unavailable
        }

        var feedback = ""
        var feedbackTone = ClientCardPresentation.Tone.neutral
        if state.clientID == client.id {
            switch state {
            case .idle:
                break
            case .pending:
                feedback = tr(.clientsGrantPending)
            case .succeeded:
                feedback = tr(.clientsGrantSucceeded)
                feedbackTone = .success
            case .unconfirmed:
                feedback = tr(.clientsGrantUnconfirmed)
                feedbackTone = .warning
            case .failed(_, let code):
                feedback = code == "not_found" || code == "unauthorized"
                    ? tr(.clientsGrantUnavailable) : tr(.clientsGrantFailed)
                feedbackTone = .error
            }
        }

        let details = [
            tr(.clientsDetailLine, tr(.clientsDesktopApps), desktopDetail),
            tr(.clientsDetailLine, tr(.clientsBrowser), browser),
            tr(.clientsDetailLine, tr(.clientsForeground), foreground),
            tr(.clientsDetailLine, tr(.clientsID), client.id),
        ].joined(separator: "\n")

        return ClientCardPresentation(
            id: client.id,
            name: client.name,
            shortID: client.shortID,
            badge: badge,
            summary: summary,
            action: action,
            feedback: feedback,
            feedbackTone: feedbackTone,
            details: details,
            detailsToolTip: apps.count > 8 ? apps.joined(separator: ", ") : "",
            restrictedNote: tr(.clientsRestrictedNote),
            canRevoke: isRunning
        )
    }
}

/// 一张客户端卡片的纯展示数据，不依赖 AppKit，便于单元测试与快照复用。
struct ClientCardPresentation {
    enum Action {
        case upgrade(title: String, enabled: Bool)
        case already
        case browserOnly
        case unavailable
    }

    enum Tone {
        case neutral, success, warning, error
    }

    let id: String
    let name: String
    let shortID: String
    let badge: String
    let summary: String
    let action: Action
    let feedback: String
    let feedbackTone: Tone
    let details: String
    let detailsToolTip: String
    let restrictedNote: String
    let canRevoke: Bool
}

/// 客户端卡片。按钮只回调 pane，不直接持有宿主上下文。
final class ClientCardView: NSView {
    private static let innerWidth = Form.pageWidth - 56 - 24

    private let nameLabel = NSTextField(labelWithString: "")
    private let idLabel = NSTextField(labelWithString: "")
    private let badgeLabel = NSTextField(labelWithString: "")
    private let summaryLabel = NSTextField(labelWithString: "")
    private let grantButton = NSButton()
    private let statusLabel = NSTextField(labelWithString: "")
    private let advancedButton = NSButton()
    private let feedbackLabel = NSTextField(wrappingLabelWithString: "")
    private let detailsLabel = NSTextField(wrappingLabelWithString: "")
    private let restrictedNote = NSTextField(wrappingLabelWithString: "")
    private let revokeButton = NSButton()
    private let advancedPanel = NSStackView()
    private let content = NSStackView()
    private var contentWidth = ClientCardView.innerWidth

    var onGrant: (() -> Void)?
    var onRevoke: (() -> Void)?
    var onToggleAdvanced: (() -> Void)?

    override var isFlipped: Bool { true }

    init() {
        super.init(frame: .zero)
        setAccessibilityElement(true)
        setAccessibilityRole(.group)
        build()
    }

    required init?(coder: NSCoder) { nil }

    override func draw(_ dirtyRect: NSRect) {
        let rect = bounds.insetBy(dx: 0.5, dy: 0.5)
        guard rect.width > 0, rect.height > 0 else { return }
        let path = NSBezierPath(roundedRect: rect, xRadius: 8, yRadius: 8)
        NSColor.controlBackgroundColor.setFill()
        path.fill()
        NSColor.separatorColor.setStroke()
        path.lineWidth = 1
        path.stroke()
    }

    override func layout() {
        let width = bounds.width - 24
        if width > 0, abs(width - contentWidth) > 0.5 {
            contentWidth = width
            for label in [feedbackLabel, detailsLabel, restrictedNote] {
                label.preferredMaxLayoutWidth = width
            }
        }
        super.layout()
    }

    func requiredHeight(forWidth width: CGFloat) -> CGFloat {
        setFrameSize(NSSize(width: width, height: bounds.height))
        layoutSubtreeIfNeeded()
        // content 只约束顶部，测量自然高度后为卡片上下各留 10pt。
        return ceil(content.fittingSize.height) + 20
    }

    private func build() {
        nameLabel.font = .systemFont(ofSize: NSFont.systemFontSize, weight: .semibold)
        nameLabel.lineBreakMode = .byTruncatingTail
        nameLabel.setContentHuggingPriority(.defaultLow, for: .horizontal)
        nameLabel.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)

        idLabel.font = .monospacedSystemFont(ofSize: NSFont.smallSystemFontSize, weight: .regular)
        idLabel.textColor = .secondaryLabelColor
        idLabel.lineBreakMode = .byTruncatingTail
        idLabel.setContentHuggingPriority(.defaultHigh, for: .horizontal)

        badgeLabel.font = .systemFont(ofSize: NSFont.smallSystemFontSize, weight: .semibold)
        badgeLabel.textColor = .secondaryLabelColor
        badgeLabel.setContentHuggingPriority(.required, for: .horizontal)
        badgeLabel.setContentCompressionResistancePriority(.defaultHigh, for: .horizontal)
        badgeLabel.lineBreakMode = .byTruncatingTail

        summaryLabel.font = .systemFont(ofSize: NSFont.smallSystemFontSize)
        summaryLabel.textColor = .secondaryLabelColor
        summaryLabel.lineBreakMode = .byTruncatingTail

        grantButton.bezelStyle = .rounded
        grantButton.controlSize = .large
        grantButton.target = self
        grantButton.action = #selector(grantClicked)
        grantButton.setContentHuggingPriority(.required, for: .horizontal)

        statusLabel.font = .systemFont(ofSize: NSFont.smallSystemFontSize)
        statusLabel.textColor = .secondaryLabelColor
        statusLabel.lineBreakMode = .byTruncatingTail
        statusLabel.isHidden = true

        advancedButton.title = tr(.clientsAdvanced)
        advancedButton.setButtonType(.toggle)
        advancedButton.isBordered = false
        advancedButton.imagePosition = .imageTrailing
        advancedButton.image = NSImage(systemSymbolName: "chevron.right", accessibilityDescription: nil)
        advancedButton.contentTintColor = .secondaryLabelColor
        advancedButton.target = self
        advancedButton.action = #selector(advancedClicked)

        feedbackLabel.font = .systemFont(ofSize: NSFont.smallSystemFontSize)
        feedbackLabel.preferredMaxLayoutWidth = Self.innerWidth
        feedbackLabel.isHidden = true

        detailsLabel.font = .monospacedSystemFont(ofSize: NSFont.smallSystemFontSize, weight: .regular)
        detailsLabel.isSelectable = true
        detailsLabel.preferredMaxLayoutWidth = Self.innerWidth

        restrictedNote.font = .systemFont(ofSize: NSFont.smallSystemFontSize)
        restrictedNote.textColor = .secondaryLabelColor
        restrictedNote.preferredMaxLayoutWidth = Self.innerWidth

        revokeButton.title = tr(.clientsRevoke)
        revokeButton.bezelStyle = .rounded
        revokeButton.target = self
        revokeButton.action = #selector(revokeClicked)

        advancedPanel.orientation = .vertical
        advancedPanel.alignment = .leading
        advancedPanel.spacing = 6
        advancedPanel.detachesHiddenViews = true
        advancedPanel.addArrangedSubview(detailsLabel)
        advancedPanel.addArrangedSubview(restrictedNote)
        advancedPanel.addArrangedSubview(revokeButton)
        advancedPanel.isHidden = true

        let headerSpacer = NSView()
        headerSpacer.setContentHuggingPriority(NSLayoutConstraint.Priority(1), for: .horizontal)
        headerSpacer.setContentCompressionResistancePriority(NSLayoutConstraint.Priority(1), for: .horizontal)
        let header = NSStackView(views: [nameLabel, idLabel, headerSpacer, badgeLabel, advancedButton])
        header.orientation = .horizontal
        header.alignment = .centerY
        header.spacing = 8
        header.detachesHiddenViews = true

        let actionRow = NSStackView(views: [grantButton, statusLabel])
        actionRow.orientation = .horizontal
        actionRow.alignment = .centerY
        actionRow.spacing = 8
        actionRow.detachesHiddenViews = true

        for view in [header, summaryLabel, actionRow, feedbackLabel, advancedPanel] {
            content.addArrangedSubview(view)
        }
        content.orientation = .vertical
        content.alignment = .leading
        content.spacing = 8
        content.detachesHiddenViews = true
        content.translatesAutoresizingMaskIntoConstraints = false
        addSubview(content)
        NSLayoutConstraint.activate([
            content.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 12),
            content.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -12),
            content.topAnchor.constraint(equalTo: topAnchor, constant: 10),
            header.widthAnchor.constraint(equalTo: content.widthAnchor),
            summaryLabel.widthAnchor.constraint(equalTo: content.widthAnchor),
            actionRow.widthAnchor.constraint(equalTo: content.widthAnchor),
            feedbackLabel.widthAnchor.constraint(equalTo: content.widthAnchor),
            advancedPanel.widthAnchor.constraint(equalTo: content.widthAnchor),
        ])
    }

    func update(_ presentation: ClientCardPresentation, expanded: Bool) {
        identifier = NSUserInterfaceItemIdentifier("clients-card-\(presentation.id)")
        setAccessibilityLabel("\(presentation.name) \(presentation.shortID)")
        nameLabel.stringValue = presentation.name
        nameLabel.toolTip = presentation.name
        idLabel.stringValue = presentation.shortID
        idLabel.toolTip = presentation.id
        idLabel.identifier = NSUserInterfaceItemIdentifier("clients-id-\(presentation.id)")
        badgeLabel.stringValue = presentation.badge
        badgeLabel.identifier = NSUserInterfaceItemIdentifier("clients-badge-\(presentation.id)")
        summaryLabel.stringValue = presentation.summary
        summaryLabel.toolTip = presentation.summary
        summaryLabel.identifier = NSUserInterfaceItemIdentifier("clients-summary-\(presentation.id)")
        statusLabel.identifier = NSUserInterfaceItemIdentifier("clients-status-\(presentation.id)")
        feedbackLabel.stringValue = presentation.feedback
        feedbackLabel.isHidden = presentation.feedback.isEmpty
        feedbackLabel.identifier = NSUserInterfaceItemIdentifier("clients-feedback-\(presentation.id)")
        switch presentation.feedbackTone {
        case .neutral: feedbackLabel.textColor = .secondaryLabelColor
        case .success: feedbackLabel.textColor = .systemGreen
        case .warning: feedbackLabel.textColor = .systemOrange
        case .error: feedbackLabel.textColor = .systemRed
        }
        detailsLabel.stringValue = presentation.details
        detailsLabel.toolTip = presentation.detailsToolTip.isEmpty ? nil : presentation.detailsToolTip
        detailsLabel.identifier = NSUserInterfaceItemIdentifier("clients-scope-\(presentation.id)")
        restrictedNote.stringValue = presentation.restrictedNote
        revokeButton.isEnabled = presentation.canRevoke
        revokeButton.identifier = NSUserInterfaceItemIdentifier("clients-revoke-\(presentation.id)")
        revokeButton.toolTip = tr(.clientsRevoke)

        switch presentation.action {
        case let .upgrade(title, enabled):
            grantButton.title = title
            grantButton.isHidden = false
            grantButton.isEnabled = enabled
            grantButton.toolTip = nil
            grantButton.setAccessibilityLabel("\(title) \(presentation.name) \(presentation.shortID)")
            statusLabel.isHidden = true
        case .already:
            grantButton.isHidden = true
            statusLabel.stringValue = tr(.clientsGrantAlready)
            statusLabel.toolTip = nil
            statusLabel.isHidden = false
        case .browserOnly:
            grantButton.isHidden = true
            statusLabel.stringValue = tr(.clientsGrantBrowserOnly)
            statusLabel.toolTip = tr(.clientsGrantBrowserOnly)
            statusLabel.isHidden = false
        case .unavailable:
            grantButton.isHidden = true
            statusLabel.stringValue = ""
            statusLabel.isHidden = true
        }
        grantButton.identifier = NSUserInterfaceItemIdentifier("clients-grant-\(presentation.id)")

        advancedButton.state = expanded ? .on : .off
        advancedButton.image = NSImage(systemSymbolName: expanded ? "chevron.down" : "chevron.right",
                                       accessibilityDescription: nil)
        advancedButton.identifier = NSUserInterfaceItemIdentifier("clients-advanced-toggle-\(presentation.id)")
        advancedButton.setAccessibilityLabel("\(tr(.clientsAdvanced)) \(presentation.name) \(presentation.shortID)")
        advancedButton.toolTip = tr(.clientsAdvanced)
        advancedPanel.identifier = NSUserInterfaceItemIdentifier("clients-advanced-panel-\(presentation.id)")
        advancedPanel.isHidden = !expanded
    }

    @objc private func grantClicked() { onGrant?() }
    @objc private func revokeClicked() { onRevoke?() }
    @objc private func advancedClicked() { onToggleAdvanced?() }
}
