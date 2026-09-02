// BoardViewport — the board's pan/scale transform, as a value you can test
// without a screen.
//
// WHY THIS EXISTS
// ----------------
// `BoardStore` (the app target) owns `pan`/`scale` as `@Published` state and
// mutates them straight from gesture callbacks — `DragGesture`, `MagnifyGesture`,
// the toolbar buttons, `fit(in:)`. That is the right place for the STATE, but it
// means every rule about how the transform behaves (accumulation, the clamp that
// keeps a pan from wandering into the empty canvas, `fit`'s "frame everything"
// math, the screen→canvas conversion a wire-drag needs) has lived only as
// inline arithmetic inside SwiftUI closures — untestable without a window, and
// one bad edit away from a second, silently different implementation once the
// scroll wheel needs the same math (see S02/T04).
//
// `BoardViewport` is that math promoted to a pure value type: `Double` and
// labelled tuples only, the same shape `BoardLayout.contentBounds()` already
// returns, so a caller wires the two together without translating coordinate
// types. `BoardStore` does not use this yet — that delegation is S02/T04, on
// purpose, so the extraction and the risky rewire are two reviewable steps
// instead of one.
//
// THE CLAMP, IN WORDS
// --------------------
// A pan is only interesting to bound while there is content: `content == nil`
// (empty board) returns the pan untouched — there is nothing to stay near.
// Otherwise the scaled content size is `sw = w·scale`, `sh = h·scale`, and
// `keepVisible` (80pt) is how much of it the clamp insists stay on screen —
// unless the content itself is smaller than that, in which case the smaller
// number wins (`keepX = min(keepVisible, sw)`) so a tiny board is not forced to
// keep 80 points of nothing in frame. The legal range for `panX` is
// `[keepX − sw − x·scale, viewport.w − keepX − x·scale]` (mirrored for `panY`);
// a pan outside it is pulled to the nearer edge, and if the viewport is smaller
// than the keep-visible margins the range is empty and the clamp settles on its
// lower bound rather than producing a NaN-adjacent min/max flip.
//
// WHY `fit` IS A FIXED POINT OF THE CLAMP
// -----------------------------------------
// `fit` centers the scaled content in the viewport: its left edge sits at
// `(viewport.w − sw) / 2` and its right edge at `(viewport.w + sw) / 2`. As long
// as `keepX ≤ min(keepVisible, sw)` — which it always is, by definition — both
// edges already sit inside `[keepX, viewport.w − keepX]`, so the pan `fit`
// produces is already inside the clamp's legal range and passing it through
// `clampedPan` returns it unchanged. That is not incidental: it is the
// property that lets the first frame (`fit` runs on `onAppear`, before any
// gesture) start with a pan that is neither zero nor immediately overwritten by
// the very clamp meant to protect it — the failure mode `S02-RISK` named
// explicitly. `BoardViewportTests` below proves it with the same numbers this
// comment describes, not just the shape of the argument.

import Foundation

public struct BoardViewport: Hashable {
    public var panX = 0.0
    public var panY = 0.0
    public var scale = 1.0

    public static let minScale = 0.35
    public static let maxScale = 1.6

    /// Points of content the clamp insists stay visible after any pan.
    public static let keepVisible = 80.0

    /// A scroll-wheel "line" tick (no precise deltas) is worth this many points.
    public static let lineScrollFactor = 10.0

    public init(panX: Double = 0, panY: Double = 0, scale: Double = 1) {
        self.panX = panX
        self.panY = panY
        self.scale = scale
    }

    public var isIdentity: Bool { panX == 0 && panY == 0 && scale == 1 }

    private static func clampScale(_ s: Double) -> Double {
        min(maxScale, max(minScale, s))
    }

    public mutating func zoom(by factor: Double) {
        scale = BoardViewport.clampScale(scale * factor)
    }

    public mutating func scale(to s: Double) {
        scale = BoardViewport.clampScale(s)
    }

    public mutating func reset() {
        scale = 1
        panX = 0
        panY = 0
    }

    /// Frames `content` inside `viewport`, so a canvas panned into the void has
    /// a way home. Matches `BoardStore.fit(in:)` (c3a7344) term for term.
    public mutating func fit(content: (x: Double, y: Double, w: Double, h: Double)?,
                              in viewport: (w: Double, h: Double)) {
        guard let c = content else { reset(); return }
        let sx = viewport.w / c.w
        let sy = viewport.h / c.h
        let s = BoardViewport.clampScale(min(sx, sy))
        scale = s
        panX = -c.x * s + (viewport.w - c.w * s) / 2
        panY = -c.y * s + (viewport.h - c.h * s) / 2
    }

    /// A scroll event's raw delta, in points. Trackpad/precise events pass
    /// through as-is; a wheel's discrete "line" ticks are scaled up so a single
    /// tick reads as a deliberate move rather than a one-point jitter.
    public static func scrollDelta(dx: Double, dy: Double, precise: Bool) -> (x: Double, y: Double) {
        precise ? (dx, dy) : (dx * lineScrollFactor, dy * lineScrollFactor)
    }

    /// What `(panX, panY)` would be after clamping against `content` inside
    /// `viewport`, without mutating `self`. See the file header for the rule.
    public func clampedPan(content: (x: Double, y: Double, w: Double, h: Double)?,
                            in viewport: (w: Double, h: Double)) -> (x: Double, y: Double) {
        guard let c = content else { return (panX, panY) }
        let sw = c.w * scale
        let sh = c.h * scale
        let keepX = min(BoardViewport.keepVisible, sw)
        let keepY = min(BoardViewport.keepVisible, sh)
        let loX = keepX - sw - c.x * scale
        let hiX = viewport.w - keepX - c.x * scale
        let loY = keepY - sh - c.y * scale
        let hiY = viewport.h - keepY - c.y * scale
        let cx = hiX >= loX ? min(hiX, max(loX, panX)) : loX
        let cy = hiY >= loY ? min(hiY, max(loY, panY)) : loY
        return (cx, cy)
    }

    /// Accumulates a relative move (scroll, drag delta) and clamps the result.
    public mutating func pan(by dx: Double, _ dy: Double,
                              content: (x: Double, y: Double, w: Double, h: Double)?,
                              in viewport: (w: Double, h: Double)) {
        panX += dx
        panY += dy
        let clamped = clampedPan(content: content, in: viewport)
        panX = clamped.x
        panY = clamped.y
    }

    /// Sets an absolute pan (a `DragGesture`'s translation-from-origin) and
    /// clamps the result.
    public mutating func setPan(_ x: Double, _ y: Double,
                                 content: (x: Double, y: Double, w: Double, h: Double)?,
                                 in viewport: (w: Double, h: Double)) {
        panX = x
        panY = y
        let clamped = clampedPan(content: content, in: viewport)
        panX = clamped.x
        panY = clamped.y
    }

    /// Undoes `.scaleEffect(scale, anchor: .topLeading)` then `.offset(pan)` —
    /// the R5 transform (c3a7344) a screen-space drag point needs before it can
    /// be compared against layout coordinates.
    public func canvasPoint(fromScreen x: Double, _ y: Double) -> (x: Double, y: Double) {
        ((x - panX) / scale, (y - panY) / scale)
    }
}
