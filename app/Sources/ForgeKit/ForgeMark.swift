// ForgeMark — the shape the app is named after, in one place.
//
// The old mark was a lightning bolt. It was never the right symbol: a bolt is
// "fast" or "power", it is what a hundred apps use for a hundred meanings, and
// on a Dock it is indistinguishable from the three other bolts already there.
// Forge is a FORGE — heat, an anvil, metal that gets hit until it is the shape
// you wanted. That is a specific image, it is nobody else's, and it says what
// the tool does: you bring the raw thing, the app is where it gets worked.
//
// WHY THE GEOMETRY IS DATA AND LIVES HERE
// ---------------------------------------
// Three surfaces draw this mark: the .icns generator, the menu-bar status item,
// and the launch animation. Drawn three times it becomes three anvils within a
// release — the horn a little longer here, the foot a little wider there — and
// nobody notices until they are side by side in a screenshot. Expressed once as
// normalised points, "is the mark the same everywhere" stops being a habit and
// becomes a fact about the build.
//
// Normalised to the unit square, origin BOTTOM-LEFT (AppKit's convention, which
// is where the .icns is drawn). A SwiftUI consumer flips y — `Path` has origin
// top-left — and `ForgeMark.path(in:flipY:)` in the app target does exactly
// that, so no call site does the arithmetic by hand.

import Foundation

public enum ForgeMark {

    /// The anvil outline, clockwise from the horn tip.
    ///
    /// Read it as five features, because that is what the numbers are: the horn
    /// (0–1), the face (2–3), the step under the heel (4–5), the waist (6–7 and
    /// 12–13, mirrored), and the foot (8–11). Tuned against a 16 px render, not
    /// a 1024 px one: at 16 px the waist is two pixels wide, and a waist any
    /// narrower closes up into a solid block that stops reading as an anvil.
    public static let anvil: [(x: Double, y: Double)] = [
        (0.060, 0.578),   // horn tip
        (0.300, 0.690),   // horn meets the face
        (0.905, 0.690),   // face, top right
        (0.905, 0.578),   // heel, right edge
        (0.745, 0.548),   // underside of the heel, stepping in
        (0.648, 0.400),   // waist, right upper
        (0.648, 0.300),   // waist, right lower
        (0.820, 0.262),   // foot flares out
        (0.820, 0.168),   // foot, bottom right
        (0.222, 0.168),   // foot, bottom left
        (0.222, 0.262),   // foot flares out
        (0.394, 0.300),   // waist, left lower
        (0.394, 0.400),   // waist, left upper
        (0.300, 0.548),   // underside of the face, left
    ]

    /// Mjölnir, in two parts.
    ///
    /// NOT A SLEDGE. The previous outline was a realistic hammer — small head on
    /// a long shaft — and it failed twice over: at this size a long thin handle
    /// reads as a stick, and a realistic hammer is a shape nobody recognises in
    /// silhouette. Mjölnir is the opposite trade and the right one here: a heavy
    /// blocky head, a SHORT stubby grip, and a symmetric profile you know from
    /// across the room. It is also the shape the operator asked for.
    ///
    /// The proportions are the whole point. The head is ~44% of the tool's
    /// height and the full width; the grip is a stub. Lengthen the grip and it
    /// stops being Mjölnir and goes back to being a mallet.
    ///
    /// Head down, grip up: the orientation of a blow, stated at rest.
    /// AppKit y-up, like every other mark here.
    public static let hammerHead: [(x: Double, y: Double)] = [
        (0.155, 0.445),   // top-left of the block
        (0.845, 0.445),   // top-right
        (0.910, 0.350),   // flares out to the striking face
        (0.930, 0.120),
        (0.865, 0.035),   // bottom-right
        (0.135, 0.035),   // the striking face runs along here
        (0.070, 0.120),
        (0.090, 0.350),
    ]

