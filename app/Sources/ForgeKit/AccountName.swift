// AccountName — the single legal shape for an account name in the app.
//
// Mirrors `NAME_RE` in `scripts/forge-accounts.js:77`
// (`/^[a-z0-9][a-z0-9._-]{0,31}$/i`), the engine's own gate on the same
// field. S06 (read path, `resumeSession`) and S07 (write path, account
// creation) both validate this field, so there must be exactly one
// definition of what "legal" means — this type is it. Nothing else in the
// app is allowed to grow a second regex or scanner for an account name;
// callers that need to validate one call here.
//
// Deliberately NOT built on `NSRegularExpression`: ICU's `$` (without
// `.anchorsMatchLines`) matches at the absolute end of the input OR just
// before a single trailing line terminator — so a naive
// `"^...$"` pattern run through `firstMatch` would accept `"validname\n"`,
// silently passing a name with an embedded newline into what later becomes
// a process argument. A hand-rolled Character scan has no such trap: it
// walks every Character of the input and rejects on the first one outside
// the allowed set, so a trailing (or embedded) newline is rejected exactly
// like any other disallowed byte, and there is no `try!` whose failure would
// need justifying.
public enum AccountName {

    /// The pattern this type enforces, kept as documentation and as the
    /// literal string other tooling (docs, error messages) may want to
    /// display. `isValid(_:)` does NOT run this through a regex engine —
    /// see the type doc-comment for why.
    public static let pattern = "^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$"

    /// True iff `name` is 1–32 characters, the first character is an ASCII
    /// letter or digit, and every following character is an ASCII letter,
    /// digit, `.`, `_`, or `-`. Anything else — empty string, leading
    /// space, leading `-`/`_`/`.`, an embedded or trailing newline, shell
    /// metacharacters (`;`, `|`, `$`, backtick, quotes, `/`), non-ASCII —
    /// is rejected.
    public static func isValid(_ name: String) -> Bool {
        guard !name.isEmpty, name.count <= 32 else { return false }
        var isFirst = true
        for ch in name {
            if isFirst {
                guard isAlphanumeric(ch) else { return false }
                isFirst = false
                continue
            }
            guard isAlphanumeric(ch) || ch == "." || ch == "_" || ch == "-" else { return false }
        }
        return true
    }

    /// nil for a valid name; a non-empty, human-readable pt-BR reason
    /// otherwise. Never sanitises — a rejected name is reported, not
    /// silently rewritten into a different, valid one.
    public static func rejection(_ name: String) -> String? {
        isValid(name)
            ? nil
            : "Nome de conta inválido — use letras, dígitos, ponto, underscore ou hífen " +
              "(começando por letra ou dígito, máx. 32 caracteres)."
    }

    private static func isAlphanumeric(_ ch: Character) -> Bool {
        ch.isASCII && (ch.isLetter || ch.isNumber)
    }
}
