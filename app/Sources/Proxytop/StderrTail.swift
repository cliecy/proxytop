import Foundation

final class StderrTail: @unchecked Sendable {
  private let handle: FileHandle
  private let limit: Int
  private let queue = DispatchQueue(label: "com.proxytop.stderr-tail")
  private let readLock = NSLock()
  private var buffer = Data()
  private var stopped = false

  init(handle: FileHandle, limit: Int = 8 * 1024) {
    self.handle = handle
    self.limit = limit
  }

  func start() {
    handle.readabilityHandler = { [weak self] handle in
      self?.readAvailableData(from: handle)
    }
  }

  @discardableResult
  func stop() -> String {
    handle.readabilityHandler = nil
    readLock.lock()
    let remaining = handle.readDataToEndOfFile()
    readLock.unlock()
    return queue.sync {
      if !stopped {
        appendOnQueue(remaining)
        stopped = true
      }
      return String(decoding: buffer, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
    }
  }

  func append(_ data: Data) {
    queue.sync { appendOnQueue(data) }
  }

  var text: String {
    queue.sync { String(decoding: buffer, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines) }
  }

  private func readAvailableData(from handle: FileHandle) {
    readLock.lock()
    let data = handle.availableData
    if !data.isEmpty {
      queue.async { [self] in
        guard !stopped else { return }
        appendOnQueue(data)
      }
    }
    readLock.unlock()
  }

  private func appendOnQueue(_ data: Data) {
    guard !data.isEmpty else { return }
    buffer.append(data)
    if buffer.count > limit { buffer.removeFirst(buffer.count - limit) }
  }

  deinit { handle.readabilityHandler = nil }
}
