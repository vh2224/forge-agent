// PaletteRanking — how ⌘K decides what you meant.
//
// In ForgeKit and not next to the view, for the reason every ranking rule in
// this repo is: "does typing `quad` find Quadro" is a question with a right
// answer, and it should be answerable without opening a window.
//
// SUBSEQUENCE, NOT PREFIX. A prefix filter is what makes a palette feel broken:
// `prefs` would not find "Preferências" (accent, and the word starts the same
// but the match is not a prefix of the full haystack once the keywords are
// appended), and `nsess` would not find "Nova sessão". Matching the query's
// characters in order, anywhere, is what every editor's finder does.
//
// The score is then what separates a good match from a technically-valid one:
// consecutive characters and matches at a word start are worth more, so `terb`
// ranks "Terminal: Abas" over some item that merely contains t, e, r, b in that
// order across three words.

import Foundation

public enum PaletteRanking {

    /// Ranks `items` (id, haystack) against `query`, best first, dropping
    /// anything that does not match at all.
    public static func rank(_ items: [(id: String, text: String)], query: String) -> [String] {
        // Trimmed BEFORE the empty check, not after. Untrimmed, a query of one
        // space is not empty, so it went to `score`, where the space became a
        // character every haystack had to contain in order — and "Alpha" has no
        // space, so a stray keystroke emptied the whole palette. Found by
        // `ForgeKitTests`, which is the entire reason this ranking lives here
        // and not next to the view.
        let q = fold(query.trimmingCharacters(in: .whitespacesAndNewlines))
        guard !q.isEmpty else { return items.map(\.id) }
        return items
            .compactMap { item -> (String, Int)? in
                guard let s = score(fold(item.text), q) else { return nil }
                return (item.id, s)
            }
            // Stable by score, then by the order the caller supplied — so a tie
            // does not reshuffle the list between keystrokes, which reads as the
            // palette twitching.
            .enumerated()
            .sorted { a, b in
                a.element.1 == b.element.1 ? a.offset < b.offset : a.element.1 > b.element.1
            }
            .map(\.element.0)
    }

    /// Lowercased and stripped of diacritics.
    ///
    /// The accent fold is not cosmetic here: half this app's UI is Portuguese,
    /// and without it "preferencias" never finds "Preferências" — which is
    /// exactly what somebody types, because typing the accent takes a dead key.
    public static func fold(_ s: String) -> String {
        s.folding(options: [.diacriticInsensitive, .caseInsensitive], locale: Locale(identifier: "pt_BR"))
    }

    /// `nil` when `query` is not a subsequence of `text`.
    public static func score(_ text: String, _ query: String) -> Int? {
        let t = Array(text), q = Array(query)
        guard !q.isEmpty else { return 0 }

        var ti = 0, qi = 0, total = 0, streak = 0
        while ti < t.count && qi < q.count {
            if t[ti] == q[qi] {
                var points = 10
                streak += 1
                // Consecutive characters compound: a run of four is worth much
                // more than four scattered hits, which is what makes whole-word
                // typing win over accidental letter soup.
                points += min(streak, 6) * 4
                // A match at the start of a word is what the operator is almost
                // always aiming at.
                if ti == 0 || t[ti - 1] == " " || t[ti - 1] == "/" || t[ti - 1] == "-" {
                    points += 18
                }
                total += points
                qi += 1
            } else {
                streak = 0
            }
            ti += 1
        }
        guard qi == q.count else { return nil }
        // Shorter haystacks win ties: "Runs" should beat a run whose keywords
        // happen to contain the same letters across a long path.
        return total - min(t.count / 4, 20)
    }
}
