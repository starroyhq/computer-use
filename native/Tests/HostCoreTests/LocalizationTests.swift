import XCTest
@testable import HostCore

final class LocalizationTests: XCTestCase {
    private static let specifier = try! NSRegularExpression(pattern: "%(?:[0-9]+\\$)?(?:ld|lu|@|d)")

    private func specifiers(_ text: String) -> [String] {
        Self.specifier.matches(in: text, range: NSRange(text.startIndex..., in: text)).map { (text as NSString).substring(with: $0.range) }
    }

    func testBothLanguagesTranslateEveryKeyWithTheSamePlaceholders() {
        XCTAssertEqual(L10n.chinese.count, L10nKey.allCases.count)
        XCTAssertEqual(L10n.english.count, L10nKey.allCases.count)
        for key in L10nKey.allCases {
            guard let chinese = L10n.chinese[key], let english = L10n.english[key] else {
                XCTFail("Missing translation for \(key)")
                continue
            }
            XCTAssertFalse(chinese.isEmpty, "\(key)")
            XCTAssertFalse(english.isEmpty, "\(key)")
            XCTAssertEqual(specifiers(chinese), specifiers(english), "Placeholders differ for \(key)")
            // 没有注册的占位符（例如 %s）在 String(format:) 里会读错参数。
            XCTAssertFalse(chinese.replacingOccurrences(of: "%ld", with: "").replacingOccurrences(of: "%@", with: "").contains("%"), "\(key)")
            XCTAssertFalse(english.replacingOccurrences(of: "%ld", with: "").replacingOccurrences(of: "%@", with: "").contains("%"), "\(key)")
        }
    }

    func testLanguageFollowsTheFirstSupportedSystemLanguage() {
        XCTAssertEqual(HostLanguage.preferred(from: ["zh-Hans-CN", "en-US"]), .chinese)
        XCTAssertEqual(HostLanguage.preferred(from: ["zh-Hant-TW"]), .chinese)
        XCTAssertEqual(HostLanguage.preferred(from: ["zh_CN"]), .chinese)
        XCTAssertEqual(HostLanguage.preferred(from: ["ja-JP", "zh-Hans"]), .chinese)
        XCTAssertEqual(HostLanguage.preferred(from: ["ja-JP", "en-GB", "zh-Hans"]), .english)
        XCTAssertEqual(HostLanguage.preferred(from: ["fr-FR"]), .english)
        XCTAssertEqual(HostLanguage.preferred(from: ["zu-ZA"]), .english)
        XCTAssertEqual(HostLanguage.preferred(from: []), .english)
    }

    func testFormattingFillsPlaceholdersInEachLanguage() {
        XCTAssertEqual(L10n.format(.statusControlling, [3], language: .chinese), "正在操作 3 个应用")
        XCTAssertEqual(L10n.format(.statusControlling, [3], language: .english), "Controlling apps (3)")
        XCTAssertEqual(L10n.format(.updatesAvailable, ["0.5.0", "0.4.0"], language: .english), "Version 0.5.0 is available (you have 0.4.0).")
        XCTAssertEqual(L10n.format(.clientsRevokeTitle, ["Codex"], language: .chinese), "撤销“Codex”？")
        XCTAssertFalse(HostFailure.alreadyRunning.localizedDescription.isEmpty)
    }
}
