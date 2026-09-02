// BoardScrollCatcher — two-finger scroll for the board, from a view that
// provably cannot swallow a click.
//
// WHY NOT JUST `scrollWheel(with:)` ON AN NSView
// -----------------------------------------------
// The obvious shape — an `NSViewRepresentable` behind the grid that overrides
// `scrollWheel(with:)` — does not survive reading `NSView.hitTest(_:)`. That
// method receives a POINT and nothing else: no event, no event type. AppKit
// routes `scrollWheel` to whatever view hit-tests at the cursor, which is the
// same view it routes `mouseDown` to. So a view arranged to receive scroll is
// by construction arranged to receive clicks, and it then has exactly two
// futures: it eats the grid's `DragGesture`/`MagnifyGesture`/`onTapGesture`
// (the failure the ROADMAP feared), or it forwards `mouseDown` to `super` and
// the effect of that on sibling SwiftUI gestures is something nobody can
// observe without staring at the screen.
//
// So the roles are split, and each one is auditable by reading:
//
//   * `hitTest(_:)` returns `nil`, unconditionally. This view is invisible to
//     the whole mouse-routing system — click, drag and pinch reach the grid's
//     SwiftUI gestures untouched, and that is a property of the code rather
//     than of a screenshot.
//   * The scroll therefore cannot arrive by routing, so it arrives by
//     `NSEvent.addLocalMonitorForEvents(matching: .scrollWheel)`, which sees
//     events before routing and is filtered here by window, by the view's own
//     `bounds`, and finally by the caller's hit test (a node under the cursor
//     means the terminal keeps its scroll).
//
// The monitor is installed on `viewDidMoveToWindow` and removed in `remove()`,
// called from `deinit` and from `dismantleNSView` — the same explicit-teardown
// discipline `PromptEditor` and `TerminalHost` use for their own AppKit
// resources. A local monitor that outlives its view is a retain cycle wearing a
// scroll gesture.
//
// `isFlipped` is `true` so the point handed to the caller is top-left based,
// the same system SwiftUI's board coordinates and `BoardViewport` use. Without
// it every node hit test would be mirrored vertically.

import SwiftUI
import AppKit

struct BoardScrollCatcher: NSViewRepresentable {
    /// Called for each scroll event landing inside the view's bounds.
    ///
    /// Returns `true` when the board consumed the event (the monitor then
    /// swallows it), `false` to let it continue to its normal destination —
    /// which is how a terminal under the cursor keeps scrolling its own buffer.
    /// `point` is in view coordinates: flipped, top-left origin.
    let onScroll: (_ dx: Double, _ dy: Double, _ precise: Bool, _ point: CGPoint) -> Bool

    final class CatcherView: NSView {
        var onScroll: ((Double, Double, Bool, CGPoint) -> Bool)?
        private var monitor: Any?

        override var isFlipped: Bool { true }

        /// Never in the hit-test tree. See the file header: this is the whole
        /// reason the scroll has to come from a monitor.
        override func hitTest(_ point: NSPoint) -> NSView? { nil }

        override func viewDidMoveToWindow() {
            super.viewDidMoveToWindow()
            install()
        }

        func install() {
            remove()
            guard window != nil else { return }
            monitor = NSEvent.addLocalMonitorForEvents(matching: .scrollWheel) { [weak self] ev in
                guard let self, let window = self.window, ev.window === window else { return ev }
                // `.mayBegin` and `.cancelled` carry no delta — a trackpad
                // announcing a gesture it has not started. Momentum phases do
                // carry deltas and pass through normally: momentum is just more
                // accumulation, which is what `BoardViewport.pan(by:)` does.
                if ev.phase == .mayBegin || ev.phase == .cancelled { return ev }
                let p = self.convert(ev.locationInWindow, from: nil)
                guard self.bounds.contains(p) else { return ev }
                let consumed = self.onScroll?(ev.scrollingDeltaX,
                                              ev.scrollingDeltaY,
                                              ev.hasPreciseScrollingDeltas,
                                              p) ?? false
                return consumed ? nil : ev
            }
        }

        func remove() {
            if let m = monitor {
                NSEvent.removeMonitor(m)
                monitor = nil
            }
        }

        deinit { remove() }
    }

    func makeNSView(context: Context) -> CatcherView {
        let view = CatcherView(frame: .zero)
        view.onScroll = onScroll
        return view
    }

    func updateNSView(_ nsView: CatcherView, context: Context) {
        // The closure captures `board` and the current `focused` id, so it is
        // rebuilt on every SwiftUI update and has to be re-installed — keeping
        // the first one would hit-test against a stale focus.
        nsView.onScroll = onScroll
    }

    static func dismantleNSView(_ nsView: CatcherView, coordinator: ()) {
        nsView.remove()
    }
}
