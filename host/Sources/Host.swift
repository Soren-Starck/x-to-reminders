// X to Reminders helper: the browser starts it for each request (Chrome native
// messaging), it reads one JSON message on stdin, answers one on stdout, exits.
//
// It only ever reads reminders and adds new ones. It never edits, completes or
// deletes anything.

import EventKit
import Foundation

let version = "1.0.0"
let statusPattern = try! NSRegularExpression(
    pattern: #"(?:x|twitter)\.com/(?:[A-Za-z0-9_]{1,15}|i(?:/web)?)/status(?:es)?/(\d{5,25})"#,
    options: [.caseInsensitive])

// MARK: - Native messaging framing (4-byte native-order length, then UTF-8 JSON)

func readMessage() -> [String: Any]? {
    let input = FileHandle.standardInput
    guard let head = try? input.read(upToCount: 4), head.count == 4 else { return nil }
    let length = Int(head.withUnsafeBytes { $0.loadUnaligned(as: UInt32.self) })
    guard length > 0, length <= 1_048_576 else { return nil }
    var body = Data()
    while body.count < length {
        guard let chunk = try? input.read(upToCount: length - body.count), !chunk.isEmpty else { return nil }
        body.append(chunk)
    }
    return (try? JSONSerialization.jsonObject(with: body)) as? [String: Any]
}

var answered = false
let answerLock = NSLock()

func answer(_ object: [String: Any]) {
    answerLock.lock()
    defer { answerLock.unlock() }
    guard !answered else { return }
    answered = true
    let data = (try? JSONSerialization.data(withJSONObject: object)) ?? Data(#"{"ok":false,"error":"encode"}"#.utf8)
    var length = UInt32(data.count)
    FileHandle.standardOutput.write(Data(bytes: &length, count: 4) + data)
}

// MARK: - Log (~/Library/Logs/X to Reminders/host.log, kept under 512 KB; XTR_LOG_DIR overrides)

let logURL: URL = {
    let env = ProcessInfo.processInfo.environment
    let home = env["HOME"].map { URL(fileURLWithPath: $0) } ?? FileManager.default.homeDirectoryForCurrentUser
    let dir = env["XTR_LOG_DIR"].map { URL(fileURLWithPath: $0, isDirectory: true) }
        ?? home.appendingPathComponent("Library/Logs/X to Reminders", isDirectory: true)
    try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    return dir.appendingPathComponent("host.log")
}()

func log(_ line: String) {
    let stamp = ISO8601DateFormatter().string(from: Date())
    let entry = Data("\(stamp) \(line)\n".utf8)
    if let size = (try? FileManager.default.attributesOfItem(atPath: logURL.path))?[.size] as? Int, size > 512_000 {
        let old = logURL.appendingPathExtension("1")
        try? FileManager.default.removeItem(at: old)
        try? FileManager.default.moveItem(at: logURL, to: old)
    }
    if let handle = try? FileHandle(forWritingTo: logURL) {
        handle.seekToEndOfFile()
        handle.write(entry)
        try? handle.close()
    } else {
        try? entry.write(to: logURL)
    }
}

// MARK: - Stores

struct Item {
    let text: String  // title, notes and URL joined, searched for post ids
    let list: String
}

protocol Store {
    var access: String { get }
    func requestAccess() async -> Bool
    func defaultList() -> String?
    func openItems() async -> [Item]
    func add(title: String) throws -> (id: String, list: String)
    func exists(id: String) -> Bool
}

enum StoreError: Error, CustomStringConvertible {
    case noList, notSaved(String)
    var description: String {
        switch self {
        case .noList: return "no-list"
        case .notSaved(let why): return "not-saved: \(why)"
        }
    }
}

final class RemindersStore: Store {
    private var store = EKEventStore()

    var access: String {
        switch EKEventStore.authorizationStatus(for: .reminder).rawValue {
        case 0: return "notDetermined"
        case 1: return "restricted"
        case 2: return "denied"
        case 3: return "full"
        case 4: return "writeOnly"
        default: return "unknown"
        }
    }

    func requestAccess() async -> Bool {
        let granted: Bool
        if #available(macOS 14.0, *) {
            granted = (try? await store.requestFullAccessToReminders()) ?? false
        } else {
            granted = await withCheckedContinuation { done in
                store.requestAccess(to: .reminder) { ok, _ in done.resume(returning: ok) }
            }
        }
        // A store made before access was granted does not see the lists.
        if granted { store = EKEventStore() }
        return granted
    }

    private func targetCalendar() -> EKCalendar? {
        if let cal = store.defaultCalendarForNewReminders(), cal.allowsContentModifications { return cal }
        return store.calendars(for: .reminder).first { $0.allowsContentModifications }
    }

    func defaultList() -> String? { targetCalendar()?.title }

    func openItems() async -> [Item] {
        let predicate = store.predicateForIncompleteReminders(withDueDateStarting: nil, ending: nil, calendars: nil)
        return await withCheckedContinuation { done in
            store.fetchReminders(matching: predicate) { reminders in
                let items = (reminders ?? []).map { r in
                    Item(text: [r.title ?? "", r.notes ?? "", r.url?.absoluteString ?? ""].joined(separator: " "),
                         list: r.calendar?.title ?? "")
                }
                done.resume(returning: items)
            }
        }
    }

    func add(title: String) throws -> (id: String, list: String) {
        guard let calendar = targetCalendar() else { throw StoreError.noList }
        let reminder = EKReminder(eventStore: store)
        reminder.title = title
        reminder.calendar = calendar
        try store.save(reminder, commit: true)
        return (reminder.calendarItemIdentifier, calendar.title)
    }

    // Reads the reminder back through a fresh store, so it is on disk, not just in memory.
    func exists(id: String) -> Bool { EKEventStore().calendarItem(withIdentifier: id) != nil }
}

