import UIKit

struct PhoneDisplayGeometry {
    static var meters: (width:Double,height:Double)? {
        var info=utsname();uname(&info)
        let model=withUnsafePointer(to:&info.machine) { $0.withMemoryRebound(to:CChar.self,capacity:1) { String(cString:$0) } }
        // Manufacturer native display density, not CSS pixels or logical points.
        let ppi:[String:Double] = ["iPhone13,3":460,"iPhone13,4":458,"iPhone14,2":460,"iPhone14,3":458,"iPhone15,2":460,"iPhone15,3":460,"iPhone16,1":460,"iPhone16,2":460,"iPhone17,1":460,"iPhone17,2":460,"iPhone18,1":460,"iPhone18,2":460]
        guard let density=ppi[model] else{return nil}
        let bounds=UIScreen.main.nativeBounds
        return (min(bounds.width,bounds.height)/density*0.0254,max(bounds.width,bounds.height)/density*0.0254)
    }
}
