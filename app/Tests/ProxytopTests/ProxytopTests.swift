import Foundation
@testable import Proxytop

#if canImport(Testing)
import Testing

@Suite("Proxytop")
struct ProxytopTests {
  @Test func fixtureDecodesNewContract() throws {
    let snapshot = try JSONDecoder().decode(DaemonSnapshot.self, from: fixtureData())
    #expect(snapshot.apps.first?.verdict == "BYPASSED")
    #expect(snapshot.apps.first?.control == "controller")
    #expect(snapshot.errors.count == 2)
    #expect(snapshot.statuses.snapshot == "degraded (2 errors)")
  }

  @Test func missingErrorsDecodeAsEmpty() throws {
    let data = try fixtureData(removing: "errors")
    #expect(try JSONDecoder().decode(DaemonSnapshot.self, from: data).errors == [])
  }

  @Test func bannerReadsChunkedFieldsInAnyOrder() async throws {
    let pipe = Pipe()
    let reader = BannerReader(handle: pipe.fileHandleForReading, deadline: 1)
    let task = Task { try await reader.read() }
    pipe.fileHandleForWriting.write(Data("PROXYTOP_TO".utf8))
    pipe.fileHandleForWriting.write(Data("KEN=secret\nnoise\nPROXYTOP_SOCKET=/tmp/".utf8))
    pipe.fileHandleForWriting.write(Data("proxytop.sock\n".utf8))
    let banner = try await task.value
    #expect(banner.socket == "/tmp/proxytop.sock")
    #expect(banner.token == "secret")
    try pipe.fileHandleForWriting.close()
  }

  @Test func bannerEOF() async throws {
    let pipe = Pipe()
    let task = Task { try await BannerReader(handle: pipe.fileHandleForReading, deadline: 1).read() }
    try pipe.fileHandleForWriting.close()
    #expect(await bannerError(task) == .eof)
  }

  @Test func bannerTimeout() async throws {
    let pipe = Pipe()
    let task = Task { try await BannerReader(handle: pipe.fileHandleForReading, deadline: 0.03).read() }
    #expect(await bannerError(task) == .timeout)
    try pipe.fileHandleForWriting.close()
  }

  @Test func bannerOutputLimit() async throws {
    let pipe = Pipe()
    let task = Task { try await BannerReader(handle: pipe.fileHandleForReading, deadline: 1, limit: 16).read() }
    pipe.fileHandleForWriting.write(Data(repeating: 65, count: 17))
    #expect(await bannerError(task) == .outputLimitExceeded)
    try pipe.fileHandleForWriting.close()
  }

  @Test func bannerOutputLimitCountsCompleteLines() async throws {
    let pipe = Pipe()
    let task = Task { try await BannerReader(handle: pipe.fileHandleForReading, deadline: 1, limit: 16).read() }
    pipe.fileHandleForWriting.write(Data("one\ntwo\nthree\nfour\n".utf8))
    #expect(await bannerError(task) == .outputLimitExceeded)
    try pipe.fileHandleForWriting.close()
  }

  @Test func stderrTailIsBounded() {
    let pipe = Pipe()
    let tail = StderrTail(handle: pipe.fileHandleForReading, limit: 8)
    tail.append(Data("0123456789".utf8))
    #expect(tail.text == "23456789")
  }

  @Test func stderrStopDrainsConcurrentOutput() throws {
    let pipe = Pipe()
    let tail = StderrTail(handle: pipe.fileHandleForReading, limit: 32)
    tail.start()
    for index in 0..<200 { pipe.fileHandleForWriting.write(Data("line-\(index)\n".utf8)) }
    try pipe.fileHandleForWriting.close()
    #expect(tail.stop().hasSuffix("line-199"))
  }

  @Test func bypassedFormattingAndExit() throws {
    let snapshot = try JSONDecoder().decode(DaemonSnapshot.self, from: fixtureData())
    guard let app = snapshot.apps.first else { throw FixtureError.missingApp }
    #expect(verdictLabel("BYPASSED", language: "en") == "BYPASSED")
    #expect(verdictLabel("BYPASSED", language: "zh") == "已绕过")
    #expect(pathLabel("BYPASSED", language: "en") == "BYPASS")
    #expect(appExit(app, language: "en") == "US")
  }

  private func bannerError(_ task: Task<Banner, Error>) async -> BannerReaderError? {
    do { _ = try await task.value; return nil }
    catch let error as BannerReaderError { return error }
    catch { return nil }
  }
}

#elseif canImport(XCTest)
import XCTest

final class ProxytopTests: XCTestCase {
  func testFixtureDecodesNewContract() throws {
    let snapshot = try JSONDecoder().decode(DaemonSnapshot.self, from: fixtureData())
    XCTAssertEqual(snapshot.apps.first?.verdict, "BYPASSED")
    XCTAssertEqual(snapshot.apps.first?.control, "controller")
    XCTAssertEqual(snapshot.errors.count, 2)
    XCTAssertEqual(snapshot.statuses.snapshot, "degraded (2 errors)")
  }

