import Darwin
import Foundation
import ServiceManagement

@MainActor
final class AppModel: ObservableObject {
  static let shared = AppModel()

  @Published var snapshot: DaemonSnapshot?
  @Published var lastError: String?
  @Published var connected = false

  @Published var section: AppSection = .apps
  @Published var launchAtLogin = false
  @Published var launchMessage: String?
  @Published var language = "en"
  @Published var advancedMode = false
  @Published var selectedProcess: String?

  private var process: Process?
  private var socketPath: String?
  private var token: String?
  private var pollTask: Task<Void, Never>?

  private init() {}

  func start() {
    guard process == nil else { return }
    guard let engine = locateEngine() else {
      lastError = "engine binary not found; build with scripts/build-app.sh"
      return
    }

    launchAtLogin = isLaunchAtLoginEnabled
    loadConfig()

    let proc = Process()
    proc.executableURL = engine
    proc.arguments = ["daemon", "--supervised"]
    let pipe = Pipe()
    proc.standardOutput = pipe
    proc.standardError = FileHandle.nullDevice
    proc.terminationHandler = { [weak self] terminatedProcess in
      Task { @MainActor [weak self] in
        self?.resetEngineState(
          expectedProcess: terminatedProcess,
          error: "engine exited with status \(terminatedProcess.terminationStatus)"
        )
      }
    }
    process = proc
    do {
      try proc.run()
    } catch {
      proc.terminationHandler = nil
      resetEngineState(
        expectedProcess: proc,
        error: "failed to launch engine: \(error.localizedDescription)"
      )
      return
    }

    pollTask = Task { [weak self] in
      guard let self else { return }
      do {
        let banner = try await Self.readBanner(pipe: pipe)
        guard !Task.isCancelled, self.process === proc else { return }
        self.socketPath = banner.socket
        self.token = banner.token
        self.connected = true
        self.lastError = nil
        await self.runPolling(expectedProcess: proc)
      } catch {
        guard !Task.isCancelled, self.process === proc else { return }
        self.connected = false
        self.snapshot = nil
        self.lastError = error.localizedDescription
      }
    }
  }

  func stop() {
    let proc = process
    proc?.terminationHandler = nil
    resetEngineState(expectedProcess: proc)
    proc?.terminate()
  }

  private func resetEngineState(expectedProcess: Process? = nil, error: String? = nil) {
    if let expectedProcess, process !== expectedProcess { return }
    pollTask?.cancel()
    pollTask = nil
    process = nil
    socketPath = nil
    token = nil
    connected = false
    snapshot = nil
    lastError = error
  }

  var sortedApps: [SerializedApp] {
    var apps = snapshot?.apps ?? []
    if !advancedMode {
      apps = apps.filter { app in
        if app.verdict == "DIRECT" || app.verdict == "MIXED" || app.verdict == "PROXIED" { return true }
        if app.verdict == "ENGINE" || app.verdict == "OVERLAY" { return true }
        if app.verdict == "LOCAL" { return false }
        if app.verdict == "UNKNOWN", app.totalRate <= 0 { return false }
        return app.connections > 0
      }
    }
    // Leak-first: mixed/direct before proxied noise when rates are similar.
    return apps.sorted { left, right in
      let rank: (SerializedApp) -> Int = { app in
        switch app.verdict {
        case "MIXED": return 0
        case "DIRECT": return 1
        case "UNKNOWN": return 2
        case "PROXIED": return 3
        case "OVERLAY": return 4
        case "ENGINE": return 5
        default: return 6
        }
      }
      let leftRank = rank(left)
      let rightRank = rank(right)
      if leftRank != rightRank { return leftRank < rightRank }
      return left.totalRate > right.totalRate
    }
  }

  var selectedApp: SerializedApp? {
    guard let process = selectedProcess else { return nil }
    return sortedApps.first { $0.process == process }
  }

  var visibleSections: [AppSection] {
    advancedMode ? AppSection.allCases : [.apps, .settings]
  }

  var coverageSummary: (proxied: Int, direct: Int, mixed: Int) {
    let apps = snapshot?.apps ?? []
    return (
      apps.filter { $0.verdict == "PROXIED" }.count,
      apps.filter { $0.verdict == "DIRECT" }.count,
      apps.filter { $0.verdict == "MIXED" }.count
    )
  }

