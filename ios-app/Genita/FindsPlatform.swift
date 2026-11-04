import SwiftUI
import WebKit
#if canImport(UIKit)
import UIKit
#else
import AppKit
#endif

/// JPEG/PNG bytes → SwiftUI Image (camera frames the app kept, fixture pictures).
enum PlatformImage {
    static func make(_ data: Data) -> Image? {
        #if canImport(UIKit)
        UIImage(data: data).map { Image(uiImage: $0) }
        #else
        NSImage(data: data).map { Image(nsImage: $0) }
        #endif
    }

    static func size(_ data: Data) -> CGSize? {
        #if canImport(UIKit)
        UIImage(data: data)?.size
        #else
        NSImage(data: data)?.size
        #endif
    }
}

/// r03 #8 in-app browser: the source page inside the sheet.
#if canImport(UIKit)
struct FindsBrowser: UIViewRepresentable {
    let url: URL?
    func makeUIView(context: Context) -> WKWebView {
        let view = WKWebView()
        view.overrideUserInterfaceStyle = .light // the window is dark over a full sheet (status bar); pages stay light
        view.backgroundColor = .clear
        if let url, ["http", "https"].contains(url.scheme) { view.load(URLRequest(url: url)) }
        return view
    }
    func updateUIView(_ view: WKWebView, context: Context) {}
}
#else
struct FindsBrowser: NSViewRepresentable {
    let url: URL?
    func makeNSView(context: Context) -> WKWebView {
        let view = WKWebView()
        if let url, ["http", "https"].contains(url.scheme) { view.load(URLRequest(url: url)) }
        return view
    }
    func updateNSView(_ view: WKWebView, context: Context) {}
}
#endif