    // WHY THE HEAD IS ALSO THREE POLYGONS (S02)
    // -------------------------------------------------------------------
    // `hammerHead` above is, and remains, the single 8-point literal every
    // other surface (`LaunchCurtain`, the .icns generator) reads as `bounds:`
    // for the whole tool — nothing here changes one of its numbers. But the
    // render already TREATS the head as three horizontal bands (a lit top, a
    // plain body, a shadowed striking face) — that split has been implicit
    // in the drawing code and never named. `hammerHeadTop/Body/Face` name it
    // as data: three 4-point polygons, built ONLY from vertices already in
    // `hammerHead` (no interpolated point), whose union is exactly the head
    // by construction — adjacent polygons share the two vertices at their
    // seam (top∩body: the two points at y=0.350; body∩face: the two points
    // at y=0.120), so nothing is added or lost passing from one literal to
    // three.
    //
    // `hammerBands` and `hammerCollar` were already being drawn — as
    // `.offset(y:)` overlays anchored to the launch-animation box frame, not
    // to the mark. Measured on `c3a7344`: the box frame is a square of side
    // `side` and the head occupies only its bottom 44% (y 0.559·side …
    // 1.0·side); the old offsets (`-side * 0.10` for the bands, `-side *
    // 0.205` for the collar) land ABOVE that range, so `.clipShape(head)`
    // silently erased both. Expressing them here, in the mark's own unit
    // square, is what lets a caller place them BY the head's geometry
    // instead of by the frame around it.
    /// Topo da cabeça: a faixa que se alarga da junção com o cabo até a largura plena.
    public static let hammerHeadTop: [(x: Double, y: Double)] = [
        (0.155, 0.445), (0.845, 0.445), (0.910, 0.350), (0.090, 0.350),
    ]
    /// Corpo: o bloco entre as duas inflexões laterais — onde as bandas incisas vivem.
    public static let hammerHeadBody: [(x: Double, y: Double)] = [
        (0.090, 0.350), (0.910, 0.350), (0.930, 0.120), (0.070, 0.120),
    ]
    /// Face de golpe: a faixa inferior, em sombra, cujo lado de baixo é a face que bate na bigorna.
    public static let hammerHeadFace: [(x: Double, y: Double)] = [
        (0.070, 0.120), (0.930, 0.120), (0.865, 0.035), (0.135, 0.035),
    ]
    /// As duas bandas incisas, como retângulos no quadrado da ferramenta (y-up),
    /// dentro da faixa de y de `hammerHeadBody` — não do frame do box que as
    /// continha antes (ver nota acima).
    public static let hammerBands: [(x: Double, y: Double, w: Double, h: Double)] = [
        (0.190, 0.290, 0.620, 0.014),
        (0.190, 0.245, 0.620, 0.014),
    ]
    /// O collar onde o cabo entra — dentro da faixa de y de `hammerHeadTop`.
    ///
    /// Números de bandas e collar podem ser afinados livremente (é
    /// decoração da cabeça, não o contorno que outras superfícies leem como
    /// `bounds:`); o que NÃO pode mudar sem revisar `ForgeKitTests` é a
    /// invariante estrutural: os quatro vértices de cada polígono vêm de
    /// `hammerHead`, a costura entre polígonos adjacentes é de exatamente
    /// dois vértices, e a bbox/área da união bate com `hammerHead` original.
    public static let hammerCollar: (x: Double, y: Double, w: Double, h: Double) = (0.370, 0.400, 0.260, 0.030)

    /// The grip: short, straight, with a slight swell at the pommel.
    public static let hammerHandle: [(x: Double, y: Double)] = [
        (0.395, 0.430),
        (0.605, 0.430),
        (0.625, 0.845),
        (0.590, 0.965),
        (0.410, 0.965),
        (0.375, 0.845),
    ]

    /// Every point of both parts, for callers that need the whole tool's
    /// bounding box — the fit is computed across the WHOLE tool so head and grip
    /// keep their relative positions instead of each centring in its own frame.
    public static var hammer: [(x: Double, y: Double)] { hammerHead + hammerHandle }

    /// The middle of the striking face, in the tool's unit square. The animation
    /// lands THIS point on the anvil, so resizing never moves the blow.
    public static let hammerStrikePoint = (x: 0.500, y: 0.035)

    /// Where the hand holds it, in the same square. The swing rotates about this
    /// and translates the tool along an arc — see `LaunchCurtain`. A short grip
    /// means rotation alone cannot carry the head anywhere, which is exactly why
    /// the first attempt looked like a pendulum.
    public static let hammerGrip = (x: 0.500, y: 0.900)

    /// Where the heat sits, as a fraction of the tile. The glow is centred
    /// below the anvil rather than on it: a forge is lit from the coals, and a
    /// glow centred ON the mark washes the silhouette out at 16 px — which is
    /// the size that decides whether an icon works.
    public static let glowCenter = (x: 0.5, y: 0.40)
    public static let glowRadius = 0.52

    /// The plate's corner radius as a fraction of its width. macOS's icon grid
    /// puts the squircle at ~22.37%; matching it is what makes an icon sit in
    /// the Dock instead of on top of it.
    public static let plateCornerRatio = 0.2237

    /// How far the plate is inset from the tile edge. Apple's own icons do not
    /// fill their tile; one that does reads as bigger and cheaper than its
    /// neighbours.
    public static let plateInset = 0.06
}