  func testMissingErrorsDecodeAsEmpty() throws {
    XCTAssertEqual(try JSONDecoder().decode(DaemonSnapshot.self, from: fixtureData(removing: "errors")).errors, [])
  }

  func testBannerReadsChunkedFieldsInAnyOrder() async throws {
    let pipe = Pipe()
    let task = Task { try await BannerReader(handle: pipe.fileHandleForReading, deadline: 1).read() }
    pipe.fileHandleForWriting.write(Data("PROXYTOP_TO".utf8))
    pipe.fileHandleForWriting.write(Data("KEN=secret\nnoise\nPROXYTOP_SOCKET=/tmp/".utf8))
    pipe.fileHandleForWriting.write(Data("proxytop.sock\n".utf8))
    let banner = try await task.value
    XCTAssertEqual(banner.socket, "/tmp/proxytop.sock")
    XCTAssertEqual(banner.token, "secret")
    try pipe.fileHandleForWriting.close()
  }

  func testBannerEOF() async throws {
    let pipe = Pipe()
    let task = Task { try await BannerReader(handle: pipe.fileHandleForReading, deadline: 1).read() }
    try pipe.fileHandleForWriting.close()
    await assertBannerError(task, .eof)
  }

  func testBannerTimeout() async throws {
    let pipe = Pipe()
    let task = Task { try await BannerReader(handle: pipe.fileHandleForReading, deadline: 0.03).read() }
    await assertBannerError(task, .timeout)
    try pipe.fileHandleForWriting.close()
  }

  func testBannerOutputLimit() async throws {
    let pipe = Pipe()
    let task = Task { try await BannerReader(handle: pipe.fileHandleForReading, deadline: 1, limit: 16).read() }
    pipe.fileHandleForWriting.write(Data(repeating: 65, count: 17))
    await assertBannerError(task, .outputLimitExceeded)
    try pipe.fileHandleForWriting.close()
  }

  func testBannerOutputLimitCountsCompleteLines() async throws {
    let pipe = Pipe()
    let task = Task { try await BannerReader(handle: pipe.fileHandleForReading, deadline: 1, limit: 16).read() }
    pipe.fileHandleForWriting.write(Data("one\ntwo\nthree\nfour\n".utf8))
    await assertBannerError(task, .outputLimitExceeded)
    try pipe.fileHandleForWriting.close()
  }

  func testStderrTailIsBounded() {
    let pipe = Pipe()
    let tail = StderrTail(handle: pipe.fileHandleForReading, limit: 8)
    tail.append(Data("0123456789".utf8))
    XCTAssertEqual(tail.text, "23456789")
  }

  func testStderrStopDrainsConcurrentOutput() throws {
    let pipe = Pipe()
    let tail = StderrTail(handle: pipe.fileHandleForReading, limit: 32)
    tail.start()
    for index in 0..<200 { pipe.fileHandleForWriting.write(Data("line-\(index)\n".utf8)) }
    try pipe.fileHandleForWriting.close()
    XCTAssertTrue(tail.stop().hasSuffix("line-199"))
  }

  func testBypassedFormattingAndExit() throws {
    let snapshot = try JSONDecoder().decode(DaemonSnapshot.self, from: fixtureData())
    let app = try XCTUnwrap(snapshot.apps.first)
    XCTAssertEqual(verdictLabel("BYPASSED", language: "en"), "BYPASSED")
    XCTAssertEqual(verdictLabel("BYPASSED", language: "zh"), "已绕过")
    XCTAssertEqual(pathLabel("BYPASSED", language: "en"), "BYPASS")
    XCTAssertEqual(appExit(app, language: "en"), "US")
  }

  private func assertBannerError(_ task: Task<Banner, Error>, _ expected: BannerReaderError) async {
    do { _ = try await task.value; XCTFail("expected banner error") }
    catch let error as BannerReaderError { XCTAssertEqual(error, expected) }
    catch { XCTFail("unexpected error: \(error)") }
  }
}

#else
#error("Proxytop tests require Swift Testing or XCTest")
#endif

private func fixtureData(removing key: String? = nil) throws -> Data {
  guard let url = Bundle.module.url(forResource: "daemon-snapshot", withExtension: "json", subdirectory: "Fixtures") else {
    throw FixtureError.missingFixture
  }
  guard let key else { return try Data(contentsOf: url) }
  guard var object = try JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any] else {
    throw FixtureError.invalidFixture
  }
  object.removeValue(forKey: key)
  return try JSONSerialization.data(withJSONObject: object)
}

private enum FixtureError: Error {
  case missingFixture
  case invalidFixture
  case missingApp
}
