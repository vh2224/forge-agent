// PromptEditor — the composer's text field.
//
// SwiftUI's TextEditor was the wrong primitive here for two reasons that both
// showed up in use:
//
//   1. Its NSTextView adds text-container insets (~5pt leading, ~1pt top) that
//      no sibling Text has, and it exposes no usable text baseline — so the
//      prompt glyph and the placeholder could not be aligned with the typed
//      line by any combination of .top or .firstTextBaseline. Compensating with
//      magic constants got close and still drifted with font size.
//
//   2. It swallows arrows and tab, which the completion menu needs.
//
// Owning the NSTextView fixes both properly: insets are zeroed so text starts at
// (0,0) and lines up with a plain Text, and key handling is a delegate call
// rather than a global event monitor watching every keystroke in the app.

import SwiftUI
import AppKit

struct PromptEditor: NSViewRepresentable {
    @Binding var text: String
    var font: NSFont = .systemFont(ofSize: 15)
    var onKey: (KeyAction) -> Bool = { _ in false }
    var onSubmit: () -> Void = {}
    /// Reports how tall the laid-out text actually is.
    ///
    /// Without it the editor is a `NSViewRepresentable` with no intrinsic
    /// content size, so SwiftUI hands it the whole height it is allowed and the
    /// composer sits as a tall empty box waiting for a paragraph nobody is going
    /// to type. Measuring the laid-out text — not counting "\n" — is the only
    /// version that is right when a long line wraps.
    var onHeightChange: (CGFloat) -> Void = { _ in }

    enum KeyAction { case up, down, tab, enter, shiftEnter, escape }

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    func makeNSView(context: Context) -> NSScrollView {
        let scroll = NSTextView.scrollableTextView()
        scroll.drawsBackground = false
        scroll.hasVerticalScroller = false
        scroll.verticalScrollElasticity = .none

        guard let tv = scroll.documentView as? KeyCatchingTextView ?? {
            // scrollableTextView() builds a plain NSTextView; swap in the
            // subclass that reports key presses.
            let custom = KeyCatchingTextView(frame: .zero)
            custom.autoresizingMask = [.width]
            scroll.documentView = custom
            return custom
        }() else { return scroll }

        tv.delegate = context.coordinator
        tv.keyHandler = { context.coordinator.handle($0) }
        tv.font = font
        tv.drawsBackground = false
        tv.isRichText = false
        tv.isAutomaticQuoteSubstitutionEnabled = false
        tv.isAutomaticDashSubstitutionEnabled = false
        tv.isAutomaticTextReplacementEnabled = false
        tv.textColor = .labelColor
        tv.insertionPointColor = .labelColor

        // The whole point: no inset anywhere, so the first glyph sits at the
        // view's origin and a Text beside it lands on the same line.
        tv.textContainerInset = .zero
        tv.textContainer?.lineFragmentPadding = 0

        tv.string = text
        // A window resize changes the wrap width without touching the text or
        // firing `textDidChange`, so height reporting has to also hang off the
        // text view's own frame changes.
        tv.postsFrameChangedNotifications = true
        NotificationCenter.default.addObserver(
            context.coordinator,
            selector: #selector(Coordinator.frameChanged(_:)),
            name: NSView.frameDidChangeNotification,
            object: tv)
        DispatchQueue.main.async { context.coordinator.reportHeight(tv) }
        return scroll
    }

    func updateNSView(_ scroll: NSScrollView, context: Context) {
        guard let tv = scroll.documentView as? NSTextView else { return }
        if tv.string != text { tv.string = text }
        if tv.font != font { tv.font = font }
        // Async: measuring inside `updateNSView` reports the height for the
        // layout that is being replaced, and writing SwiftUI state from within
        // an update pass is what raises "Modifying state during view update".
        DispatchQueue.main.async { context.coordinator.reportHeight(tv) }
    }

    final class Coordinator: NSObject, NSTextViewDelegate {
        private let parent: PromptEditor
        init(_ parent: PromptEditor) { self.parent = parent }

        func textDidChange(_ notification: Notification) {
            guard let tv = notification.object as? NSTextView else { return }
            parent.text = tv.string
            reportHeight(tv)
        }

        @objc func frameChanged(_ notification: Notification) {
            guard let tv = notification.object as? NSTextView else { return }
            reportHeight(tv)
        }

        deinit {
            NotificationCenter.default.removeObserver(self, name: NSView.frameDidChangeNotification, object: nil)
        }

        /// The height of the laid-out text, deduplicated.
        ///
        /// `ensureLayout` first: `usedRect` is only meaningful once the layout
        /// manager has run, and on a view that was just handed a new string it
        /// has not. The 0.5pt guard stops a re-report loop — a height change
        /// resizes the view, which triggers another update, which measures
        /// again.
        func reportHeight(_ tv: NSTextView) {
            guard let lm = tv.layoutManager, let tc = tv.textContainer else { return }
            lm.ensureLayout(for: tc)
            let h = ceil(lm.usedRect(for: tc).height)
            guard abs(h - lastReported) > 0.5 else { return }
            lastReported = h
            parent.onHeightChange(h)
        }

        private var lastReported: CGFloat = 0

        /// Returns true when the key was consumed by the completion menu.
        func handle(_ action: KeyAction) -> Bool {
            parent.onKey(action)
        }
    }
}

/// NSTextView that offers arrow/tab/return/escape to a handler before treating
/// them as editing. The handler returns true to consume the key.
final class KeyCatchingTextView: NSTextView {
    var keyHandler: ((PromptEditor.KeyAction) -> Bool)?

    override func keyDown(with event: NSEvent) {
        let action: PromptEditor.KeyAction?
        switch event.keyCode {
        case 126: action = .up
        case 125: action = .down
        case 48:  action = .tab
        case 36:  action = event.modifierFlags.contains(.shift) ? .shiftEnter : .enter
        case 53:  action = .escape
        default:  action = nil
        }
        if let action, keyHandler?(action) == true { return }
        super.keyDown(with: event)
    }
}
