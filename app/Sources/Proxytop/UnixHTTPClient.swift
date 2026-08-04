import Darwin
import Foundation

/// Minimal HTTP/1.1 client over a Unix domain socket using raw BSD sockets.
/// NWConnection misreports a normal server-side close on unix sockets as
/// "Network is down" (POSIX 50), so we use blocking recv() which returns 0 on EOF.
struct UnixHTTPClient {
  let socketPath: String
  let token: String

  enum ClientError: LocalizedError {
    case bannerTimeout
    case badStatus(String)
    case timeout
    case posix(Int32, String)

    var errorDescription: String? {
      switch self {
      case .bannerTimeout:
        return "engine did not announce its socket"
      case .badStatus(let line):
        return "engine responded with unexpected status: \(line)"
      case .timeout:
        return "engine request timed out"
      case .posix(let code, let operation):
        return "\(operation) failed: \(String(cString: strerror(code)))"
      }
    }
  }

  func get(path: String) async throws -> Data {
    try await withCheckedThrowingContinuation { continuation in
      DispatchQueue.global(qos: .userInitiated).async {
        do {
          continuation.resume(returning: try Self.request(socketPath: socketPath, path: path, token: token))
        } catch {
          continuation.resume(throwing: error)
        }
      }
    }
  }

  private static func request(socketPath: String, path: String, token: String) throws -> Data {
    let descriptor = socket(AF_UNIX, SOCK_STREAM, 0)
    if descriptor < 0 { throw ClientError.posix(errno, "socket") }
    defer { close(descriptor) }

    var address = sockaddr_un()
    address.sun_family = sa_family_t(AF_UNIX)
    let pathBytes = Array(socketPath.utf8)
    withUnsafeMutableBytes(of: &address.sun_path) { rawBuffer in
      let capacity = rawBuffer.count
      let count = min(pathBytes.count, capacity - 1)
      for index in 0..<count {
        rawBuffer[index] = pathBytes[index]
      }
      rawBuffer[count] = 0
    }

    let connectionResult = withUnsafePointer(to: &address) { pointer in
      pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { sockaddrPointer in
        connect(descriptor, sockaddrPointer, socklen_t(MemoryLayout<sockaddr_un>.size))
      }
    }
    if connectionResult != 0 {
      throw ClientError.posix(errno, "connect")
    }

    var timeval = timeval(tv_sec: 3, tv_usec: 0)
    setsockopt(descriptor, SOL_SOCKET, SO_RCVTIMEO, &timeval, socklen_t(MemoryLayout<timeval>.size))
    setsockopt(descriptor, SOL_SOCKET, SO_SNDTIMEO, &timeval, socklen_t(MemoryLayout<timeval>.size))

    let request = "GET \(path) HTTP/1.1\r\n"
      + "Host: localhost\r\n"
      + "Authorization: Bearer \(token)\r\n"
      + "Connection: close\r\n\r\n"
    let requestBytes = Array(request.utf8)
    var sent = 0
    while sent < requestBytes.count {
      let written = requestBytes.withUnsafeBufferPointer { buffer in
        send(descriptor, buffer.baseAddress!.advanced(by: sent), requestBytes.count - sent, 0)
      }
      if written < 0 { throw ClientError.posix(errno, "send") }
      sent += written
    }

    var data = Data()
    var buffer = [UInt8](repeating: 0, count: 65536)
    while true {
      let received = buffer.withUnsafeMutableBufferPointer { pointer in
        recv(descriptor, pointer.baseAddress, pointer.count, 0)
      }
      if received < 0 {
        if errno == EAGAIN || errno == EWOULDBLOCK { throw ClientError.timeout }
        throw ClientError.posix(errno, "recv")
      }
      if received == 0 { break }
      data.append(contentsOf: buffer[0..<received])
    }
    return try parseBody(data)
  }

  private static func parseBody(_ data: Data) throws -> Data {
    guard let separator = data.range(of: Data("\r\n\r\n".utf8)) else {
      throw ClientError.badStatus("missing header separator")
    }
    let headerText = String(data: data[..<separator.lowerBound], encoding: .utf8) ?? ""
    guard let statusLine = headerText.components(separatedBy: "\r\n").first, statusLine.contains(" 200") else {
      throw ClientError.badStatus(headerText)
    }
    return Data(data[separator.upperBound...])
  }
}
