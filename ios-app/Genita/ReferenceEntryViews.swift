import SwiftUI

struct ReferenceWelcomeView: View {
    var action: () -> Void
    var referenceViewport = false
    var body: some View {
        GeometryReader { safe in
            GeometryReader { full in
                let size = referenceViewport ? CGSize(width: 390, height: 844) : full.size
                let shift = (size.height - 844) / 2
                Button(action: action) {
                    ZStack(alignment: .topLeading) {
                        Color("Canvas")
                        Image(resource: "brandmark").resizable().frame(width: 152, height: 70.9945).rotationEffect(.degrees(-14.05)).position(x: 193.3445 + (size.width - 390) / 2, y: 368.8885 + shift)
                        let label = DesignLibrary.nodes("welcome").first { $0.type == "text" }!
                        DesignText(node: label).designSlot(label, width: size.width, top: shift)
                    }.frame(width: size.width, height: size.height)
                }.buttonStyle(.plain).accessibilityLabel("Get started").accessibilityIdentifier("getStarted")
            }.ignoresSafeArea(.container)
        }
    }
}
struct ReferenceSignInView: View {
    @Bindable var model: AppState
    @State private var provider: String?
    @State private var legal: String?
    var referenceViewport = false
    var nodes: [DesignNode] { DesignLibrary.nodes("signIn") }
    var body: some View {
        GeometryReader { safe in
            GeometryReader { full in
                let size = referenceViewport ? CGSize(width: 390, height: 844) : full.size
                let top = referenceViewport ? 0 : safe.safeAreaInsets.top - 44
                let bottom = size.height - 844
                ZStack(alignment: .topLeading) {
                    Image(resource: "signin").resizable().frame(width: 757, height: 1009)
                        .offset(x: -172 + (size.width - 390) / 2, y: -168 + top)
                        .frame(width: size.width, height: size.height, alignment: .topLeading).clipped()
                    Image(resource: "logo").resizable().frame(width: 63.142, height: 22.626).position(x: 66.571, y: 78.823 + top)
                    ForEach(nodes.filter { $0.type == "text" && ($0.fontFamily == "KMU80 TTF" || $0.y == 199) }) { n in
                        DesignText(node: n).designSlot(n, width: size.width, top: top)
                    }
                    providerButton("Apple", width: size.width).frame(width: size.width - 77, height: 50).position(x: (size.width - 1) / 2, y: 598 + bottom)
                    providerButton("Google", width: size.width).frame(width: size.width - 77, height: 50).position(x: (size.width - 1) / 2, y: 659 + bottom)
                    let node = nodes.first { $0.y == 734 && $0.type == "text" }!
                    DesignText(node: node).frame(width: node.w, height: node.h).position(x: size.width / 2, y: 751 + bottom)
                    Button { legal = "Terms" } label: { Color.clear.contentShape(Rectangle()) }.frame(width: 44, height: 24).position(x: size.width / 2 + 85, y: 743 + bottom).accessibilityLabel("Terms")
                    Button { legal = "Privacy Policy" } label: { Color.clear.contentShape(Rectangle()) }.frame(width: 85, height: 24).position(x: size.width / 2 + 54, y: 761 + bottom).accessibilityLabel("Privacy Policy")
                }.frame(width: size.width, height: size.height).clipped()
            }.ignoresSafeArea(.container)
        }.preferredColorScheme(.dark)
        .alert("\(provider ?? "") sign-in", isPresented: Binding(get: { provider != nil }, set: { if !$0 { provider = nil } })) {
            Button("Continue in demo") { model.signedIn(); provider = nil }
            Button("Cancel", role: .cancel) { provider = nil }
        } message: { Text("Account sign-in is not connected yet. You can explore setup locally on this iPhone.") }
        .alert(legal ?? "", isPresented: Binding(get: { legal != nil }, set: { if !$0 { legal = nil } })) { Button("OK") { legal = nil } } message: { Text("Release documents are not connected in this local demo. No account is created.") }
    }
    func providerButton(_ name: String, width: CGFloat) -> some View {
        let label = nodes.first { $0.characters == "Continue with " + name }!
        return Button { provider = name } label: {
            ZStack {
                RoundedRectangle(cornerRadius: 12).fill(.white).overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(Color(white: 0.9373), lineWidth: 2))
                Image(resource: name.lowercased()).resizable().frame(width: 20, height: name == "Apple" ? 22 : 20).position(x: name == "Apple" ? 76 : 70, y: name == "Apple" ? 23 : 24)
                DesignText(node: label).frame(width: label.w, height: label.h).position(x: (width - 390) / 2 + label.x - 38 + label.w / 2, y: name == "Apple" ? 24 : 24)
            }
        }.buttonStyle(.plain).accessibilityLabel("Continue with " + name)
    }
}
