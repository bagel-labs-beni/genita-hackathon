import Foundation
import Testing
@testable import GenitaKit

/// Demo S3 · SAM 3.1 pixel masks (#298, GENITA_SAM_MASKS=1): `observe.boxes.items[].mask` = a w×h grid stretched
/// over the item's box, row-major runs alternating 0s and 1s, starting with 0s; sum(rle) == w*h.
struct NormMaskTests {
    @Test func decodesTheWireAndKeepsOldEventsWorking() throws {
        let json = #"{"type":"observe.boxes","findId":"f","frame":1,"w":480,"h":854,"items":[{"label":"Tofu","box":{"x1":0.1,"y1":0.2,"x2":0.3,"y2":0.4},"mask":{"w":3,"h":2,"rle":[1,2,1,2]}},{"label":"Egg","box":{"x1":0.5,"y1":0.5,"x2":0.6,"y2":0.6}}]}"#
        guard case let .observeBoxes(b) = try JSONDecoder().decode(ServerEvent.self, from: Data(json.utf8)) else { Issue.record("not observe.boxes"); return }
        #expect(b.items[0].mask == NormMask(w: 3, h: 2, rle: [1, 2, 1, 2]))
        #expect(b.items[1].mask == nil, "an item without a mask is drawn as a box, as before")
    }

    @Test func expandsRunsRowMajorStartingWithZeros() {
        // 3×2: row 0 = 0 1 1, row 1 = 0 1 1
        #expect(NormMask(w: 3, h: 2, rle: [1, 2, 1, 2]).bitmap() == [0, 255, 255, 0, 255, 255])
        // first run 0 = starts with ones
        #expect(NormMask(w: 2, h: 1, rle: [0, 2]).bitmap() == [255, 255])
    }

    @Test func aBrokenMaskIsDroppedNotDrawnWrong() {
        #expect(NormMask(w: 3, h: 2, rle: [1, 2]).bitmap() == nil, "runs must cover w*h")
        #expect(NormMask(w: 0, h: 2, rle: []).bitmap() == nil)
        #expect(NormMask(w: 2, h: 1, rle: [-1, 3]).bitmap() == nil)
        #expect(NormMask(w: 400, h: 400, rle: [160_000]).bitmap() == nil, "the wire caps the long side at 96")
    }

    @Test func theOutlineIsTheInsideCellsNextToTheOutside() {
        // 3×3 all inside: only the centre is not on the edge
        #expect(NormMask(w: 3, h: 3, rle: [0, 9]).edgeBitmap() == [255, 255, 255, 255, 0, 255, 255, 255, 255])
        #expect(NormMask(w: 2, h: 1, rle: [2]).edgeBitmap() == [0, 0], "empty mask, no outline")
    }
}