  var vpnSummary: String {
    guard let services = snapshot?.header?.vpnServices else {
      return localText(language, "none", "无")
    }
    let connected = services.filter { $0.state.localizedCaseInsensitiveContains("connect") }
    if connected.isEmpty { return localText(language, "none", "无") }
    return connected.map { service in
      if let iface = service.interfaceName {
        return "\(service.name)/\(iface)"
      }
      return service.name
    }.joined(separator: ", ")
  }

  var systemProxySummary: String {
    guard let proxy = snapshot?.header?.proxy else {
      return localText(language, "unknown", "未知")
    }
    let endpoints = proxy.endpoints
    return endpoints.isEmpty ? localText(language, "disabled", "关闭") : endpoints.joined(separator: " · ")
  }

  private func refreshSelection() {
    let apps = sortedApps
    if let current = selectedProcess {
      if !apps.contains(where: { $0.process == current }) {
        selectedProcess = apps.first?.process
      }
    } else {
      selectedProcess = apps.first?.process
    }
  }

  func setLaunchAtLogin(_ enabled: Bool) {
    if enabled {
      do {
        try enableLaunchAtLogin()
      } catch {
        launchAtLogin = false
        launchMessage = localText(
          language,
          "Failed to enable launch at login: \(error.localizedDescription)",
          "开机启动设置失败：\(error.localizedDescription)"
        )
      }
    } else {
      disableLaunchAtLogin()
      launchAtLogin = isLaunchAtLoginEnabled
      launchMessage = localText(language, "Launch at login disabled", "已移除开机启动")
    }
  }

  var isLaunchAtLoginEnabled: Bool {
    SMAppService.mainApp.status == .enabled || launchAgentInstalled
  }

  private func enableLaunchAtLogin() throws {
    if SMAppService.mainApp.status == .enabled {
      launchAtLogin = true
      launchMessage = localText(language, "Launch at login enabled", "已开启开机启动")
      return
    }
    if appInSupportedLocation {
      try SMAppService.mainApp.register()
      launchAtLogin = true
      launchMessage = localText(language, "Launch at login enabled", "已开启开机启动")
      return
    }
    if writeLaunchAgent(), bootstrapLaunchAgent() {
      launchAtLogin = true
      launchMessage = localText(language, "Launch at login enabled (LaunchAgent)", "已开启开机启动（LaunchAgent）")
      return
    }
    throw CocoaError(.fileWriteUnknown)
  }

  private func disableLaunchAtLogin() {
    if SMAppService.mainApp.status == .enabled {
      try? SMAppService.mainApp.unregister()
    }
    if launchAgentInstalled {
      _ = runLaunchctl(["bootout", "gui/\(getuid())/com.proxytop.app"])
      try? FileManager.default.removeItem(at: launchAgentURL)
    }
  }

  private var appInSupportedLocation: Bool {
    let path = Bundle.main.bundleURL.standardizedFileURL.path
    let homeApplications = FileManager.default.homeDirectoryForCurrentUser
      .appendingPathComponent("Applications").path
    return path.hasPrefix("/Applications/")
      || path.hasPrefix("/System/Applications/")
      || path.hasPrefix(homeApplications + "/")
  }

  private var launchAgentURL: URL {
    FileManager.default.homeDirectoryForCurrentUser
      .appendingPathComponent("Library/LaunchAgents/com.proxytop.app.plist")
  }

  private var launchAgentInstalled: Bool {
    FileManager.default.isReadableFile(atPath: launchAgentURL.path)
  }

  private func writeLaunchAgent() -> Bool {
    let plist: [String: Any] = [
      "Label": "com.proxytop.app",
      "ProgramArguments": ["/usr/bin/open", Bundle.main.bundleURL.path],
      "RunAtLoad": true,
      "ProcessType": "Interactive",
    ]
    guard let data = try? PropertyListSerialization.data(fromPropertyList: plist, format: .xml, options: 0) else {
      return false
    }
    do {
      try FileManager.default.createDirectory(
        at: launchAgentURL.deletingLastPathComponent(),
        withIntermediateDirectories: true
      )
      try data.write(to: launchAgentURL, options: .atomic)
      return true
    } catch {
      return false
    }
  }

  private func bootstrapLaunchAgent() -> Bool {
    _ = runLaunchctl(["bootout", "gui/\(getuid())/com.proxytop.app"])
    return runLaunchctl(["bootstrap", "gui/\(getuid())", launchAgentURL.path])
  }

  @discardableResult
  private func runLaunchctl(_ arguments: [String]) -> Bool {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/bin/launchctl")
    process.arguments = arguments
    process.standardOutput = FileHandle.nullDevice
    process.standardError = FileHandle.nullDevice
    do {
      try process.run()
      process.waitUntilExit()
      return process.terminationStatus == 0
    } catch {
      return false
    }
  }

