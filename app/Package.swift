// swift-tools-version:5.9
//
// SwiftTerm provides the VT emulator. Writing one is not a shortcut worth
// taking: Claude Code repaints continuously (alternate screen, cursor
// addressing, colour), so a partial parser produces a garbled screen rather
// than a degraded one.
//
// Build via ./build.sh, which wraps `swift build` and assembles the .app.

import PackageDescription

let package = Package(
    name: "Forge",
    platforms: [.macOS("26.0")],
    dependencies: [
        .package(url: "https://github.com/migueldeicaza/SwiftTerm", from: "1.15.0"),
        // Motion. SwiftUI's own transitions are a fade and a slide; Pow is the
        // set the app would otherwise hand-roll one effect at a time.
        .package(url: "https://github.com/movingparts-io/Pow", from: "1.0.0"),
        // Markdown. Every .gsd artefact is Markdown and the app renders them
        // through a hand-rolled block parser (`MarkdownBlocks`).
        .package(url: "https://github.com/gonzalezreal/swift-markdown-ui", from: "2.4.0"),
        // Syntax highlighting for the diff surfaces. Pure Swift, no JS engine
        // behind it — which is why it and not Highlightr.
        .package(url: "https://github.com/JohnSundell/Splash", from: "0.16.0"),
    ],
    targets: [
        // Pure logic lives here so it can be tested: an executable target cannot
        // be imported by a test target, and the parts most worth pinning down
        // (JSONC editing, git parsing, engine resolution) carry no UI anyway.
        // `resources:` carries the vendored brand marks (Simple Icons CC0,
        // Octicons MIT — see Sources/ForgeKit/Resources/icons/PROVENANCE.md).
        // They live in ForgeKit rather than in Forge for one reason that
        // decides it: ForgeKitTests can import ForgeKit and cannot import the
        // executable, so this is the only placement where "every mark actually
        // resolves" is a test instead of a hope. `.copy` and not `.process`:
        // processing an SVG on a machine without Xcode has no tool to run, and
        // the folder structure is what `BrandArt.directory` looks under.
        .target(name: "ForgeKit", path: "Sources/ForgeKit",
                resources: [.copy("Resources/icons")]),
        .executableTarget(
            name: "Forge",
            dependencies: [
                "SwiftTerm", "ForgeKit", "Pow", "Splash",
                .product(name: "MarkdownUI", package: "swift-markdown-ui"),
            ],
            path: "Sources/Forge"
        ),
        // Executable, not a testTarget: XCTest requires full Xcode and this
        // repo builds against the Command Line Tools.
        .executableTarget(name: "ForgeKitTests", dependencies: ["ForgeKit"], path: "Sources/ForgeKitTests"),
        // The .icns generator. A target and not the loose `make-icon.swift` it
        // used to be, for one reason: a loose script cannot import anything, so
        // the anvil had to be written out twice — once for the icon and once for
        // the menu bar. `ForgeMark` is now the only copy.
        .executableTarget(name: "ForgeIcon", dependencies: ["ForgeKit"], path: "Sources/ForgeIcon"),
    ]
)
