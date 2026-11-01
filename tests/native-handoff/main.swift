import Foundation
func position(_ x:Double,_ y:Double,_ z:Double=0.1)->HandoffPosition {HandoffPosition(["state":"tracking","x":x,"y":y,"z":z,"widthM":0.54,"heightM":0.30])!}
let phoneHeight=0.14478
for x in [-0.28,0.28] {
 for y in [-0.20,-0.15,0,0.15,0.20] {assert(position(x,y).touchesEdge(phoneHeight:phoneHeight))}
 assert(!position(x,0.24).touchesEdge(phoneHeight:phoneHeight))
 assert(!position(x,0,0.5).touchesEdge(phoneHeight:phoneHeight))
}
assert(!position(0,0).touchesEdge(phoneHeight:phoneHeight))
assert(position(-0.28,0.1).sameDock(position(-0.28,0.12)))
assert(!position(-0.28,0.1).sameDock(position(0.28,0.1)))
assert(!position(-0.28,0.1).sameDock(position(-0.28,-0.1)))
assert(HandoffPosition(["state":"limited","x":0.2,"y":0.1,"z":0.1,"widthM":0.54,"heightM":0.3]) == nil)
assert(HandoffPosition(["state":"tracking","x":Double.nan,"y":0.1,"z":0.1,"widthM":0.54,"heightM":0.3]) == nil)
print("PASS: both sides, upper/lower overlap, distance, return-zone freshness inputs and invalid coordinates")
