import Foundation

#if DEBUG
/// Screen review / UI tests (GENITA_REVIEW_STAGE=summary GENITA_REVIEW_VARIANT=insight | insight-empty): the SUM report
/// 춘식이 drew R1 with (QA account answers + the synthetic ChatGPT paste), in the server's JSON shape.
enum InsightFixture {
    static let json = #"""
    {"headline":"You want two good options, a laugh, and the final say.",
    "observations":[
     {"id":"fx-taste","category":"taste","claim":"Clean on the outside, loud on the plate.","evidence":[{"source":"answer","quote":"Minimal","source_label":"You picked"},{"source":"import","quote":"Korean food, the spicier the better.","source_label":"From the reply you pasted","highlight":"the spicier the better"}],"confidence":"high","score":0.9,"surprise":0.9,"use_in_call":"I'll keep outfits minimal and food spicy, never seafood.","chips":[{"label":"Minimal","polarity":"like"},{"label":"Spicy","polarity":"like"},{"label":"Seafood","polarity":"dislike"}],"verdict":null},
     {"id":"fx-think","category":"think","claim":"You decide by comparing, not by being told.","evidence":[{"source":"import","quote":"usually asks for two or three options before deciding.","source_label":"From the reply you pasted"}],"confidence":"high","score":0.9,"surprise":0.8,"use_in_call":"I'll give you two options and my pick.","verdict":"right"},
     {"id":"fx-humor","category":"humor","claim":"You keep it light, even about work.","evidence":[{"source":"import","quote":"ok but which one is cheaper lol","source_label":"From the reply you pasted"}],"confidence":"high","score":0.85,"surprise":0.7,"use_in_call":"I'll keep a joke ready, even on work stuff."},
     {"id":"fx-rhythm","category":"rhythm","claim":"You do your best thinking late.","evidence":[{"source":"import","quote":"Often works late at night.","source_label":"From the reply you pasted"}],"confidence":"medium","score":0.6,"surprise":0.5,"use_in_call":"I'll keep it short when it's late."}],
    "type":{"name":"The Playful Editor","line":"You pick from good options, keep it light, and keep the final say.","signature":["Options","Light","Final say"],"basis":["fx-think","fx-humor"]},
    "mix":[{"id":"options","left":"Options","right":"One answer","position":1,"evidence":{"source":"answer","quote":"Show me options","source_label":"You picked"}},{"id":"challenge","left":"Gentle","right":"Direct","position":2,"evidence":{"source":"answer","quote":"Balanced","source_label":"You picked"}}],
    "strengths":[{"text":"You know a good option when you see one.","basis":"fx-think"},{"text":"You keep things light without losing the plot.","basis":"fx-humor"},{"text":"Your taste is clear. Minimal, spicy, no seafood.","basis":"fx-taste"}],
    "watchouts":[{"text":"Three options can turn into thirty.","fix":"I'll cap it at two and say my pick.","basis":"fx-think"},{"text":"A joke can cover for being stuck.","fix":"If you go quiet, I'll drop the bit and help.","basis":"fx-humor"}],
    "chain":{"you_are":"You compare before you commit.","so_you":"So you want choices, not lectures.","so_ill":"So I'll bring two options and my pick."},
    "share":{"title":"{name} is The Playful Editor","lines":["Options","Light","Final say"]},
    "learning":[{"id":"l1","label":"How long you like answers"},{"id":"l2","label":"What you're into"},{"id":"l3","label":"Topics to skip"}],
    "usage":"In our calls: two options, my pick, a joke when it fits, and I ask before I act.",
    "settings":{"why":"Think with me","energy":"Calm","initiative":"Only when asked","never":"Message anyone for me"},
    "from":"answers"}
    """#
    /// `longName`: a type name too long for one line at 44 pt (R1 header fit check, Chelsea 11/4)
    /// `longerName`: past the 26 pt floor, the two-line fallback (designer re-check 11/4)
    static func report(empty: Bool, longName: Bool = false, longerName: Bool = false) -> InsightReport? {
        guard var r = try? JSONDecoder().decode(InsightReport.self, from: Data(json.utf8)) else { return nil }
        // TF 331's exact title (it split into "The Quick / Dry / Decider.")
        if longName { r.type?.name = "The Quick Dry Decider"; r.share?.title = "{name} is The Quick Dry Decider" }
        if longerName { r.type?.name = "The Quick Dry Side-by-Side Decider"; r.share?.title = "{name} is The Quick Dry Side-by-Side Decider" }
        if empty { r.observations = []; r.type = nil; r.share = nil; r.strengths = []; r.watchouts = []; r.chain = nil; r.mix = []; r.headline = "You gave me a good start." }
        return r
    }
}
#endif
