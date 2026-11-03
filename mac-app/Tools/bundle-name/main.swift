import Foundation

// MacBundleName checks (main.swift): the pure plan, then perform() on real fake bundles in a temp folder (moves, Trash, put-back).
var failures = 0
func expect(_ ok: Bool, _ what: String, line: Int = #line) {
    print((ok ? "ok   " : "FAIL ") + what)
    if !ok { failures += 1 }
}

let apps = URL(fileURLWithPath: "/Applications")
let legacy = apps.appendingPathComponent("GenitaMac.app")
let genita = apps.appendingPathComponent("Genita.app")
let id = "ai.thebeni.genita.mac"
func copy(_ url: URL, _ build: Int?, _ bid: String? = id) -> MacBundleName.AppCopy { .init(url: url, bundleID: bid, build: build) }
func plan(_ c: MacBundleName.AppCopy, writable: Bool = true, ro: Bool = false, sibling: MacBundleName.AppCopy? = nil, trusted: Bool = true, running: Bool = false) -> MacBundleName.Action {
    MacBundleName.plan(current: c, parentWritable: writable, readOnlyVolume: ro, sibling: sibling, siblingTrusted: trusted, siblingRunning: running)
}

// plan
expect(plan(copy(genita, 81)) == .none, "fresh install (Genita.app) does nothing")
expect(plan(copy(apps.appendingPathComponent("Genita 2.app"), 81)) == .none, "a name the user chose is left alone")
expect(plan(copy(legacy, 81)) == .rename(to: genita), "GenitaMac.app updated in place → rename to Genita.app")
expect(plan(copy(legacy, 81), writable: false) == .none, "parent not writable → leave it")
expect(plan(copy(legacy, 81), ro: true) == .none, "read-only volume (DMG) → leave it")
let transl = URL(fileURLWithPath: "/private/var/folders/x/AppTranslocation/ABC/d/GenitaMac.app")
expect(plan(copy(transl, 81)) == .none, "App Translocation → leave it")
expect(plan(copy(legacy, 81), sibling: copy(genita, 81)) == .openNewer(sibling: genita), "same build beside → open Genita.app, trash old")
expect(plan(copy(legacy, 81), sibling: copy(genita, 90)) == .openNewer(sibling: genita), "newer Genita.app beside → open it")
expect(plan(copy(legacy, 90), sibling: copy(genita, 81)) == .replaceOlder(sibling: genita), "older Genita.app beside → replace it")
expect(plan(copy(legacy, 81), sibling: copy(genita, 90, "other.app")) == .none, "different bundle id beside → leave both")
expect(plan(copy(legacy, 81), sibling: copy(genita, 81), running: true) == .yieldToRunning(sibling: genita), "trusted sibling running → hand over to it, quit (no 2nd Mac client)")
expect(plan(copy(legacy, 90), sibling: copy(genita, 81), running: true) == .yieldToRunning(sibling: genita), "older trusted sibling running → still hand over, trash nothing")
expect(plan(copy(legacy, 81), writable: false, sibling: copy(genita, 81), running: true) == .yieldToRunning(sibling: genita), "trusted sibling running, folder not writable → still hand over (no file moves)")
expect(plan(copy(legacy, 81), sibling: copy(genita, 90), trusted: false) == .none, "sibling not signed by us (same id, higher build) → never open or trash it")
expect(plan(copy(legacy, 90), sibling: copy(genita, 81), trusted: false, running: true) == .none, "untrusted running sibling → leave both")
expect(plan(copy(legacy, nil), sibling: copy(genita, 90)) == .none, "unknown build → leave both")

// perform, on disk
let fm = FileManager.default
let root = fm.temporaryDirectory.appendingPathComponent("bundle-name-\(UUID().uuidString)")
try! fm.createDirectory(at: root, withIntermediateDirectories: true)
defer { try? fm.removeItem(at: root) }
func fake(_ name: String, _ build: Int) -> URL {
    let u = root.appendingPathComponent(name)
    try! fm.createDirectory(at: u.appendingPathComponent("Contents"), withIntermediateDirectories: true)
    let plist: [String: Any] = ["CFBundleIdentifier": id, "CFBundleVersion": "\(build)"]
    try! PropertyListSerialization.data(fromPropertyList: plist, format: .xml, options: 0).write(to: u.appendingPathComponent("Contents/Info.plist"))
    return u
}
func build(_ u: URL) -> String? { (NSDictionary(contentsOf: u.appendingPathComponent("Contents/Info.plist")) as? [String: Any])?["CFBundleVersion"] as? String }
var opened: [String] = []
let ok: (URL) -> Bool = { opened.append($0.lastPathComponent); return true }
let fail: (URL) -> Bool = { opened.append($0.lastPathComponent); return false }
let bin = root.appendingPathComponent("Trash")
try! fm.createDirectory(at: bin, withIntermediateDirectories: true)
// a stand-in Trash inside the temp folder (the real one would collect fake bundles on every run)
let trash: (URL) -> Bool = { (try? fm.moveItem(at: $0, to: bin.appendingPathComponent(UUID().uuidString + "-" + $0.lastPathComponent))) != nil }
func trashed(_ name: String) -> Bool { ((try? fm.contentsOfDirectory(atPath: bin.path)) ?? []).contains { $0.hasSuffix("-" + name) } }

