import XCTest
@testable import HostCore

/// 内存剪贴板：记录读写次数，可以模拟拒绝读取、写入失败和期间被别人改写。
private final class FakePasteboard: PasteboardStore {
    var changeCount = 1
    var readDenied = false
    var readResult: PasteboardRead?
    var failWrite = false
    var contents: PasteboardSnapshot
    var reads = 0, writes = 0, restores = 0

    init(_ contents: PasteboardSnapshot) { self.contents = contents }

    func read() -> PasteboardRead {
        reads += 1
        return readResult ?? .snapshot(contents, complete: true)
    }

    func write(text: String) -> Int? {
        writes += 1
        changeCount += 1
        contents = PasteboardSnapshot(items: failWrite ? [] : [[.init(type: "public.utf8-plain-text", data: Data(text.utf8))]])
        return failWrite ? nil : changeCount
    }

    func restore(_ snapshot: PasteboardSnapshot) -> Bool {
        restores += 1
        changeCount += 1
        contents = snapshot
        return true
    }

    /// 用户在粘贴期间复制了别的内容。
    func userCopies(_ text: String) {
        changeCount += 1
        contents = PasteboardSnapshot(items: [[.init(type: "public.utf8-plain-text", data: Data(text.utf8))]])
    }
}

final class NativeHelperTests: XCTestCase {
    private let original = PasteboardSnapshot(items: [
        [.init(type: "public.utf8-plain-text", data: Data("user text".utf8)), .init(type: "public.html", data: Data("<b>user</b>".utf8))],
        [.init(type: "public.png", data: Data([0x89, 0x50, 0x4E, 0x47]))],
    ])

