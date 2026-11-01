import Foundation

struct HandoffPosition {
    let x: Double, y: Double, z: Double, width: Double, height: Double
    init?(_ data: [String: Any]) {
        guard data["state"] as? String == "tracking",
              let x = data["x"] as? Double, let y = data["y"] as? Double,
              let z = data["z"] as? Double, let w = data["widthM"] as? Double,
              let h = data["heightM"] as? Double,
              [x,y,z,w,h].allSatisfy({ $0.isFinite }), w > 0.25, h > 0.15 else { return nil }
        self.x=x; self.y=y; self.z=z; width=w; height=h
    }
    var right: Bool { x > 0 }
    func touchesEdge(phoneHeight: Double) -> Bool {
        abs(abs(x)-width/2) <= 0.14 && abs(z) <= 0.3 && abs(y) <= height/2 + phoneHeight/2 - 0.01
    }
    func sameDock(_ other: Self) -> Bool { right == other.right && abs(y-other.y) <= 0.04 }
}
