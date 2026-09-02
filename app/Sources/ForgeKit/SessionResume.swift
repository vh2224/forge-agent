// SessionResume — turns a persisted `SessionDescriptor` (T01) into the argv
// of a resume command, or `nil` when there is nothing to resume.
//
// `cwd` is deliberately kept OUT of the argv. `claude --continue` resumes the
// most recent conversation IN THE WORKING DIRECTORY the process runs in — it
// takes no path argument. A positional appended after `--continue` would not
// be read as a working directory at all; it would be read as a prompt, and
// the resumed conversation would open by answering that string. So `cwd`
// travels as its own field on `SessionResumePlan`, for the caller to `chdir`
// into (or pass as the process's working directory) before launch, never as
// an element of `argv`.
//
// Only `claude` resumes. `codex` and `agy` spell their own resume flag
// differently (if they have one at all), and `unknown` means the descriptor
// was captured under an engine this app does not recognise. Guessing a flag
// for either case is how a session opens on an argument the CLI does not
// recognise and dies at the prompt instead of resuming — so this function
// returns `nil` for every engine that is not `.claude`, and the caller is
// expected to fall back to starting a fresh session instead.
//
// This function does not probe the CLI's own conversation history. Whether
// there IS a previous conversation in a given `cwd` is not knowable from the
// descriptor, and not this type's job to find out — `plan(for:)` builds the
// same plan whether or not one exists, and if none does, `claude --continue`
// itself is what tells the operator that inside the terminal.

import Foundation

/// The result of planning a session resume: a working directory and the argv
/// to launch in it. `cwd` never appears inside `argv` — see the file-top note.
public struct SessionResumePlan: Equatable, Sendable {
    public let cwd: String
    public let argv: [String]

    public init(cwd: String, argv: [String]) {
        self.cwd = cwd
        self.argv = argv
    }
}

/// Builds a `SessionResumePlan` from a persisted `SessionDescriptor`, or
/// `nil` when the descriptor's engine is not `claude`.
public enum SessionResume {

    /// Resolves `descriptor.engine` through `ForgeEngine(_:)` — never by
    /// comparing the raw string by hand, which is what would let a case
    /// variant like `"Claude"` silently fall through to "no resume".
    /// `ForgeEngine(_:)` already lowercases before matching, so `"CLAUDE"`
    /// and `"Claude"` resolve to `.claude` exactly like `"claude"` does.
    public static func plan(for descriptor: SessionDescriptor) -> SessionResumePlan? {
        guard case .claude = ForgeEngine(descriptor.engine) else { return nil }

        var argv = ["claude"]
        let account = descriptor.account?.trimmingCharacters(in: .whitespaces) ?? ""
        if !account.isEmpty {
            argv += ["--account", account]
        }
        argv.append("--continue")

        return SessionResumePlan(cwd: descriptor.cwd, argv: argv)
    }
}