  var enginePath: String {
    ProcessInfo.processInfo.environment["PROXYTOP_ENGINE_PATH"]
      ?? Bundle.main.resourceURL?.appendingPathComponent("proxytop").path
      ?? "-"
  }

  private func configDirectory() -> URL {
    let home = FileManager.default.homeDirectoryForCurrentUser
    if let xdg = ProcessInfo.processInfo.environment["XDG_CONFIG_HOME"], !xdg.isEmpty {
      return URL(fileURLWithPath: xdg).appendingPathComponent("proxytop")
    }
    return home.appendingPathComponent(".config/proxytop")
  }

  private func loadConfig() {
    let url = configDirectory().appendingPathComponent("config.json")
    guard let data = try? Data(contentsOf: url),
          let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
      language = "en"
      advancedMode = false
      return
    }
    if let raw = object["language"] as? String {
      language = raw == "zh" ? "zh" : "en"
    } else {
      language = "en"
    }
    advancedMode = object["advancedMode"] as? Bool ?? false
  }

  func saveConfig() {
    let directory = configDirectory()
    try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    guard let data = try? JSONSerialization.data(
      withJSONObject: [
        "language": language,
        "advancedMode": advancedMode,
      ],
      options: [.prettyPrinted, .sortedKeys]
    ) else {
      return
    }
    try? data.write(to: directory.appendingPathComponent("config.json"), options: .atomic)
  }

  func saveLanguage() {
    saveConfig()
  }

  func setAdvancedMode(_ enabled: Bool) {
    advancedMode = enabled
    if !enabled, section == .status {
      section = .apps
    }
    saveConfig()
  }

  private func runPolling(expectedProcess: Process) async {
    while !Task.isCancelled, process === expectedProcess {
      if let socketPath, let token {
        do {
          let data = try await UnixHTTPClient(socketPath: socketPath, token: token).get(path: "/snapshot")
          let nextSnapshot = try JSONDecoder().decode(DaemonSnapshot.self, from: data)
          guard !Task.isCancelled, process === expectedProcess else { return }
          snapshot = nextSnapshot
          connected = true
          lastError = nil
          refreshSelection()
        } catch {
          guard !Task.isCancelled, process === expectedProcess else { return }
          connected = false
          snapshot = nil
          lastError = error.localizedDescription
        }
      }
      try? await Task.sleep(nanoseconds: 1_000_000_000)
    }
  }

  private static func readBanner(pipe: Pipe) async throws -> (socket: String, token: String) {
    try await withCheckedThrowingContinuation { continuation in
      DispatchQueue.global(qos: .userInitiated).async {
        let handle = pipe.fileHandleForReading
        var buffer = Data()
        var socket: String?
        var token: String?
        let socketPrefix = "PROXYTOP_SOCKET="
        let tokenPrefix = "PROXYTOP_TOKEN="
        while socket == nil || token == nil {
          let chunk = handle.availableData
          if chunk.isEmpty { break }
          buffer.append(chunk)
          let text = String(data: buffer, encoding: .utf8) ?? ""
          for line in text.split(whereSeparator: \.isNewline) {
            if socket == nil, line.hasPrefix(socketPrefix) {
              socket = String(line.dropFirst(socketPrefix.count))
            }
            if token == nil, line.hasPrefix(tokenPrefix) {
              token = String(line.dropFirst(tokenPrefix.count))
            }
          }
        }
        if let socket, let token {
          continuation.resume(returning: (socket, token))
        } else {
          continuation.resume(throwing: UnixHTTPClient.ClientError.bannerTimeout)
        }
      }
    }
  }

  private func locateEngine() -> URL? {
    if let env = ProcessInfo.processInfo.environment["PROXYTOP_ENGINE_PATH"], !env.isEmpty {
      let url = URL(fileURLWithPath: env)
      if FileManager.default.isExecutableFile(atPath: url.path) { return url }
    }
    if let resources = Bundle.main.resourceURL {
      let bundled = resources.appendingPathComponent("proxytop")
      if FileManager.default.isExecutableFile(atPath: bundled.path) { return bundled }
    }
    var directory = URL(fileURLWithPath: FileManager.default.currentDirectoryPath)
    for _ in 0..<6 {
      let candidate = directory.appendingPathComponent("build/proxytop-daemon")
      if FileManager.default.isExecutableFile(atPath: candidate.path) { return candidate }
      directory.deleteLastPathComponent()
    }
    return nil
  }
}
