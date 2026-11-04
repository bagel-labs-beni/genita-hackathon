import AppKit
import WebKit

final class Probe:NSObject,WKNavigationDelegate,WKScriptMessageHandler {
 var painted=Set<String>()
 lazy var web:WKWebView = {
  let c=WKWebViewConfiguration();c.userContentController.add(self,name:"duoFrame")
  return WKWebView(frame:NSRect(x:0,y:0,width:390,height:844),configuration:c)
 }()
 func userContentController(_ userContentController:WKUserContentController,didReceive message:WKScriptMessage){if let id=message.body as? String{painted.insert(id)}}
 var window:NSWindow!
 var phase=0
 let stages:[(Double,Bool,Int)]=[(0,true,255),(0.4,true,255),(3.2,true,0),(0,false,0),(3.2,false,255)]
 func run(){
  window=NSWindow(contentRect:web.frame,styleMask:.borderless,backing:.buffered,defer:false);window.contentView=web;window.orderFront(nil)
  web.navigationDelegate=self
  let url=URL(fileURLWithPath:CommandLine.arguments[1]);web.loadFileURL(url,allowingReadAccessTo:url.deletingLastPathComponent())
 }
 func webView(_ webView:WKWebView,didFinish navigation:WKNavigation!){
 web.evaluateJavaScript("JSON.stringify({configure:typeof window.configure,errors:window.effectErrors})") {v,e in print(String(describing:v));self.step()}
 }
 func step(){
  guard phase<stages.count else{print("PASS: Duo WebGL payload is visible at source/arrival and transparent at exit");NSApp.terminate(nil);return}
  let stage=stages[phase]
  let data=try! Data(contentsOf:URL(fileURLWithPath:CommandLine.arguments[2]))
  let args=String(data:try! JSONSerialization.data(withJSONObject:[data.base64EncodedString(),Date().timeIntervalSince1970*1000-stage.0*1000,stage.1,false,"smoke-\(phase)"]),encoding:.utf8)!
  web.evaluateJavaScript("window.configure(...\(args))"){_,error in
   if let error {print("configure failed: \(error.localizedDescription)");exit(1)}
   DispatchQueue.main.asyncAfter(deadline:.now()+0.35){self.inspect(stage)}
  }
 }
 func inspect(_ stage:(Double,Bool,Int)){
  web.evaluateJavaScript("window.inspectEffect()") { value,error in
   guard self.painted.contains("smoke-\(self.phase)"), let d=value as? [String:Any],d["ready"] as? Bool==true,let alpha=d["alpha"] as? Int,d["error"] as? Int==0,stage.2==0 ? alpha==0 : alpha>20 else{print("FAIL stage \(self.phase): \(String(describing:value)) \(String(describing:error))");exit(1)}
   print("stage \(self.phase): \(d)");self.phase+=1;self.step()
  }
 }
}
let app=NSApplication.shared
let probe=Probe();probe.run();app.run()
