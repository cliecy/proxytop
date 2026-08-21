import Foundation

struct Banner: Equatable {
  let socket: String
  let token: String
}

enum BannerReaderError: LocalizedError, Equatable {
  case timeout
  case eof
  case invalidFormat
  case outputLimitExceeded
  case cancelled

  var errorDescription: String? {
    switch self {
    case .timeout: return "engine banner timed out"
    case .eof: return "engine closed stdout before announcing its socket"
    case .invalidFormat: return "engine banner has invalid socket or token"
    case .outputLimitExceeded: return "engine banner exceeded 16 KiB"
    case .cancelled: return "engine banner read cancelled"
    }
  }
}

final class BannerReader: @unchecked Sendable {
  private let handle: FileHandle
  private let deadline: TimeInterval
  private let limit: Int
  private let queue = DispatchQueue(label: "com.proxytop.banner-reader")
  private let inputLock = NSLock()
  private var continuation: CheckedContinuation<Banner, Error>?
  private var timer: DispatchSourceTimer?
  private var buffer = Data()
  private var socket: String?
  private var token: String?
  private var finished = false
  private var acceptingInput = true
  private var totalBytesRead = 0

  init(handle: FileHandle, deadline: TimeInterval = 15, limit: Int = 16 * 1024) {
    self.handle = handle
    self.deadline = deadline
    self.limit = limit
  }

  func read() async throws -> Banner {
    try await withTaskCancellationHandler {
      try await withCheckedThrowingContinuation { continuation in
        queue.async { [self] in
          guard !self.finished else {
            continuation.resume(throwing: BannerReaderError.cancelled)
            return
          }
          self.continuation = continuation
          self.handle.readabilityHandler = { [weak self] handle in
            guard let self else { return }
            let data = handle.availableData
            if data.isEmpty {
              self.queue.async { self.handleEOFOnQueue() }
            } else if self.accept(data) {
              self.queue.async { self.consumeOnQueue(data) }
            }
          }
          let timer = DispatchSource.makeTimerSource(queue: self.queue)
          timer.schedule(deadline: .now() + self.deadline)
          timer.setEventHandler { [weak self] in
            self?.finishOnQueue(.failure(BannerReaderError.timeout))
          }
          self.timer = timer
          timer.resume()
        }
      }
    } onCancel: {
      self.cancel()
    }
  }

  func cancel() {
    stopAcceptingInput()
    queue.async { [self] in self.finishOnQueue(.failure(BannerReaderError.cancelled)) }
  }

  private func accept(_ data: Data) -> Bool {
    inputLock.lock()
    defer { inputLock.unlock() }
    guard acceptingInput else { return false }
    totalBytesRead += data.count
    if totalBytesRead > limit {
      acceptingInput = false
      queue.async { [self] in self.finishOnQueue(.failure(BannerReaderError.outputLimitExceeded)) }
      return false
    }
    return true
  }

  private func stopAcceptingInput() {
    inputLock.lock()
    acceptingInput = false
    inputLock.unlock()
  }

  private func consumeOnQueue(_ data: Data) {
    guard !finished else { return }
    buffer.append(data)
    parseCompleteLinesOnQueue()
  }

  private func parseCompleteLinesOnQueue() {
    while let newline = buffer.firstIndex(of: 0x0A) {
      let lineData = buffer.prefix(upTo: newline)
      buffer.removeSubrange(...newline)
      parseLine(String(decoding: lineData, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines))
      if finishIfCompleteOnQueue() { return }
    }
  }

  private func handleEOFOnQueue() {
    guard !finished else { return }
    if !buffer.isEmpty {
      parseLine(String(decoding: buffer, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines))
      buffer.removeAll()
    }
    if finishIfCompleteOnQueue() { return }
    finishOnQueue(.failure(socket == nil && token == nil ? BannerReaderError.eof : BannerReaderError.invalidFormat))
  }

  private func parseLine(_ line: String) {
    if line.hasPrefix("PROXYTOP_SOCKET=") { socket = String(line.dropFirst(16)) }
    if line.hasPrefix("PROXYTOP_TOKEN=") { token = String(line.dropFirst(15)) }
  }

  @discardableResult
  private func finishIfCompleteOnQueue() -> Bool {
    guard let socket, !socket.isEmpty, let token, !token.isEmpty else { return false }
    finishOnQueue(.success(Banner(socket: socket, token: token)))
    return true
  }

  private func finishOnQueue(_ result: Result<Banner, Error>) {
    guard !finished else { return }
    finished = true
    stopAcceptingInput()
    handle.readabilityHandler = nil
    timer?.cancel()
    timer = nil
    let continuation = continuation
    self.continuation = nil
    continuation?.resume(with: result)
  }
}
