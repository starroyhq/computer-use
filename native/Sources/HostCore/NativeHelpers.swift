import CoreGraphics
import Foundation

// 运行时通过同包宿主可执行文件的辅助模式使用本机能力（--paste-session、--recognize-text）。
// 这里是不依赖 AppKit 的部分：协议、状态和坐标换算，便于测试；系统调用在 ComputerUseHost 里。

// MARK: 剪贴板会话

/// 粘贴前保存的剪贴板内容：每一项的全部类型和数据，保持原来的顺序。
public struct PasteboardSnapshot: Equatable {
    public struct Entry: Equatable {
        public let type: String
        public let data: Data
        public init(type: String, data: Data) {
            self.type = type
            self.data = data
        }
    }
    public let items: [[Entry]]
    public init(items: [[Entry]]) { self.items = items }
}

public enum PasteboardRead: Equatable {
    /// complete 为 false 表示有的格式没有读到，恢复后会缺少这些格式。
    case snapshot(PasteboardSnapshot, complete: Bool)
    /// 剪贴板有内容却一项也读不到：用户在系统询问里拒绝，或系统设置拒绝本 App 读取。
    case denied
}

/// 剪贴板会话用到的系统剪贴板操作；测试用内存实现代替。
public protocol PasteboardStore: AnyObject {
    var changeCount: Int { get }
    /// 系统设置已明确拒绝本 App 读取剪贴板。此时不尝试读取。
    var readDenied: Bool { get }
    func read() -> PasteboardRead
    /// 清空剪贴板并写入要粘贴的文字（带临时内容标记）。返回写入后的 changeCount，失败时为 nil。
    func write(text: String) -> Int?
    /// 用保存的内容替换剪贴板。
    func restore(_ snapshot: PasteboardSnapshot) -> Bool
}

/// 一次粘贴的剪贴板会话，按行处理运行时的请求：
/// {"op":"stage","text":...,"restore":true} 保存剪贴板（restore 为 false 时不读取）并写入文字；
/// {"op":"finish","delayMs":800} 等目标应用读完后，只在剪贴板仍是我们写入的内容时换回原内容。
/// 输入提前结束（取消、出错、运行时退出）时立即换回。保存的内容只留在本进程，不会输出。
public final class PasteSession {
    /// 单次粘贴文字的上限（UTF-8 字节）。运行时限制为 100000 个字符。
    public static let textLimit = 1_048_576
    public static let delayLimitMs = 5_000

    private struct Request: Decodable {
        let op: String
        let text: String?
        let restore: Bool?
        let delayMs: Int?
    }

    private let store: PasteboardStore
    private let sleep: (TimeInterval) -> Void
    private var saved: PasteboardSnapshot?
    private var written: Int?
    private var staged = false
    public private(set) var finished = false

    public init(store: PasteboardStore, sleep: @escaping (TimeInterval) -> Void = { Thread.sleep(forTimeInterval: $0) }) {
        self.store = store
        self.sleep = sleep
    }

    /// 处理一行请求并返回一行回复（不含换行）。返回 nil 表示请求无效，调用方应结束会话。
    public func handle(_ line: Data) -> Data? {
        guard let request = try? JSONDecoder().decode(Request.self, from: line) else { return nil }
        switch request.op {
        case "stage":
            guard !staged, !finished, let text = request.text, !text.isEmpty, text.utf8.count <= Self.textLimit else { return nil }
            staged = true
            return Self.reply(stage(text, restore: request.restore ?? true))
        case "finish":
            guard staged, !finished else { return nil }
            return Self.reply(finish(delayMs: request.delayMs ?? 0))
        default:
            return nil
        }
    }

    private func stage(_ text: String, restore: Bool) -> [String: Any] {
        var complete = true
        if restore {
            if store.readDenied { return ["ok": false, "code": "read_denied"] }
            switch store.read() {
            case .denied: return ["ok": false, "code": "read_denied"]
            case .snapshot(let snapshot, let all):
                saved = snapshot
                complete = all
            }
        }
        guard let count = store.write(text: text) else {
            // 写入可能已经清空了剪贴板，尽量换回原内容。
            if let saved { _ = store.restore(saved) }
            saved = nil
            return ["ok": false, "code": "write_failed"]
        }
        written = count
        return ["ok": true, "complete": complete]
    }

    private func finish(delayMs: Int) -> [String: Any] {
        sleep(Double(min(max(delayMs, 0), Self.delayLimitMs)) / 1_000)
        return ["ok": true, "restored": restoreIfOurs()]
    }

    /// 输入结束。写入过文字但还没恢复时立即恢复。
    public func endOfInput() {
        guard !finished else { return }
        _ = restoreIfOurs()
    }

    // 期间用户或其他应用复制了新内容（changeCount 变了）时保留新内容，不覆盖。
    private func restoreIfOurs() -> Bool {
        finished = true
        defer { saved = nil }
        guard let saved, let written, store.changeCount == written else { return false }
        return store.restore(saved)
    }

    private static func reply(_ object: [String: Any]) -> Data? {
        try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
    }
}

// MARK: 文字识别