// A JSON file standing in for Reminders, for tests (XTR_MOCK_STORE=/path/store.json).
// Shape: {"access": "full", "grant": true, "list": "Reminders", "items": [{"title", "notes", "list", "done"}]}
final class FileStore: Store {
    let url: URL
    var state: [String: Any]

    init(path: String) {
        url = URL(fileURLWithPath: path)
        state = ((try? Data(contentsOf: url)).flatMap { try? JSONSerialization.jsonObject(with: $0) } as? [String: Any]) ?? [:]
    }

    private func save() {
        if let data = try? JSONSerialization.data(withJSONObject: state, options: [.prettyPrinted, .sortedKeys]) {
            try? data.write(to: url, options: .atomic)
        }
    }

    private var items: [[String: Any]] {
        get { state["items"] as? [[String: Any]] ?? [] }
        set { state["items"] = newValue }
    }

    var access: String { state["access"] as? String ?? "notDetermined" }

    func requestAccess() async -> Bool {
        if let delay = state["promptDelay"] as? Double { try? await Task.sleep(nanoseconds: UInt64(delay * 1e9)) }
        let granted = access == "notDetermined" ? (state["grant"] as? Bool ?? true) : access == "full"
        state["access"] = granted ? "full" : "denied"
        save()
        return granted
    }

    func defaultList() -> String? { state["list"] as? String ?? "Reminders" }

    func openItems() async -> [Item] {
        items.filter { ($0["done"] as? Bool) != true }.map {
            Item(text: "\($0["title"] ?? "") \($0["notes"] ?? "")", list: $0["list"] as? String ?? "")
        }
    }

    func add(title: String) throws -> (id: String, list: String) {
        if let fail = state["failAdd"] as? String { throw StoreError.notSaved(fail) }
        let id = UUID().uuidString
        let list = defaultList() ?? "Reminders"
        items.append(["id": id, "title": title, "list": list])
        save()
        return (id, list)
    }

    func exists(id: String) -> Bool { items.contains { $0["id"] as? String == id } }
}

// MARK: - Requests

func postIds(in text: String) -> [String] {
    let range = NSRange(text.startIndex..., in: text)
    return statusPattern.matches(in: text, range: range).compactMap {
        Range($0.range(at: 1), in: text).map { String(text[$0]) }
    }
}

