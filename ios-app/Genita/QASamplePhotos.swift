import SwiftUI

/// Device QA test photos on V01 (11/4). QA drives a TestFlight iPhone over macOS iPhone Mirroring and must never
/// browse the owner's photo library, so a QA account gets "Use a test photo": five bundled, synthetic pictures
/// (the demo companion Jin, a dog, a clay figure, a 2D character, a hand drawing; from the photo-polish probe set).
/// Shown only when the server lists the account (`/me` `qaSamplePhotos`, env GENITA_QA_SAMPLE_PHOTOS) — never for
/// judges or users. A pick goes through the same `accept(_:)` as a library pick, so the V03 check / polish run for real.
enum QASamplePhotos {
    struct Sample: Identifiable, Equatable { let id: String; let title: String; var resource: String { "qa-sample-\(id)" } }
    static let samples: [Sample] = [
        .init(id: "human", title: "Person"), .init(id: "dog", title: "Dog"), .init(id: "clay", title: "Clay"),
        .init(id: "anime", title: "2D character"), .init(id: "drawing", title: "Drawing"),
    ]
    static let entryID = "qaSamplePhotoEntry"
    static func itemID(_ s: Sample) -> String { "qaSamplePhoto-\(s.id)" }

    @MainActor static func visible(for model: AppState) -> Bool {
        if model.qaSamplePhotos { return true }
        #if DEBUG
        // UI tests only (no server there): the shown state; the hidden state is the default
        if ProcessInfo.processInfo.environment["GENITA_QA_SAMPLE_PHOTOS"] == "1" { return true }
        #endif
        return false
    }

    static func data(_ s: Sample) -> Data? {
        guard let url = Bundle.main.url(forResource: s.resource, withExtension: "jpg") else { return nil }
        return try? Data(contentsOf: url)
    }
}

struct QASamplePhotoSheet: View {
    /// nil = the bundled file couldn't be read
    let pick: (Data?) -> Void
    private let columns = [GridItem(.flexible(), spacing: 12), GridItem(.flexible(), spacing: 12), GridItem(.flexible(), spacing: 12)]
    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("Test photos (QA)").font(TypeStyle.body(17, .semibold)).foregroundStyle(CallInk.ink)
            LazyVGrid(columns: columns, spacing: 12) {
                ForEach(QASamplePhotos.samples) { s in
                    Button { pick(QASamplePhotos.data(s)) } label: {
                        VStack(spacing: 6) {
                            Group {
                                if let d = QASamplePhotos.data(s), let ui = UIImage(data: d) { Image(uiImage: ui).resizable().scaledToFill() }
                                else { Color(white: 0.9) }
                            }.frame(height: 120).frame(maxWidth: .infinity).clipShape(RoundedRectangle(cornerRadius: 10))
                            Text(s.title).font(TypeStyle.body(13)).foregroundStyle(CallInk.ink)
                        }.contentShape(Rectangle())
                    }.buttonStyle(.plain).accessibilityLabel("Test photo: \(s.title)").accessibilityIdentifier(QASamplePhotos.itemID(s))
                }
            }
            Spacer(minLength: 0)
        }.padding(20).presentationDetents([.medium, .large]).background(Color.white)
    }
}