/// 识别出的一行文字，坐标是截图像素，原点在左上角，与快照的坐标空间一致。
public struct RecognizedLine: Encodable, Equatable {
    public let text: String
    public let x: Double
    public let y: Double
    public let width: Double
    public let height: Double

    /// normalized 是 Vision 的归一化矩形（原点在左下角）。
    public init(text: String, normalized: CGRect, imageWidth: Int, imageHeight: Int) {
        let width = Double(imageWidth), height = Double(imageHeight)
        let box = normalized.standardized
        let minX = min(max(Double(box.minX), 0), 1), maxX = min(max(Double(box.maxX), 0), 1)
        let minY = min(max(Double(box.minY), 0), 1), maxY = min(max(Double(box.maxY), 0), 1)
        self.text = text
        x = minX * width
        y = (1 - maxY) * height
        self.width = (maxX - minX) * width
        self.height = (maxY - minY) * height
    }

    /// 按阅读顺序排列：从上到下分行，同一行从左到右。竖直中心落在本行第一段高度范围内的算同一行，
    /// 这样同一行里高低略有差别的几段（例如 ls -l 输出的权限列和其余各列）不会被拆开。
    public static func ordered(_ lines: [RecognizedLine]) -> [RecognizedLine] {
        var rows: [[RecognizedLine]] = []
        for line in lines.sorted(by: { ($0.y, $0.x) < ($1.y, $1.x) }) {
            if let anchor = rows.last?.first, line.y + line.height / 2 < anchor.y + anchor.height {
                rows[rows.count - 1].append(line)
            } else {
                rows.append([line])
            }
        }
        return rows.flatMap { $0.sorted { $0.x < $1.x } }
    }

    /// 两行在竖直方向重叠至少较矮一行的一半，且水平方向相交：视为截图上的同一处文字。
    func overlaps(_ other: RecognizedLine) -> Bool {
        let top = max(y, other.y), bottom = min(y + height, other.y + other.height)
        let left = max(x, other.x), right = min(x + width, other.x + other.width)
        guard right > left, bottom > top else { return false }
        return bottom - top >= 0.5 * min(height, other.height)
    }

    /// 含非 ASCII 字母（汉字、假名、谚文、带重音的拉丁字母、西里尔字母等）。
    var hasNativeLetters: Bool {
        text.unicodeScalars.contains { $0.value > 0x7F && CharacterSet.letters.contains($0) }
    }

    /// 合并两遍识别。英文模型认代码、路径和命令更准（不会把 ls -la 认成 1s -1a），
    /// 但认不出中文等文字；用户语言的模型正相反。同一处文字只要用户语言那一遍认出了非 ASCII 字母，
    /// 就用那一遍的结果，其余位置用英文那一遍。
    public static func merge(primary: [RecognizedLine], secondary: [RecognizedLine]) -> [RecognizedLine] {
        let native = secondary.map(\.hasNativeLetters)
        var used = Set<Int>()
        var result: [RecognizedLine] = []
        for line in primary {
            let overlapping = secondary.indices.filter { line.overlaps(secondary[$0]) }
            if overlapping.contains(where: { native[$0] }) {
                for index in overlapping where used.insert(index).inserted { result.append(secondary[index]) }
            } else {
                result.append(line)
            }
        }
        // 英文那一遍完全没认出来的位置。
        for index in secondary.indices where native[index] && !used.contains(index) { result.append(secondary[index]) }
        return ordered(result)
    }

    /// 输出给运行时的单行 JSON。
    public static func encode(_ lines: [RecognizedLine]) throws -> Data {
        var data = try JSONEncoder().encode(["lines": ordered(lines)])
        data.append(10)
        return data
    }
}

public enum RecognitionLanguages {
    /// 第一遍固定用英文。第二遍用系统首选语言里第一个不是英文、识别器也支持的语言；没有时只识别一遍。
    public static func secondary(preferred: [String], supported: [String]) -> String? {
        for language in preferred {
            let parts = language.replacingOccurrences(of: "_", with: "-").split(separator: "-").map(String.init)
            guard let code = parts.first?.lowercased(), !code.isEmpty, code != "en" else { continue }
            let candidates = supported.filter {
                let lower = $0.lowercased()
                return lower == code || lower.hasPrefix(code + "-")
            }
            guard !candidates.isEmpty else { continue }
            // 中文等需要区分书写系统：优先用首选语言里的书写系统，没有时按地区判断繁简。
            var script = parts.dropFirst().first { $0.count == 4 }
            if script == nil, code == "zh" || code == "yue" {
                let region = parts.dropFirst().first { $0.count == 2 }?.uppercased()
                script = ["TW", "HK", "MO"].contains(region ?? "") ? "Hant" : "Hans"
            }
            if let script, let match = candidates.first(where: { $0.lowercased().contains("-" + script.lowercased()) }) {
                return match
            }
            return candidates.first
        }
        return nil
    }
}

/// 从标准输入读入全部内容，超过上限时返回 nil。
public enum BoundedInput {
    public static func readAll(from handle: FileHandle, limit: Int) throws -> Data? {
        var result = Data()
        while true {
            let chunk = try HostEventReader.readChunk(from: handle)
            if chunk.isEmpty { return result }
            guard result.count + chunk.count <= limit else { return nil }
            result.append(chunk)
        }
    }
}