func canonical(_ raw: Any?) -> (url: String, id: String)? {
    guard let raw = raw as? String, let parts = URLComponents(string: raw),
          let host = parts.host?.lowercased(),
          ["x.com", "twitter.com", "www.x.com", "www.twitter.com", "mobile.x.com", "mobile.twitter.com"].contains(host)
    else { return nil }
    let path = parts.path.split(separator: "/").map(String.init)
    guard path.count >= 3, ["status", "statuses"].contains(path[1]),
          path[2].count >= 5, path[2].count <= 25, path[2].allSatisfy(\.isNumber),
          path[0].range(of: #"^[A-Za-z0-9_]{1,15}$"#, options: .regularExpression) != nil
    else { return nil }
    return ("https://x.com/\(path[0])/status/\(path[2])", path[2])
}

func handle(_ message: [String: Any], store: Store) async -> [String: Any] {
    let op = message["op"] as? String ?? ""
    switch op {
    case "ping":
        var out: [String: Any] = ["ok": true, "version": version, "access": store.access]
        if store.access == "full" { out["list"] = store.defaultList() ?? NSNull() }
        return out

    case "saved":
        // Never asks for access: only the user's click on a post may do that.
        guard store.access == "full" else { return ["ok": false, "error": "no-access", "access": store.access] }
        var lists: [String: String] = [:]
        for item in await store.openItems() {
            for id in postIds(in: item.text) where lists[id] == nil { lists[id] = item.list }
        }
        return ["ok": true, "ids": lists]

    case "add":
        guard let post = canonical(message["url"]) else { return ["ok": false, "error": "bad-url"] }
        if store.access != "full" {
            if store.access == "notDetermined" {
                log("add asks for Reminders access")
                if !(await store.requestAccess()) { return ["ok": false, "error": "denied"] }
            } else {
                return ["ok": false, "error": store.access == "restricted" ? "restricted" : "denied"]
            }
        }
        for item in await store.openItems() where postIds(in: item.text).contains(post.id) {
            return ["ok": true, "status": "exists", "list": item.list, "url": post.url]
        }
        do {
            let saved = try store.add(title: post.url)
            guard store.exists(id: saved.id) else { return ["ok": false, "error": "not-verified"] }
            return ["ok": true, "status": "added", "list": saved.list, "url": post.url]
        } catch {
            return ["ok": false, "error": "save-failed", "detail": "\(error)"]
        }

    case "openSettings":
        if ProcessInfo.processInfo.environment["XTR_MOCK_STORE"] == nil {
            let open = Process()
            open.executableURL = URL(fileURLWithPath: "/usr/bin/open")
            open.arguments = ["x-apple.systempreferences:com.apple.preference.security?Privacy_Reminders"]
            try? open.run()
        }
        return ["ok": true]

    default:
        return ["ok": false, "error": "unknown-op"]
    }
}

// MARK: - Main

@main
struct Host {
    static func main() async {
        // A pending permission prompt can wait a while, but the helper never lingers.
        DispatchQueue.global().asyncAfter(deadline: .now() + 170) {
            answer(["ok": false, "error": "timeout"])
            log("timeout")
            exit(2)
        }
        if CommandLine.arguments.contains("--version") {
            print(version)
            return
        }
        guard let message = readMessage() else {
            answer(["ok": false, "error": "bad-message"])
            log("bad-message")
            return
        }
        let started = Date()
        let mock = ProcessInfo.processInfo.environment["XTR_MOCK_STORE"]
        let store: Store = mock.map { FileStore(path: $0) } ?? RemindersStore()
        let result = await handle(message, store: store)
        answer(result)

        let ms = Int(Date().timeIntervalSince(started) * 1000)
        var line = "\(message["op"] ?? "?") \(result["ok"] as? Bool == true ? "ok" : "fail")"
        for key in ["status", "error", "list", "url", "access"] { if let v = result[key] { line += " \(key)=\(v)" } }
        if let ids = result["ids"] as? [String: String] { line += " ids=\(ids.count)" }
        if let diag = message["diag"] as? [String: Any] {
            line += " diag=" + diag.keys.sorted().map { "\($0):\(diag[$0]!)" }.joined(separator: ",")
        }
        log(line + " \(ms)ms" + (mock == nil ? "" : " mock"))
    }
}
