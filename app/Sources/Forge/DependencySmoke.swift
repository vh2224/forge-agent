// DependencySmoke — compile-time proof that the declared-but-unused dependencies build.
//
// Package.swift declared Pow, MarkdownUI and Splash without a single import anywhere in the
// repo, and Charts is an SDK framework that S02 assumes compiles under Command Line Tools.
// Discovering that one of the four does not compile costs five lines here — the alternative
// is discovering it mid-slice in S02 or S05, with real UI code depending on it.
//
// Who inherits each import when this file goes away:
//   - S02 moves `import Charts` into MetricsView.swift (the metrics chart surface).
//   - S05 moves MarkdownUI and Splash into the review/diff views (rendered markdown and
//     syntax-highlighted diffs).
//   - Pow's transition is picked up by the S02/S03 view transitions.
// Once all four imports have real call sites elsewhere in the target, this file can go.
//
// Deliberately self-contained: nothing else in the target references `DependencySmoke`. It
// only needs to be part of the `Forge` target to be compiled — that is the whole point of a
// compile-time smoke test.

import SwiftUI
import Charts
import MarkdownUI
import Splash
import Pow

enum DependencySmoke {
    /// Charts: a minimal chart, proving `Chart` and `BarMark` resolve and compile.
    static var chart: some View {
        Chart {
            BarMark(x: .value("x", "a"), y: .value("y", 1))
        }
    }

    /// MarkdownUI: a minimal rendered document, proving `Markdown(_:)` resolves.
    static var markdown: some View {
        Markdown("# ok")
    }

    /// Splash: a minimal syntax highlight call, proving `SyntaxHighlighter`,
    /// `AttributedStringOutputFormat` and `Theme.sundellsColors` resolve. `Splash.Font` is
    /// qualified to avoid colliding with `SwiftUI.Font`.
    static func highlight(_ code: String) -> NSAttributedString {
        let theme = Theme.sundellsColors(withFont: Splash.Font(size: 12))
        return SyntaxHighlighter(format: AttributedStringOutputFormat(theme: theme)).highlight(code)
    }

    /// Pow: a minimal transition, proving `AnyTransition.movingParts` resolves.
    static var transition: AnyTransition {
        .movingParts.blur
    }
}