    private func reply(_ session: PasteSession, _ json: String) throws -> [String: Any] {
        let data = try XCTUnwrap(session.handle(Data(json.utf8)), "\(json) must be accepted")
        XCTAssertFalse(data.contains(10), "A reply is exactly one line")
        return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    func testPasteRestoresEveryItemAndTypeAfterTheDelay() throws {
        let board = FakePasteboard(original)
        var slept: [TimeInterval] = []
        let session = PasteSession(store: board) { slept.append($0) }
        let staged = try reply(session, #"{"op":"stage","text":"echo 你好","restore":true}"#)
        XCTAssertEqual(staged["ok"] as? Bool, true)
        XCTAssertEqual(staged["complete"] as? Bool, true)
        XCTAssertEqual(String(decoding: board.contents.items[0][0].data, as: UTF8.self), "echo 你好")
        let finished = try reply(session, #"{"op":"finish","delayMs":800}"#)
        XCTAssertEqual(finished["ok"] as? Bool, true)
        XCTAssertEqual(finished["restored"] as? Bool, true)
        XCTAssertEqual(slept, [0.8])
        XCTAssertEqual(board.contents, original)
        session.endOfInput()
        XCTAssertEqual(board.restores, 1, "Closing after finish must not restore twice")
    }

    func testPasteKeepsWhatTheUserCopiedMeanwhile() throws {
        let board = FakePasteboard(original)
        let session = PasteSession(store: board) { _ in board.userCopies("copied meanwhile") }
        _ = try reply(session, #"{"op":"stage","text":"ls","restore":true}"#)
        let finished = try reply(session, #"{"op":"finish","delayMs":800}"#)
        XCTAssertEqual(finished["restored"] as? Bool, false)
        XCTAssertEqual(board.restores, 0)
        XCTAssertEqual(String(decoding: board.contents.items[0][0].data, as: UTF8.self), "copied meanwhile")
    }

    func testPasteWithoutRestoreNeverReadsTheClipboard() throws {
        let board = FakePasteboard(original)
        board.readDenied = true
        let session = PasteSession(store: board) { _ in }
        let staged = try reply(session, #"{"op":"stage","text":"ls","restore":false}"#)
        XCTAssertEqual(staged["ok"] as? Bool, true)
        XCTAssertEqual(board.reads, 0)
        session.endOfInput()
        XCTAssertEqual(board.restores, 0)
        XCTAssertEqual(String(decoding: board.contents.items[0][0].data, as: UTF8.self), "ls")
    }

    func testDeniedReadsLeaveTheClipboardUntouched() throws {
        for configure in [{ (board: FakePasteboard) in board.readDenied = true }, { $0.readResult = .denied }] {
            let board = FakePasteboard(original)
            configure(board)
            let session = PasteSession(store: board) { _ in }
            let staged = try reply(session, #"{"op":"stage","text":"ls"}"#)
            XCTAssertEqual(staged["ok"] as? Bool, false)
            XCTAssertEqual(staged["code"] as? String, "read_denied")
            XCTAssertEqual(board.writes, 0)
            XCTAssertEqual(board.contents, original)
            session.endOfInput()
            XCTAssertEqual(board.restores, 0)
        }
    }

    func testPartialReadsAndWriteFailuresAreReported() throws {
        let partial = FakePasteboard(original)
        partial.readResult = .snapshot(PasteboardSnapshot(items: [[original.items[0][0]]]), complete: false)
        let first = PasteSession(store: partial) { _ in }
        XCTAssertEqual(try reply(first, #"{"op":"stage","text":"ls"}"#)["complete"] as? Bool, false)

        let failing = FakePasteboard(original)
        failing.failWrite = true
        let second = PasteSession(store: failing) { _ in }
        let staged = try reply(second, #"{"op":"stage","text":"ls"}"#)
        XCTAssertEqual(staged["code"] as? String, "write_failed")
        XCTAssertEqual(failing.contents, original, "A failed write puts the saved clipboard back")
        second.endOfInput()
        XCTAssertEqual(failing.restores, 1)
    }

    func testEndOfInputRestoresImmediatelyOnlyAfterAStage() throws {
        let untouched = FakePasteboard(original)
        PasteSession(store: untouched) { _ in }.endOfInput()
        XCTAssertEqual(untouched.restores, 0)

        let board = FakePasteboard(original)
        let session = PasteSession(store: board) { _ in XCTFail("Cancellation must not wait") }
        _ = try reply(session, #"{"op":"stage","text":"ls"}"#)
        session.endOfInput()
        XCTAssertEqual(board.contents, original)
        XCTAssertTrue(session.finished)
        XCTAssertNil(session.handle(Data(#"{"op":"finish","delayMs":0}"#.utf8)))
    }

    func testInvalidRequestsEndTheSession() throws {
        let board = FakePasteboard(original)
        let session = PasteSession(store: board) { _ in }
        for invalid in ["not json", #"{"op":"finish"}"#, #"{"op":"stage","text":""}"#, #"{"op":"read"}"#, #"{"op":"stage"}"#] {
            XCTAssertNil(session.handle(Data(invalid.utf8)), invalid)
        }
        let huge = String(repeating: "x", count: PasteSession.textLimit + 1)
        XCTAssertNil(session.handle(try JSONSerialization.data(withJSONObject: ["op": "stage", "text": huge])))
        XCTAssertEqual(board.writes, 0)
        _ = try reply(session, #"{"op":"stage","text":"ls"}"#)
        XCTAssertNil(session.handle(Data(#"{"op":"stage","text":"again"}"#.utf8)), "One session stages once")
        var slept: TimeInterval = 0
        let delayed = PasteSession(store: FakePasteboard(original)) { slept = $0 }
        _ = try reply(delayed, #"{"op":"stage","text":"ls"}"#)
        _ = try reply(delayed, #"{"op":"finish","delayMs":600000}"#)
        XCTAssertEqual(slept, 5, "The restore delay is bounded")
    }

    func testRecognizedLinesUseTopLeftImagePixelsInReadingOrder() throws {
        // Vision 的归一化矩形原点在左下角。
        let lower = RecognizedLine(text: "second", normalized: CGRect(x: 0.1, y: 0.1, width: 0.5, height: 0.1), imageWidth: 1000, imageHeight: 500)
        XCTAssertEqual(lower.x, 100, accuracy: 0.001)
        XCTAssertEqual(lower.y, 400, accuracy: 0.001)
        XCTAssertEqual(lower.width, 500, accuracy: 0.001)
        XCTAssertEqual(lower.height, 50, accuracy: 0.001)
        let upper = RecognizedLine(text: "first", normalized: CGRect(x: 0.6, y: 0.8, width: 0.6, height: 0.3), imageWidth: 1000, imageHeight: 500)
        XCTAssertEqual(upper.y, 0, accuracy: 0.001, "Boxes are clamped to the image")
        XCTAssertEqual(upper.width, 400, accuracy: 0.001)
        let data = try RecognizedLine.encode([lower, upper])
        XCTAssertEqual(data.last, 10)
        XCTAssertEqual(data.filter { $0 == 10 }.count, 1)
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: [[String: Any]]])
        XCTAssertEqual(object["lines"]?.map { $0["text"] as? String }, ["first", "second"])
    }

    func testSegmentsOfOneVisualRowStayTogetherLeftToRight() {
        // 实测：ls -l 输出的一行被识别成两段，右边一段的框比左边高 8 像素。
        func line(_ text: String, _ x: Double, _ y: Double, _ height: Double) -> RecognizedLine {
            RecognizedLine(text: text, normalized: CGRect(x: x / 1000, y: 1 - (y + height) / 1000, width: 0.1, height: height / 1000), imageWidth: 1000, imageHeight: 1000)
        }
        let lines = [line("5 kouzen staff", 162, 92, 32), line("echo", 20, 154, 30), line("drwxr-xr-x", 18, 100, 18), line("prompt %", 20, 38, 24)]
        XCTAssertEqual(RecognizedLine.ordered(lines).map(\.text), ["prompt %", "drwxr-xr-x", "5 kouzen staff", "echo"])
    }

    func testMergePrefersUserLanguageOnlyWhereItReadNonASCIILetters() {
        func line(_ text: String, _ x: Double, _ y: Double, _ width: Double = 400) -> RecognizedLine {
            RecognizedLine(text: text, normalized: CGRect(x: x / 1000, y: 1 - (y + 20) / 1000, width: width / 1000, height: 0.02), imageWidth: 1000, imageHeight: 1000)
        }
        let english = [line("% ls -la src", 10, 10), line("1$] , Ш#", 10, 50), line("drwxr-xr-x", 10, 90), line("hi: hTEX1 config.json", 10, 130)]
        let chinese = [line("% 1s -1a src", 10, 10), line("你好，世界", 10, 50), line("drwxr-Xr-X", 10, 90),
                       line("错误：找不到文件", 10, 130, 200), line("config.json", 220, 130, 190), line("标题", 600, 300, 100)]
        let merged = RecognizedLine.merge(primary: english, secondary: chinese).map(\.text)
        XCTAssertEqual(merged, ["% ls -la src", "你好，世界", "drwxr-xr-x", "错误：找不到文件", "config.json", "标题"])
        XCTAssertEqual(RecognizedLine.merge(primary: english, secondary: []).map(\.text), english.map(\.text))
    }

    func testSecondRecognitionLanguageFollowsTheFirstNonEnglishPreference() {
        let supported = ["en-US", "fr-FR", "zh-Hans", "zh-Hant", "yue-Hant", "ja-JP", "ko-KR", "pt-BR"]
        XCTAssertEqual(RecognitionLanguages.secondary(preferred: ["zh-Hans-CN", "en-US"], supported: supported), "zh-Hans")
        XCTAssertEqual(RecognitionLanguages.secondary(preferred: ["en-CN", "zh-Hant-TW"], supported: supported), "zh-Hant")
        XCTAssertEqual(RecognitionLanguages.secondary(preferred: ["zh_HK"], supported: supported), "zh-Hant")
        XCTAssertEqual(RecognitionLanguages.secondary(preferred: ["zh-CN"], supported: supported), "zh-Hans")
        XCTAssertEqual(RecognitionLanguages.secondary(preferred: ["ja"], supported: supported), "ja-JP")
        XCTAssertEqual(RecognitionLanguages.secondary(preferred: ["pt-PT"], supported: supported), "pt-BR")
        XCTAssertEqual(RecognitionLanguages.secondary(preferred: ["eo", "ko-KR"], supported: supported), "ko-KR")
        XCTAssertNil(RecognitionLanguages.secondary(preferred: ["en-GB", "en-US"], supported: supported))
        XCTAssertNil(RecognitionLanguages.secondary(preferred: [], supported: supported))
    }

    func testBoundedInputStopsAtTheLimit() throws {
        let pipe = Pipe()
        try pipe.fileHandleForWriting.write(contentsOf: Data(repeating: 1, count: 10))
        try pipe.fileHandleForWriting.close()
        XCTAssertEqual(try BoundedInput.readAll(from: pipe.fileHandleForReading, limit: 10)?.count, 10)
        let small = Pipe()
        try small.fileHandleForWriting.write(contentsOf: Data(repeating: 1, count: 11))
        try small.fileHandleForWriting.close()
        XCTAssertNil(try BoundedInput.readAll(from: small.fileHandleForReading, limit: 10))
    }
}