do { // rename
    let old = fake("GenitaMac.app", 81), new = root.appendingPathComponent("Genita.app"); opened = []
    let exit = MacBundleName.perform(.rename(to: new), current: old, trash: trash, open: ok)
    expect(exit && !fm.fileExists(atPath: old.path) && build(new) == "81" && opened == ["Genita.app"], "rename: moved, reopened Genita.app, exit")
    try? fm.removeItem(at: new)
}
do { // reopen fails → put back
    let old = fake("GenitaMac.app", 81), new = root.appendingPathComponent("Genita.app"); opened = []
    let exit = MacBundleName.perform(.rename(to: new), current: old, trash: trash, open: fail)
    expect(!exit && build(old) == "81" && !fm.fileExists(atPath: new.path), "rename: reopen failed → moved back, keep running")
    try? fm.removeItem(at: old)
}
do { // replace older sibling
    let old = fake("GenitaMac.app", 90), sib = fake("Genita.app", 81); opened = []
    let exit = MacBundleName.perform(.replaceOlder(sibling: sib), current: old, trash: trash, open: ok)
    expect(exit && build(sib) == "90" && !fm.fileExists(atPath: old.path) && trashed("Genita.app"), "replaceOlder: Genita.app is now build 90, old one trashed")
    try? fm.removeItem(at: sib)
}
do { // newer sibling
    let old = fake("GenitaMac.app", 81), sib = fake("Genita.app", 90); opened = []
    let exit = MacBundleName.perform(.openNewer(sibling: sib), current: old, trash: trash, open: ok)
    expect(exit && build(sib) == "90" && !fm.fileExists(atPath: old.path) && trashed("GenitaMac.app") && opened == ["Genita.app"], "openNewer: opened Genita.app 90, GenitaMac.app trashed")
    try? fm.removeItem(at: sib)
}
do { // newer sibling, open fails → nothing trashed
    let old = fake("GenitaMac.app", 81), sib = fake("Genita.app", 90); opened = []
    let exit = MacBundleName.perform(.openNewer(sibling: sib), current: old, trash: trash, open: fail)
    expect(!exit && build(old) == "81" && build(sib) == "90", "openNewer: open failed → both kept, keep running")
}
do { // target exists unexpectedly → move fails, no exit
    let old = fake("GenitaMac.app", 81), new = root.appendingPathComponent("Genita.app"); opened = []
    let exit = MacBundleName.perform(.rename(to: new), current: old, trash: trash, open: ok)
    expect(!exit && build(old) == "81" && opened.isEmpty, "rename onto an existing item → fails safely, nothing opened")
}

do { // yield: activate only, nothing moved
    let old = root.appendingPathComponent("GenitaMac.app"), sib = root.appendingPathComponent("Genita.app"); opened = []
    var activated = false
    let exit = MacBundleName.perform(.yieldToRunning(sibling: sib), current: old, trash: trash, activate: { _ in activated = true; return true }, open: ok)
    expect(exit && activated && build(old) == "81" && build(sib) == "90" && opened.isEmpty, "yieldToRunning: activated the running one, nothing moved")
    let stay = MacBundleName.perform(.yieldToRunning(sibling: sib), current: old, trash: trash, activate: { _ in false }, open: ok)
    expect(!stay, "yieldToRunning: activation failed → keep running")
}
// signature gate: an unsigned look-alike with our bundle id never counts as ours
expect(!MacBundleName.sameSigner(root.appendingPathComponent("Genita.app")), "sameSigner: unsigned fake Genita.app (same id) → false")

print(failures == 0 ? "bundle-name checks: all passed" : "bundle-name checks: \(failures) failed")
exit(failures == 0 ? 0 : 1)
