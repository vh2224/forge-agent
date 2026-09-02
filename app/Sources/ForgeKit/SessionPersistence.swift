// SessionPersistence — the descriptor of a terminal session and the codec
// that reads and writes it to a single global file under `~/.claude/`.
//
// What survives a relaunch is the DESCRIPTOR, never the process. A terminal
// session is a PTY child of this app; when the app quits, the child dies with
// it, and there is nothing left to "reattach" to. What `SessionResume` (T02)
// rebuilds from this descriptor is a NEW `claude --continue` invocation in the
// same `cwd` — the CLI's own conversation history is what makes that feel
// continuous, not anything this app kept alive.
//
// The file lives under `~/.claude/`, global and not per-workspace, and not
// under `.gsd/`, for the same reason `WorkspaceRegistry.filename` does:
// sessions are not scoped to a single project directory the way a workspace
// registry entry is, and `.gsd/` is git-tracked project state that this app
// does not own.
//
// Pure by construction, same discipline as `WorkspaceRegistry`: `encode`/
// `decode` operate on `Data` only and never touch `FileManager`; only
// `load(path:)`/`save(_:to:)` touch disk, and both receive their path as a
// parameter rather than reading `$HOME` themselves. That is what makes the
// three degrade-on-failure cases (missing file, corrupt bytes, happy path)
// testable against `NSTemporaryDirectory()` instead of the real home.

import Foundation

/// A terminal session reduced to what is worth remembering after the app
/// quits and relaunches.
///
/// Exactly five stored fields — `cwd`, `title`, `engine`, `account`,
/// `runId` — and nothing else. In particular: no `id` (a fresh session gets a
/// fresh one on resume), no timestamp (staleness is not modelled here), and
/// no launch keystroke string (a session's launch command may carry whatever
/// the operator pasted into it; it is not this type's job to persist that to
/// disk).
///
/// The PTY's scrollback is **not** restored. Nothing in this type carries
/// terminal output, and nothing in `SessionResume` (T02) replays it — a
/// resumed session starts with a blank pane and a `claude --continue` call;
/// the CLI's own transcript, not this app's terminal buffer, is what makes
/// the conversation feel unbroken. Persisting scrollback would mean this app
/// owning a second copy of conversation history it has no way to keep in sync
/// with the CLI's.
public struct SessionDescriptor: Codable, Hashable, Sendable {
    /// Working directory the session ran in. Never appears in a resume argv
    /// (see `SessionResume`, T02) — it travels as this field, not as a CLI
    /// positional.
    public let cwd: String

    /// Display title for the session.
    public let title: String

    /// The engine the session was launched with (`"claude"`, `"codex"`,
    /// `"agy"`, ...). Only `SessionResume` (T02) turns this into an argv, and
    /// only for `claude` — this type just carries the raw value read at
    /// capture time.
    public let engine: String

    /// Account name the session ran under, if any. This is a NAME
    /// (e.g. `"mwtelles"`), never a credential — tokens live in the Keychain
    /// and `ANTHROPIC_AUTH_TOKEN`, not here.
    public let account: String?

    /// The run this session was driving, if any.
    public let runId: String?

    public init(cwd: String, title: String, engine: String, account: String? = nil, runId: String? = nil) {
        self.cwd = cwd
        self.title = title
        self.engine = engine
        self.account = account
        self.runId = runId
    }
}

/// Reads and writes `SessionDescriptor` lists to a single global file under
/// `~/.claude/`.
///
/// The codec (`encode`/`decode`) is pure — `Data` in, `Data`/`[SessionDescriptor]`
/// out, no `FileManager` — mirroring `WorkspaceRegistry`. Only `load(path:)` and
/// `save(_:to:)` touch disk, and both take the path as a parameter so tests run
/// against `NSTemporaryDirectory()` rather than the real `~/.claude/`.
public enum SessionStore {

    // MARK: - Shared literals

    /// Basename under `~/.claude/`.
    public static let filename = "forge-sessions.json"

    /// Full path for a given home directory. Never `.gsd/`, never scoped to a
    /// single workspace.
    public static func path(home: String) -> String {
        "\(home)/.claude/\(filename)"
    }

    // MARK: - Codec (pure — Data in, Data/[SessionDescriptor] out)

    /// A single decoded element that tolerates its own failure: an entry that
    /// cannot become a `SessionDescriptor` decodes to `nil` rather than
    /// aborting the whole array. This is what keeps one corrupt record from
    /// taking every valid one down with it.
    private struct Lossy: Decodable {
        let value: SessionDescriptor?

        init(from decoder: Decoder) throws {
            let container = try decoder.singleValueContainer()
            value = try? container.decode(SessionDescriptor.self)
        }
    }

    /// Encodes a descriptor list to pretty-printed, key-sorted JSON — an
    /// inspectable file on disk, same choice `WorkspaceRegistry` makes.
    public static func encode(_ descriptors: [SessionDescriptor]) throws -> Data {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        return try encoder.encode(descriptors)
    }

    /// Decodes tolerantly: a top-level failure (not JSON, or JSON whose
    /// top-level value is not an array) returns `[]`. Within a valid array,
    /// each element decodes independently — invalid entries are dropped,
    /// valid ones survive.
    public static func decode(_ data: Data) -> [SessionDescriptor] {
        guard let lossy = try? JSONDecoder().decode([Lossy].self, from: data) else {
            return []
        }
        return lossy.compactMap(\.value)
    }

    // MARK: - Disk I/O (the only place this type touches FileManager)

    /// Reads the descriptor list at `path`. Any failure to read — file
    /// absent, unreadable, or its bytes failing to decode — degrades to `[]`
    /// rather than throwing or crashing.
    public static func load(path: String) -> [SessionDescriptor] {
        guard let data = try? Data(contentsOf: URL(fileURLWithPath: path)) else {
            return []
        }
        return decode(data)
    }

    /// Writes `descriptors` to `path`, creating any missing intermediate
    /// directories first. Best-effort: a failure to encode or write is
    /// swallowed rather than thrown, matching `WorkspaceRegistry`'s posture
    /// that a save the app cannot complete should not crash the caller.
    public static func save(_ descriptors: [SessionDescriptor], to path: String) {
        let url = URL(fileURLWithPath: path)
        try? FileManager.default.createDirectory(
            at: url.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        guard let data = try? encode(descriptors) else { return }
        try? data.write(to: url, options: .atomic)
    }

    // MARK: - Retention

    /// Keeps at most `limit` descriptors, deduplicated by `cwd`.
    ///
    /// "First occurrence wins" is deliberate, not incidental: the app always
    /// appends the most recently used session first (T03), so the first
    /// occurrence of a given `cwd` in the list IS the most recent one. This
    /// function does not sort by any recency field of its own — there isn't
    /// one — it trusts the order it is handed.
    public static func retained(_ descriptors: [SessionDescriptor], limit: Int = 8) -> [SessionDescriptor] {
        var seenCwds: Set<String> = []
        var result: [SessionDescriptor] = []
        for descriptor in descriptors {
            guard !seenCwds.contains(descriptor.cwd) else { continue }
            seenCwds.insert(descriptor.cwd)
            result.append(descriptor)
            if result.count == limit { break }
        }
        return result
    }
}
