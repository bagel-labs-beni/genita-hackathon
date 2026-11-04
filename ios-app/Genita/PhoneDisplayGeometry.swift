import UIKit

struct PhoneDisplayGeometry {
    /// Manufacturer native display density, not CSS pixels or logical points. Every iPhone with A12 or
    /// later (PRD 19: touch to move is not Pro-only). Models newer than this table assume 460 ppi.
    static let ppi: [String: Double] = [
        "iPhone11,2": 458, "iPhone11,4": 458, "iPhone11,6": 458, "iPhone11,8": 326,                     // XS, XS Max, XR
        "iPhone12,1": 326, "iPhone12,3": 458, "iPhone12,5": 458, "iPhone12,8": 326,                     // 11, 11 Pro, 11 Pro Max, SE 2
        "iPhone13,1": 476, "iPhone13,2": 460, "iPhone13,3": 460, "iPhone13,4": 458,                     // 12 mini, 12, 12 Pro, 12 Pro Max
        "iPhone14,4": 476, "iPhone14,5": 460, "iPhone14,2": 460, "iPhone14,3": 458, "iPhone14,6": 326,  // 13 mini, 13, 13 Pro, 13 Pro Max, SE 3
        "iPhone14,7": 460, "iPhone14,8": 458, "iPhone15,2": 460, "iPhone15,3": 460,                     // 14, 14 Plus, 14 Pro, 14 Pro Max
        "iPhone15,4": 460, "iPhone15,5": 460, "iPhone16,1": 460, "iPhone16,2": 460,                     // 15, 15 Plus, 15 Pro, 15 Pro Max
        "iPhone17,1": 460, "iPhone17,2": 460, "iPhone17,3": 460, "iPhone17,4": 460, "iPhone17,5": 460,  // 16 Pro, 16 Pro Max, 16, 16 Plus, 16e
        "iPhone18,1": 460, "iPhone18,2": 460, "iPhone18,3": 460, "iPhone18,4": 460,                     // 17 Pro, 17 Pro Max, 17, Air
    ]
    static var model: String {
        var info=utsname();uname(&info)
        return withUnsafePointer(to:&info.machine) { $0.withMemoryRebound(to:CChar.self,capacity:1) { String(cString:$0) } }
    }
    static var meters: (width:Double,height:Double)? { meters(model: model, nativeBounds: UIScreen.main.nativeBounds) }
    static func meters(model: String, nativeBounds bounds: CGRect) -> (width:Double,height:Double)? {
        guard model.hasPrefix("iPhone") else { return nil }
        // Older than A12 (iPhone10,x and below) cannot run the image tracking this needs.
        let major = Int(model.dropFirst(6).split(separator: ",").first ?? "") ?? 0
        guard major >= 11 else { return nil }
        let density = ppi[model] ?? 460
        return (min(bounds.width,bounds.height)/density*0.0254,max(bounds.width,bounds.height)/density*0.0254)
    }
}
