import SwiftUI
import WebKit

struct TransitionPayload {
    let id: String
    let image: String
    let start: Double
    let outgoing: Bool
    let reverse: Bool
}

final class DuoWebCoordinator: NSObject, WKNavigationDelegate, WKScriptMessageHandler {
    var onReady: ((String)->Void)?
    var loaded = false
    var payload: TransitionPayload?
    var configured: String?
    func configure(_ web: WKWebView) {
        guard loaded, let p = payload, configured != p.id else { return }
        configured = p.id
        guard let args = try? JSONSerialization.data(withJSONObject: [p.image, p.start * 1000, p.outgoing, p.reverse, p.id]), let json = String(data: args, encoding: .utf8) else { return }
        web.evaluateJavaScript("window.configure(...\(json))", completionHandler: nil)
    }
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.name == "duoFrame", let id=message.body as? String, id==payload?.id else{return}
        onReady?(id)
    }
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { loaded = true; configure(webView) }
}
private func makeDuoWeb(_ coordinator: DuoWebCoordinator) -> WKWebView {
    let config=WKWebViewConfiguration();config.userContentController.add(coordinator,name:"duoFrame")
    let web = WKWebView(frame:.zero,configuration:config); web.navigationDelegate = coordinator
    #if os(macOS)
    web.setValue(false, forKey: "drawsBackground")
    #else
    web.isOpaque = false; web.backgroundColor = .clear; web.scrollView.isScrollEnabled = false
    #endif
    if let url = Bundle.main.url(forResource: "handoff-effect", withExtension: "html") { web.loadFileURL(url, allowingReadAccessTo: url.deletingLastPathComponent()) }
    return web
}
#if os(macOS)
struct DuoTransition: NSViewRepresentable {
    let payload: TransitionPayload
    var onReady: ((String)->Void)? = nil
    func makeCoordinator() -> DuoWebCoordinator { DuoWebCoordinator() }
    func makeNSView(context: Context) -> WKWebView { context.coordinator.onReady = onReady; context.coordinator.payload = payload; return makeDuoWeb(context.coordinator) }
    func updateNSView(_ web: WKWebView, context: Context) { context.coordinator.onReady = onReady; context.coordinator.payload = payload; context.coordinator.configure(web) }
}
#else
struct DuoTransition: UIViewRepresentable {
    let payload: TransitionPayload
    var onReady: ((String)->Void)? = nil
    func makeCoordinator() -> DuoWebCoordinator { DuoWebCoordinator() }
    func makeUIView(context: Context) -> WKWebView { context.coordinator.onReady = onReady; context.coordinator.payload = payload; return makeDuoWeb(context.coordinator) }
    func updateUIView(_ web: WKWebView, context: Context) { context.coordinator.onReady = onReady; context.coordinator.payload = payload; context.coordinator.configure(web) }
}
#endif
