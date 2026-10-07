// SPDX-License-Identifier: Apache-2.0
// Offline WebKit host proof. Compile with the existing Command Line Tools, never installs anything.
import Cocoa
import WebKit
import ObjectiveC
let args = CommandLine.arguments
let html = try String(contentsOfFile: args[1], encoding: .utf8)
let csp = args[2], rules = args[3]
let app = NSApplication.shared
app.setActivationPolicy(.prohibited)
let bootstrap = "mock-preview://localhost/proof/index.html"
final class Scheme: NSObject, WKURLSchemeHandler {
    func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
        guard task.request.url?.absoluteString == bootstrap else { task.didFailWithError(NSError(domain:"denied",code:1)); return }
        task.didReceive(HTTPURLResponse(url: task.request.url!, statusCode:200, httpVersion:nil, headerFields:["Content-Type":"text/html; charset=utf-8", "Content-Security-Policy":csp,"X-DNS-Prefetch-Control":"off"])!)
        task.didReceive(html.data(using:.utf8)!); task.didFinish()
    }
    func webView(_ webView: WKWebView, stop task: WKURLSchemeTask) {}
}
final class Boundary: NSObject, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler {
    var initial = true
    var denied: [String] = []
    var result: [String:Any]?
    func webView(_ view: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy)->Void) {
        let url = action.request.url?.absoluteString ?? ""
        if url == "about:srcdoc" { decisionHandler(.allow); return }
        if initial && url == bootstrap { initial=false; decisionHandler(.allow); return }
        denied.append(url); decisionHandler(.cancel)
    }
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? { denied.append("popup"); return nil }
    func userContentController(_ c: WKUserContentController, didReceive message: WKScriptMessage) { result=message.body as? [String:Any] }
}
let config = WKWebViewConfiguration()
let preferences = config.preferences
let setter=NSSelectorFromString("_setPeerConnectionEnabled:"), getter=NSSelectorFromString("_peerConnectionEnabled")
guard preferences.responds(to:setter) && preferences.responds(to:getter) else { fatalError("WebRTC switch unavailable") }
let set=unsafeBitCast(preferences.method(for:setter),to:(@convention(c)(AnyObject,Selector,Bool)->Void).self)
let get=unsafeBitCast(preferences.method(for:getter),to:(@convention(c)(AnyObject,Selector)->Bool).self)
set(preferences,setter,false)
guard !get(preferences,getter) else { fatalError("WebRTC not denied") }
config.websiteDataStore = .nonPersistent()
let boundary=Boundary(), scheme=Scheme()
config.setURLSchemeHandler(scheme,forURLScheme:"mock-preview")
config.userContentController.add(boundary,name:"proof")
// Test-only transport, main frame only. Production has no proof handler and denies application IPC.
config.userContentController.addUserScript(WKUserScript(source:"window.addEventListener('message',e=>{if(e.data&&e.data.proof)window.webkit.messageHandlers.proof.postMessage(e.data.proof)})",injectionTime:.atDocumentStart,forMainFrameOnly:true))
var view:WKWebView?
var error:String?
WKContentRuleListStore.default().compileContentRuleList(forIdentifier:"one-connect-proof",encodedContentRuleList:rules) { list, e in
    guard let list=list else { error=String(describing:e); return }
    config.userContentController.add(list)
    view=WKWebView(frame:NSRect(x:0,y:0,width:390,height:844),configuration:config)
    view!.navigationDelegate=boundary; view!.uiDelegate=boundary
    view!.load(URLRequest(url:URL(string:bootstrap)!))
}
let deadline=Date().addingTimeInterval(15)
while boundary.result == nil && error == nil && Date()<deadline { RunLoop.current.run(until:Date().addingTimeInterval(0.05)) }
if let e=error { fatalError(e) }
guard var result=boundary.result else { fatalError("WebKit preview proof timed out") }
result["deniedNavigations"]=boundary.denied
let output=try JSONSerialization.data(withJSONObject:result,options:.sortedKeys)
print(String(data:output,encoding:.utf8)!)
