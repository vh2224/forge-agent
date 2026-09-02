// AccountAdmin — registering a Claude account from the app, in two pure
// pieces: the argv builder for `forge-accounts.js --add`, and the merge that
// reconciles the app's account list with the engine's `--list --json`.
//
// Neither function touches a process. `AccountAdd.argv` hands back the
// argument vector that the UI layer passes to the same `TerminalSession`
// infra `resumeSession` already uses (S06 precedent) — no `Process()` here,
// no quoting here (D4, S07-PLAN.md). `AccountMerge` reads the result of
// running that command back through `--list --json`; it never sees an exit
// code, because the exit code lies (see the doc-comment on
// `AccountMerge.outcome(for:in:)`).

// MARK: - AccountAdd

public enum AccountAdd {

    /// Builds the argv for `forge-accounts.js --add <name> --setup`, or
    /// `nil` if any input is unusable.
    ///
    /// Three things this function deliberately does NOT do:
    ///
    /// 1. **Re-validate the name.** `name` is checked with
    ///    `AccountName.isValid(_:)` (T01) — the single source of truth for
    ///    what a legal account name looks like. A second, slightly
    ///    different check here is exactly the failure mode S07-PLAN.md's D1
    ///    exists to close.
    /// 2. **Resolve `node`/`script`.** Both come in by parameter (D3):
    ///    ForgeKit cannot import `ForgeCore` (that's what makes this type
    ///    testable without the app target), so path resolution stays in the
    ///    UI layer, using the same helpers `ForgeCore.run` already uses.
    /// 3. **Decide whether to pass `--setup`.** It is always emitted,
    ///    unconditionally, for a valid name. `forge-accounts.js`'s CLI would
    ///    otherwise infer the setup flow from `process.stdin.isTTY`
    ///    (forge-accounts.js:906-919) — a signal the app's embedded PTY does
    ///    not control in any way the app can rely on. Passing `--setup`
    ///    explicitly makes the flow deterministic regardless of what the PTY
    ///    reports (D2).
    ///
    /// The token never passes through this function or its return value —
    /// `forge-accounts.js` captures it itself via
    /// `stdio: ['inherit','pipe','inherit']` (forge-accounts.js:837-838).
    /// This builder cannot leak what it never sees.
    public static func argv(
        node: String,
        script: String,
        name: String,
        note: String? = nil
    ) -> [String]? {
        guard !node.isEmpty, !script.isEmpty else { return nil }
        guard AccountName.isValid(name) else { return nil }

        var out = [node, script, "--add", name, "--setup"]

        // `--note`, if present, must never be readable as a flag by
        // `parseArgs` (forge-accounts.js:783-794): that parser treats any
        // token starting with `--` as a new flag, not a value, so a note
        // beginning with `-` would silently vanish as an argument rather
        // than being stored. Blank/whitespace-only notes carry nothing
        // worth persisting either, so both are omitted rather than passed
        // through.
        if let note {
            let trimmed = note.trimmingCharacters(in: .whitespacesAndNewlines)
            if !trimmed.isEmpty, !trimmed.hasPrefix("-") {
                out.append("--note")
                out.append(note)
            }
        }

        return out
    }
}

// MARK: - AccountMerge

/// The outcome of reconciling the app's in-memory account list with a fresh
/// `--list --json` from the engine.
public struct AccountMergeResult: Equatable {
    public let accounts: [Account]
    public let added: [String]
    public let removed: [String]
    public let active: String?

    public init(accounts: [Account], added: [String], removed: [String], active: String?) {
        self.accounts = accounts
        self.added = added
        self.removed = removed
        self.active = active
    }
}

/// Whether a just-attempted account registration actually produced a usable
/// account.
public enum AccountSetupOutcome: Equatable {
    /// The account exists in the reconciled list and carries a token.
    case registered
    /// The account exists in the reconciled list but has no token yet.
    case registeredWithoutToken
    /// The account is not in the reconciled list at all.
    case missingFromRegistry
}

public enum AccountMerge {

    /// Reconciles `previous` (the app's last known list) with `incoming`
    /// (a fresh `--list --json`).
    ///
    /// - Membership comes entirely from `incoming` — the engine's registry
    ///   is the source of truth. An account present only in `previous` does
    ///   not survive the merge; it lands in `removed`.
    /// - Ordering does not come from `incoming`: surviving accounts keep
    ///   their relative order from `previous`, and only newly-appeared
    ///   accounts are appended, in `incoming`'s order. A `--list` reload
    ///   must not reshuffle the list under the operator's eyes for accounts
    ///   that were already there (D7).
    /// - Every field of every account in the result comes from `incoming`,
    ///   never from `previous` — a merge that kept stale `has_token`/
    ///   `days_left` from `previous` would misreport the very facts this
    ///   type exists to get right.
    /// - `active` resolves `incoming.env_active ?? incoming.active` and is
    ///   forced to `nil` if that name is not among `incoming.accounts` — the
    ///   merge never points the UI at a phantom active account.
    public static func reconcile(previous: [Account], incoming: AccountsPayload) -> AccountMergeResult {
        let previousNames = previous.map(\.name)
        let previousSet = Set(previousNames)
        let incomingByName = Dictionary(uniqueKeysWithValues: incoming.accounts.map { ($0.name, $0) })
        let incomingSet = Set(incomingByName.keys)

        var accounts: [Account] = []
        accounts.reserveCapacity(incoming.accounts.count)

        // Survivors, in previous's order, with fields refreshed from incoming.
        for name in previousNames {
            if let fresh = incomingByName[name] {
                accounts.append(fresh)
            }
        }
        // New arrivals, in incoming's order.
        for account in incoming.accounts where !previousSet.contains(account.name) {
            accounts.append(account)
        }

        let added = incoming.accounts.map(\.name).filter { !previousSet.contains($0) }
        let removed = previousNames.filter { !incomingSet.contains($0) }

        let resolvedActive = incoming.env_active ?? incoming.active
        let active = (resolvedActive != nil && incomingSet.contains(resolvedActive!)) ? resolvedActive : nil

        return AccountMergeResult(accounts: accounts, added: added, removed: removed, active: active)
    }

    /// Reads success from the reconciled list, never from a shell exit code.
    ///
    /// The `setup-token` bootstrap is typed into a login shell embedded in
    /// the app's terminal, so the exit code `processTerminated` reports is
    /// the login shell's exit code, not the setup command's — it is 0 in
    /// cases where the token capture failed or was cancelled partway
    /// through. The only fact this function trusts is what
    /// `--list --json` reports back after the fact: whether the account
    /// exists, and whether it carries a token.
    public static func outcome(for name: String, in result: AccountMergeResult) -> AccountSetupOutcome {
        guard let account = result.accounts.first(where: { $0.name == name }) else {
            return .missingFromRegistry
        }
        return account.has_token ? .registered : .registeredWithoutToken
    }
}
