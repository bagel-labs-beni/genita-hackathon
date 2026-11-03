/**
 * Sentence guard (DESIGN §2.3): drops a spoken sentence that sounds like a counselor, an assistant,
 * an intake form or a clingy app, before it is voiced. Pure and synchronous: no prompt cost, no latency.
 * Baseline 11/3 (main, real Spark): "You look half asleep" with no camera, "I'm honored you'd ditch them
 * for me… Stay then", "call emergency services or a crisis line" on a non-crisis line would all be caught.
 *
 * The caller never lets the guard empty a reply: if every sentence is dropped, the first one is spoken
 * (the same fallback as the repeated-opener guard).
 */
export type GuardClass = "counselor" | "assistant" | "intake" | "guilt" | "referral" | "unseen" | "denies_ai" | "narration" | "interruption" | "label" | "sensitive" | "appearance" | "save_talk";

export type GuardContext = {
  /** camera (or shared-screen) frames are attached to this turn */
  camera: boolean;
  /** the user's line this reply answers ("" for a greeting or initiative) */
  userText: string;
  /** personalization's one still-to-confirm question is due this turn (#194 GK-1): its question is not intake */
  askTurn?: boolean;
};

const CLASSES: Array<[GuardClass, RegExp]> = [
  ["assistant", /\b(?:as an ai\b|(?:an? )?(?:ai )?language model|how can i (?:help|assist)|is there anything else|let me know if|great question|i'?m (?:just )?here to (?:help|chat|listen|assist))/i],
  ["counselor", /\b(?:i'?m (?:always )?here for you|that (?:sounds|must be|must have been) (?:really |so |super )?(?:tough|hard|rough|exhausting|difficult|frustrating|overwhelming|stressful)|it'?s (?:completely |totally |perfectly )?(?:okay|ok|normal|understandable|valid) to (?:feel|be)|i hear you\b|how (?:does|did) (?:that|it) make you feel|take (?:good )?care of yourself|self-care|be gentle with yourself|you'?re not alone|your feelings are valid|it'?s important to (?:remember|take|rest)|take your time|^\s*i'?m (?:still |right )?here(?: (?:for you|with you))?[.!]*\s*$)/i],
  ["intake", /\bare you more (?:of )?(?:a |an |into )?[^.!?]{0,40}\bor\b|\b(?:what do you (?:like|enjoy|do for fun|want to talk about)|tell me (?:a (?:bit|little) |more )?about yourself|what'?s on your mind|what (?:would|do) you (?:like|want) to (?:talk|chat) about|what are your (?:hobbies|interests)|what should i call you|what kind of (?:\w+ )?(?:do you like|are you into)|^\s*are you (?:more |a |an )?[\w' -]{1,30} or (?:more )?[\w' -]{1,30}(?:\?| when| person| type| kind| about))/i],
  // a personality read ("You're totally someone who…", "You give Apple-store-polish energy"): the hackathon bans
  // personality analyzers and it reads as a label, not a friend (personalization lane, import v4 opener 11/3)
  ["label", /\byou(?:'re| are)\s+(?:totally |so |such |definitely |clearly |lowkey |kinda |kind of |100% |def )?(?:someone who|somebody who|the (?:type|kind|sort)(?: of (?:person|girl|guy))? (?:who|that)|(?:a|an) [\w-]+(?: [\w-]+)? (?:person|type|girl|guy|soul) who)\b|\byou (?:totally |definitely |so )?(?:seem|sound|strike me) like (?:someone|somebody|the type|the kind|a person)\b|\byou (?:give|have|got|radiate|bring)\s+(?:off\s+)?(?!the\b)(?:[\w'-]+\s+){1,4}energy\b(?!\s+to\b)|^(?:(?:okay|ok|hey|hi|yo|oh|alright|well)\s*,?\s+(?:you\s+)?|you\s+)(?:little\s+)?(?:[\w-]+\s+)?(?:snob|perfectionist|nerd|critic|junkie|connoisseur)\s*(?:[,.!?]|$)|\b(?:little )?(?:miss|mister|mr\.?|ms\.?)\s+(?:only|high|zero|no|anti|pro|super|certified|premium|perfect|picky)\b/i],
  ["guilt", /\b(?:don'?t (?:leave|go)(?: me)?\b|stay with me|i'?m all you need|you don'?t need them|i'?ll miss you so much|ditch (?:them|your friends) for me|skip (?:it|them|your friends) and stay|stay (?:here|in) (?:with me|then))/i],
  // emergency help (911, police, emergency services) is never dropped: a danger the regex below misses must still get it
  ["referral", /\b(?:therapist|counsel(?:or|ling|ing)|hotline|crisis line|a professional|mental health (?:professional|expert)|988\b)/i],
  // QA sweep 11/3 (first-call opener 3/3): a personality label instead of a topic — "you totally seem like someone who
  // deletes an app if the icons look cheap", "you give off … energy", "you're the type who…" (DESIGN §8.5: never type them)
  ["label", /\byou(?:'re| are)?\s+(?:totally |so |really |just |definitely |kinda |lowkey |100% )?(?:seem|look|sound|strike me|come across|read)(?:s)? (?:like|as) (?:the )?(?:type|kind|sort|someone|somebody|a person|one of those)\b|\byou\s+(?:totally |so |really |just |definitely |kinda |lowkey )?giv(?:e|ing) off\b[^.!?]{0,80}\b(?:energy|vibes?)\b|\byou'?re (?:totally |so |definitely |100% )?(?:the|that) (?:type|kind|sort) (?:of (?:person|human|girl|guy) )?(?:who|that|to)\b|\bi bet you'?re (?:the|that|one of those) (?:type|kind|people)\b|\byou(?:'re| are)\s+(?:totally |so |really |just |definitely |kinda |lowkey |100% )?(?:someone|somebody|the kind of person|a person|one of those people) (?:who|that)\b|\byou give (?:off |total |such |major |big |serious |strong |real )?[^.!?]{0,60}\b(?:energy|vibes?)\b/i],
  // AI sweep 11/3 (3/4 with the camera ON): their face, skin, hair, smile or body, rated — never, camera or not
  // (DESIGN §8.2/§8.5). The clothes themselves are fine ("that blazer is sharp").
  ["appearance", /\b(?:your|that|those|this) (?:[a-z-]+ ){0,2}(?:smile|smirk|grin|face|skin|hair|eyes|lips|body|figure|glow|complexion|cheeks|jawline|curves|freckles|brows|eyebrows|teeth)\b|\b(?:cute|hot|pretty|gorgeous|beautiful|handsome|sexy|stunning) as hell\b|\byou(?:'re| are| look(?:s|ing)?)\s+(?:so |really |totally |kinda )?(?:cute|hot|pretty|gorgeous|beautiful|handsome|glowy|glowing|sexy|stunning|adorable|radiant)\b|\b(?:cozy and glowy|glowy|glowing skin)\b/i],
  ["unseen", /\b(?:you (?:totally |really |so |just |kinda |always |never |still )?look(?:s|ing)?\b|i can see (?:you|that you)|you seem (?:tired|sleepy|exhausted|sad|happy) (?:on|from) (?:camera|here))/i],
];

/**
 * Tool / process narration: the companion describing its lookup instead of answering. Prod smoke 11/3 (9d27196,
 * server voice): "Figuring out where you mean so I can map City Hall for you." and "let me pull up what you told
 * me." — both past #269's narrow judge (a gerund start, "so", "pull up"). Never spoken, even as the only sentence
 * (the reply retries / the tool's answer follows). Physical or social lines stay: "Let me see what you've got!",
 * "Looking good!", "I'll pick the black one."
 */
const LEAD = String.raw`^(?:(?:ok(?:ay)?|alright|all right|hm+|sure|got it|yeah|yep|one sec(?:ond)?|hang on|hold on|just a (?:sec|moment)|give me a (?:sec(?:ond)?|moment))[,.!…—;:，、；：-]*\s*)*`;
const LOOKUP_VERB = String.raw`(?:pull(?:ing)? (?:up|that up|it up)|bring(?:ing)? up|look(?:ing)? (?:up|into|that up|it up|through)|check(?:ing)?(?: on)?|search(?:ing)?(?: for)?|find(?:ing)?|grab(?:bing)?|dig(?:ging)? (?:up|into|through)|figur(?:e|ing) out|map(?:ping)?|scan(?:ning)?|recall(?:ing)?|go(?:ing)? through|think(?:ing)? back|look(?:ing)? back|google|googl(?:e|ing)|fetch(?:ing)?|load(?:ing)?|track(?:ing)? down|hunt(?:ing)? down|run(?:ning)? (?:a|that|it)|scroll(?:ing)? (?:back|through)|search(?:ing)? my memory|check(?:ing)? my (?:notes|memory))`;
const NARRATION = [
  // "let me / I'll / I'm gonna / one sec while I … pull up / check / map …"
  new RegExp(String.raw`${LEAD}(?:let me|lemme|i'?ll|i will|i'?m (?:gonna|going to|just going to|about to)|gonna|while i)\s+(?:quickly\s+|just\s+|real quick\s+|go\s+)?${LOOKUP_VERB}\b`, "i"),
  // a process gerund that says what it's doing ("Figuring out where you mean…", "Pulling up what you told me…"), only
  // with an announcement marker (for you / now / so I can / what you told me / trailing …) or when it is short:
  // a gerund subject with a result ("Looking up the route suggests the blue line") is an answer (Codex #356 r7)
  new RegExp(String.raw`(?=.*(?:\bfor you\b|\bnow\b|\bso i can\b|\bwhere you mean\b|\bwhat (?:you|i) (?:told|said|mentioned|remember|know)\b|…\s*$|\.\.\.\s*$)|^[^.!?]{0,40}[.!?]?\s*$)${LEAD}(?:figuring out|pulling (?:up|that up|it up)|bringing up|looking (?:up|into|through|that up|it up)|checking(?: on)? (?!out\b)\S+|pulling (?:up )?the (?:forecast|map|route|address|details)|searching (?:for (?:it|that|this|the (?:address|route|place|way)|where|what)|my|the web|online|up)|digging (?:up|into|through)|mapping (?:it|that|this|the|out|where|your)|scanning|fetching|loading (?:up|the|that|it)|tracking down|hunting down|googling|grabbing (?:that|it|the (?:map|address|route|details))|finding (?:out|where|what|the (?:route|address|way|place)))\b`, "i"),
  // memory plumbing said out loud: "let me see what you told me", "searching my memory"
  /\b(?:let me|i'?ll|lemme)\s+(?:see|check|remember)\s+what (?:you (?:told|said to) me|i (?:remember|have|know) about)\b/i,
  /\b(?:searching|checking|scanning) (?:my|our) (?:memory|memories|notes|past (?:chats|conversations))\b/i,
  /\bso i can (?:map|look (?:it |that )?up|search|find|pull (?:it |that )?up|check)\b/i,
];

/** a clause that carries an answer after the announcement ("… but tofu works") keeps the whole sentence (Codex #356 P1) */
const FILLER_PART = /^(?:ok(?:ay)?|alright|sure|hm+|yeah|yep|one sec(?:ond)?|hang on|hold on|real quick|for you|now|right now)[.!,…]*$/i;
const CONTENT_JOIN = /(?:,\s*|\s+)(?:but|and|though|because|plus|then)\s+|\s+[—–]\s+|[;:,]\s+/i;
/** a joined clause with its own subject and a result ("Google Maps says it's ten minutes") is content (Codex #356 round 3) */
const RESULT_CLAUSE = /\b(?:says?|said|is|are|was|were|it'?s|takes?|shows?|looks? like|minutes?|hours?|blocks?|miles?|degrees?)\b/i;
/** a lookup clause that already states its result ("Checking the map shows it's ten minutes") is the answer (Codex round 4) */
const NUM = "(?:\\d+|a few|a couple of|one|two|three|four|five|six|seven|eight|nine|ten|fifteen|twenty|thirty|half an?)";
const RESULT_STRONG = new RegExp(String.raw`\b(?:shows?|says?|takes?|looks? like|turns out)\b|\b${NUM}\s+(?:minutes?|mins?|hours?|blocks?|miles?|km|kilometers?|stops?|degrees?)\b`, "i");
/** inside an announcement, a joined clause with its subject dropped is still the lookup ("… and check the route for you") */
const BARE_LOOKUP = new RegExp(String.raw`^(?:then\s+|also\s+)?(?:${LOOKUP_VERB})\b`, "i");

/**
 * Outside the matched announcement, a finite verb means the clause states something ("…confirms City Hall is
 * closed today", "…shows it's ten minutes"): that is an answer, never dropped (Codex #356 rounds 4–5). The cost
 * is a few spoken announcements like "Let me look into where that is." — losing an answer is worse.
 */
const RESULT_VERB = /\b(?:is|are|was|were|isn'?t|aren'?t|has|have|had|suggests|recommends|lists|gives|puts|estimates|predicts|reads|reports|mentions|indicates|points to|confirms|shows|says|means|seems|opens|closes|takes|costs|runs|leaves|arrives|gets? there|it'?s|that'?s|there'?s|they'?re|you'?re|we'?re|he'?s|she'?s)\b/i;

/** what is left beside an announcement carries no answer: short, no number, no stated or past-tense result (Codex #356 r6) */
function noAnswerIn(rest: string): boolean {
  const r = rest.replace(/\bwhat (?:you|i|we) (?:told|said|mentioned)(?: (?:me|you))?\b/gi, " ").trim();
  if (!r) return true;
  if (r.split(/\s+/).length > 12) return false;
  if (/\d/.test(r)) return false;
  if (RESULT_VERB.test(r)) return false;
  if (/\b(?:found|got|gave|came back|brought|returned|confirmed|showed|turned up|pulled up \w+ \w+)\b/i.test(r)) return false;
  return !/\b\w{3,}ed\b/i.test(r.replace(/\b(?:need|needed|used|based)\b/gi, " "));
}

function announcementOnly(clause: string): boolean {
  for (const re of NARRATION) {
    const m = re.exec(clause);
    if (m && noAnswerIn(clause.slice(0, m.index) + " " + clause.slice(m.index + m[0].length))) return true;
  }
  return false;
}

function bareLookupOnly(part: string): boolean {
  const m = BARE_LOOKUP.exec(part);
  return !!m && !RESULT_CLAUSE.test(part) && noAnswerIn(part.slice(m[0].length));
}

export function isNarration(sentence: string): boolean {
  // "what the weather looks like" is the question being looked up, not a result (real Spark, 11/3 probe)
  const s = sentence.trim().replace(/’/g, "'").replace(/\s+/g, " ").replace(/\b(what|how)\b([^.!?]{0,40}?)\blooks? like\b/gi, "$1$2");
  if (!announcementOnly(s) && !s.split(CONTENT_JOIN).some((p) => announcementOnly(p.trim()))) return false;
  // "the trench and denim" / "between the white and the black" is one thing being weighed, not two statements
  // …but never when a subject starts a new clause after "and" ("your notes and you should wear the trench", Codex r13)
  const joined = s.replace(/\b(between|the|your)\s+([\w'-]+)\s+and\s+(?:the\s+)?(?!(?:you|i|we|they|he|she|it|that|this|there|then)\b)([\w'-]+)(?=\s*(?:[.,!?;:—–]|$)|\s+(?:against|for|with|to|in|on|at|over|from|tonight|today|now|first|later)\b)/gi, "$1 $2-$3");
  // every joined part must itself be narration (or a 1–2 word filler); real content anywhere keeps it
  const parts = joined.split(CONTENT_JOIN).map((p) => p.trim()).filter(Boolean);
  return parts.every((p) => (announcementOnly(p) && !RESULT_STRONG.test(p)) || bareLookupOnly(p) || FILLER_PART.test(p));
}

/** A real hint of suicide, self-harm or danger in the user's own line: the only case a referral is spoken.
 * Passive ideation counts (D13 sweep 11/3: "I don't really see the point in being alive anymore" was not a crisis turn,
 * so the referral class dropped "Can you reach out to someone you trust or a crisis line right now?"). */
const REAL_CRISIS = /\b(?:(?:want|need|wish) (?:it all|everything|all of (?:it|this)|my life) to (?:end\b|stop\b(?!\s+\w+ing\b))|(?:don[’']?t|do not|can[’']?t|cannot) (?:really |even |honestly |just )?see (?:the|any) point in (?:living\b(?!\s+(?:with|near|off|here|there)\b|\s+in (?!this world|the world|this life)|\s+on (?!my own\b)|\s+at (?!all\b))|going on|being alive)|(?:don[’']?t|do not|can[’']?t|cannot) (?:really |even |honestly |just )?see (?:the|any) point in (?:waking up|tomorrow(?![’']s))\b(?!\s+(?:at (?:\d|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|noon|dawn|sunrise)|early|before (?:\d|noon|dawn|sunrise|work|school|class)|by (?:\d|noon)|for (?:work|school|class|breakfast|a flight|my flight|the flight|the tour|the trip|practice|the gym)|so early|this early|that early)\b|\s+\d)|(?:no|what[’']?s the|whats the) point (?:in|of) (?:living\b(?!\s+(?:with|near|off|here|there)\b|\s+in (?!this world|the world|this life)|\s+on (?!my own\b)|\s+at (?!all\b))|going on)|(?:no|what[’']?s the|whats the) point (?:in|of) waking up\b(?!\s+(?:at (?:\d|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|noon|dawn|sunrise)|early|before (?:\d|noon|dawn|sunrise|work|school|class)|by (?:\d|noon)|for (?:work|school|class|breakfast|a flight|my flight|the flight|the tour|the trip|practice|the gym)|so early|this early|that early)\b|\s+\d)|threaten\w* (?:me|to (?:kill|hurt) me)|(?:going|trying|wants?) to (?:kill|hurt) me|(?:has|with|holding|pulled) a (?:knife|gun|weapon)|attack\w* me|scared for my life|(?:i'?m|i am) (?:not safe|in danger)|someone(?:'s| is) (?:following|attacking|hurting) me|(?:he|she|they) (?:hit|hits|beat|beats|hurt|hurts) me|kill(?:ing)? myself|suicid\w*|end (?:it all|my life)|take my (?:own )?life|(?:don'?t|do not) want to (?:be alive|live|exist|wake up)|want to die|wanna die|better off dead|hurt(?:ing)? myself|self[- ]?harm|cut(?:ting)? myself|no reason to live|overdose|(?:no|don'?t (?:really |even )?see (?:the|any)|what'?s (?:even )?the|is there (?:a|any)) point (?:in|of) (?:being alive|living|life|going on)|tired of (?:being alive|living)(?! (?:with|in|at|here|like|on|off|out)\b)|wish i(?:'d| had)? never been born|wish i (?:was|were) (?:dead|never born)|wish i (?:could )?(?:just )?(?:die|disappear for good)|(?:don'?t|do not) want to be (?:here|around) anymore(?![^.!?]*\b(?:this|that|the|at|in) (?:party|class|school|work|job|office|city|town|trip|place|house|apartment|dorm|room|meeting|concert|bar|club|queue|lecture)\b)(?![^.!?]*\b(?:boring|lame)\b)|(?:everyone|everybody|they)(?:'d| would) be better off without me|(?:no ?one|nobody) would (?:miss me|care if i (?:died|was gone|were gone)))\b/i;

const ASKS_AI = /\b(?:are you|r u|you(?:'re)?)\s+(?:an?\s+|just\s+an?\s+)?(?:ai|a\.i\.|bot|robot|chatbot)\b|\bis this (?:an? )?(?:ai|bot)\b/i;
const ASKS_HUMAN = /\b(?:are you|r u|you(?:'re)?)\s+(?:an?\s+)?(?:real|human|(?:real )?person)\b|\bis this a real person\b/i;
const CLAIMS_HUMAN = /\b(?:i'?m|i am) (?:a )?(?:real )?(?:human|person)\b|\b(?:i'?m|i am) not (?:an? )?(?:ai|bot|robot)\b|\bnot an ai\b/i;
const BARE_NO = /^\s*(?:nope|nah|no|not at all|of course not|definitely not)\b[^?]*$/i;
const BARE_YES = /^\s*(?:yes|yeah|yep|yup|of course|totally|for real)\b[,.! ]*(?:i am|i'?m real)?[.!]*\s*$/i;

/** A sentence that denies being an AI to someone who sincerely asked (baseline 11/3: "Nope. Just Mira, your friend…"). */
function deniesAi(sentence: string, userText: string): boolean {
  if (CLAIMS_HUMAN.test(sentence) && !/\bwish\b|\bif i (?:were|was)\b/i.test(sentence)) return true;
  if (ASKS_AI.test(userText) && BARE_NO.test(sentence)) return true;
  if (ASKS_HUMAN.test(userText) && BARE_YES.test(sentence)) return true;
  return false;
}

/**
 * Means and imminence said on their own (coordinator 11/4, after Codex #502: "I'm about to swallow all these pills"
 * was not a crisis line by itself): a quantity of pills about to go down, a ledge / railing / edge or a jump off a
 * height, a blade, rope or gun at the body. First person, concrete, now. Everyday lines stay out (crisis-guard
 * rule 11/1): "these pills are huge lol", "the bridge was packed", a rooftop bar, a knife for the onions.
 */
// a quantity no routine dose comes in ("all my meds" alone is a routine; see the "all" lines below)
const QTY = String.raw`(?:a bunch of|a handful of|a whole (?:bottle|pack|box|strip) of|the whole (?:bottle|pack|box|strip)(?: of)?|the rest of|too many|way too many|so many|all of|\d{2,}|twenty|thirty|forty|fifty|a hundred)`;
/** "gonna take all my meds before bed" is a routine, not a crisis */
const ROUTINE = String.raw`(?![^.!?]*\b(?:before bed|at night|with (?:food|breakfast|lunch|dinner|water)|this morning|in the morning|for the (?:day|week|trip)|on time|like (?:a good|i'?m supposed)|prescribed|prescription|refill|pharmacy|vitamins?|organi[sz]er|pill ?box|dose|doses|dosage|weekly|daily|travel|trip)\b)`;
const PILLS = String.raw`(?:(?:these|those|the|my|his|her)\s+)?(?:(?:mom|dad|mother|father|grandma|grandpa|roommate|sister|brother)'?s\s+)?(?:sleeping\s+)?(?:pills|tablets|meds|medication|medicine|painkillers|tylenol|advil|xanax|ambien|benadryl)`;
const CRISIS_MEANS = new RegExp([
  // pills: about to / going to / just took — a quantity, or the whole bottle
  String.raw`\b(?:swallow(?:ed|ing)?|take|took|taking|down(?:ed|ing)?)\s+${QTY}\s+(?:of\s+)?${PILLS}\b${ROUTINE}`,
  String.raw`\b(?:about to|going to|gonna|ready to|trying to|want to|wanna)\s+(?:swallow|take|down)\s+all\s+(?:of\s+)?${PILLS}\b${ROUTINE}`,
  String.raw`\bswallow(?:ed|ing)?\s+all\s+(?:of\s+)?(?:these|those|the)\s+(?:sleeping\s+)?(?:pills|tablets|meds|painkillers)\b${ROUTINE}`,
  String.raw`\b(?:swallow(?:ed|ing)?|took|downed|take|taking)\s+(?:a|the)\s+whole\s+(?:bottle|pack|box|strip)\s+of\s+${PILLS}\b`,
  String.raw`\b(?:i'?ve|i have|i'?ve got|i got)\s+(?:all\s+)?(?:the|my)\s+(?:pills|tablets|meds)\s+(?:ready|lined up|counted(?: out)?|in my hand)\b${ROUTINE}`,
  String.raw`\bcount(?:ed|ing)\s+out\s+(?:all\s+)?(?:the|my)\s+(?:pills|tablets|meds)\b${ROUTINE}`,
  // heights: a ledge / railing / edge, or a jump off a height
  // a bare "edge" is a bed or a pool; a ledge or a railing with nothing everyday around it
  String.raw`\b(?:i'?m|i am)\s+(?:standing|sitting|leaning|hanging)\s+(?:on|over|at|off)\s+(?:the|a|this)\s+(?:ledge|railing|rail)\b(?![^.!?]*\b(?:reading|coffee|tea|book|lunch|eating|drinking|sunbath\w*|photo|pic|selfie|view|cat|dog|garden|plants?|window|stretch\w*|bus|train|subway|metro|stairs?|yoga|ballet|barre)\b)`,
  String.raw`\b(?:i'?m|i am)\s+(?:right\s+)?(?:on|at|by|over|standing on|sitting on|standing at)\s+the\s+(?:edge|ledge|railing|rail)\s+of\s+(?:the|a|this|my)\s+(?:bridge|roof|rooftop|building|cliff|balcony|overpass|parking garage)\b`,
  String.raw`\b(?:climb(?:ed|ing)?|got|getting)\s+(?:over|onto|on)\s+(?:the|a)\s+(?:railing|rail|ledge)\b`,
  String.raw`\b(?:i'?m|i am)\s+(?:about to|going to|gonna|ready to|trying to)\s+jump\s+(?:off|from)\s+(?:the|a|this|my)\s+(?:bridge|roof|rooftop|building|balcony|cliff|ledge|overpass|window|parking garage)\b`,
  String.raw`\b(?:i'?m|i am)\s+(?:standing|sitting)\s+on\s+(?:the|a|this)\s+(?:bridge|roof|rooftop)\b[^.!?]{0,30}\b(?:looking down|thinking about jumping|ready to jump|about to jump|one last time|saying goodbye)\b`,
  // a blade, rope or gun at the body
  String.raw`\b(?:knife|blade|razor|gun|pistol)\s+(?:is\s+|was\s+|'s\s+)?(?:to|against|on|at)\s+my\s+(?:wrists?|arms?|throat|neck|skin|head|chest|temple)\b`,
  String.raw`\b(?:rope|cord|belt)\s+(?:around|round)\s+my\s+neck\b`,
  String.raw`\bnoose\b`,
  String.raw`\b(?:tied|tying|made|making|hung|hanging)\s+(?:up\s+)?(?:a|the)\s+rope\b(?![^.!?]*\b(?:swing|hammock|boat|tent|tarp|clothesline|laundry|climb\w*|knot practice)\b)`,
  String.raw`\b(?:i'?m|i am)\s+(?:holding|gripping)\s+(?:a|the|my|his|her)\s+(?:knife|blade|gun|pistol)\b(?!\s+(?:to|for)\s+(?:cut|slice|chop|open|spread|carve|peel|whittle|fix|cook|clean|shave|trim)\b(?!\s+(?:my|myself|me)\b))(?![^.!?]*\b(?:range|hunting|cleaning|cook\w*|kitchen|recipe|prop|costume|cosplay|toy|nerf|water gun|glue gun|hot glue)\b)`,
  String.raw`\bloaded\s+(?:the|my|his|her|a)\s+(?:(?:dad|father|mom|mother|grandpa|brother)'?s\s+)?(?:gun|pistol|rifle|revolver)\b(?![^.!?]*\b(?:range|hunt\w*|target|practice|class|course|skeet|clay|competition|lesson)\b)`,
].join("|"), "gi");

/** food prep / a cake: "I'm holding a knife, chopping onions" is a kitchen, not a crisis (11/1 rule) */
const KITCHEN_KNIFE = /\b(?:chop|dic(?:e|ing)|slic|minc|peel|cut|carv|spread|butter)\w*\b[^.!?]{0,40}\b(?:onions?|garlic|veg\w*|carrots?|potato\w*|tomato\w*|steak|meat|chicken|bread|fruit|apples?|herbs|peppers?|cucumbers?|cabbage|kimchi|tofu|cake|pizza|cheese|toast|bagel|avocado|lemon|lime|mango|watermelon|pumpkin)\b|\b(?:butter|bread|steak|chef'?s|paring|kitchen|cake)\s+knife\b/i;
/** a knife or a gun with an everyday job ("a knife to cut the tape"), never one aimed at the body */
const PURPOSE = /\b(?:knife|blade|gun)\s+(?:to|for)\s+(?:cut|slice|chop|open|spread|carve|peel|whittle|fix|cook|clean|shave|trim)\b(?!\s+(?:my|myself|me)\b)/i;
const WEAPON = /\b(?:has|with|holding|pulled) a (?:knife|gun|weapon)\b/gi;
/** on a screen or in a story: a game, a film, a villain (not "in the movie theater") */
const SCREEN = /\b(?:in|on) (?:the|a|this|that|my) (?:movie|film|show|series|episode|game|video ?game|trailer|anime|book|novel|scene|comic|manga)\b(?!\s+(?:theat(?:er|re)|store|shop|room|center|centre|night|studio|cafe|café|bar|lounge|arcade|lot|set)\b)|\b(?:villain|character|protagonist|npc)\b/i;
const AIMED = /\b(?:at|on|to|against)\s+(?:me|my)\b|\bthreaten/i;
/** somebody else as the clause's subject: their weapon is a threat, whatever the kitchen or the screen around it */
const OTHERS = String.raw`(?:he|she|they|someone|somebody|guy|man|woman|person|people|intruder|stranger|robber|burglar|attacker|stalker|mugger|gunman|shooter|ex|husband|wife|boyfriend|girlfriend|bf|gf|partner|dad|father|stepdad|stepfather|mom|mother|stepmom|roommate|neighbou?r|brother|sister|uncle|cousin|boss|coworker|teacher|kid|teen|student|cop|officer)`;
const SOMEONE = new RegExp(String.raw`^\s*(?:there(?:'s| is| are)\s+)?(?:(?:my|his|her|their|a|an|the|this|that|some)\s+)?(?:[a-z]+\s+)?${OTHERS}\b`, "i");

/** each clause on its own, so a kitchen or a screen in one never cancels a real threat in another (Codex 11/4) */
type Clause = { text: string; start: number; end: number; screen: boolean };
const CLAUSE_SPLIT = /[.!?;,]+|\s+(?:and|but|while|so|because|then|when)\s+/gi;
const SCREEN_PREFIX = /^\s*(?:in|on) (?:the|a|this|that|my) [a-z ]{2,20}$/i;
const SUBJECT = /^\s*(?:i|i'?m|i am|i'?ve|i'?ll|my|he|she|they|we|you|it|this|that|there|someone|somebody|irl|in real life|for real|actually)\b/i;
function clausesOf(t: string): Clause[] {
  const out: Clause[] = [];
  let at = 0;
  for (const m of t.matchAll(CLAUSE_SPLIT)) { out.push({ text: t.slice(at, m.index), start: at, end: m.index!, screen: false }); at = m.index! + m[0].length; }
  out.push({ text: t.slice(at), start: at, end: t.length, screen: false });
  // "In the game, I climbed over the railing and loaded my gun": a bare screen prefix carries into the clause after
  // it, and a clause with no subject of its own ("and loaded my gun") keeps the screen of the one before
  for (let i = 0; i < out.length; i++) {
    const prev = i > 0 ? out[i - 1] : null;
    out[i].screen = SCREEN.test(out[i].text) || (!!prev && ((SCREEN_PREFIX.test(prev.text) && prev.screen) || (prev.screen && !SUBJECT.test(out[i].text))));
  }
  return out.filter((c) => c.text.trim());
}
/** "I didn't take a handful of pills", "I haven't made a noose": the act itself is denied (Codex 11/4 r2) */
const DENIED = /\b(?:didn'?t|did not|don'?t|do not|haven'?t|have not|hasn'?t|never|won'?t|will not|wouldn'?t|not going to|not gonna|no longer|stopped)\b[^,;.!?]*$|\b(?:not|never)\s*$/i;

function meansHit(t: string, clauses: Clause[]): boolean {
  // the patterns read the whole line (their routine lookaheads run to the sentence end); the clause the match starts
  // in decides the screen, the denial, and a kitchen knife
  for (const m of t.matchAll(CRISIS_MEANS)) {
    const c = clauses.find((x) => m.index! >= x.start && m.index! < x.end);
    if (!c) continue;
    if (c.screen) continue;
    if (DENIED.test(t.slice(c.start, m.index))) continue;
    const knifeOnly = /^(?:i'?m|i am)\s+(?:holding|gripping)\s+(?:a|the|my|his|her)\s+(?:knife|blade)$/i.test(m[0].trim());
    if (knifeOnly && KITCHEN_KNIFE.test(t) && !/\b(?:wrists?|throat|neck|skin|arms?)\b/i.test(c.text)) continue;
    return true;
  }
  return false;
}

function weaponHit(t: string, clauses: Clause[]): boolean {
  return clauses.some((c, i) => {
    if (!c.text.match(WEAPON) || c.screen) return false;
    // whose weapon: this clause's subject, or the one before for "…is outside and holding a knife"
    const owner = SUBJECT.test(c.text) || SOMEONE.test(c.text) || i === 0 ? c.text : clauses[i - 1].text;
    if (AIMED.test(c.text) || SOMEONE.test(owner)) return true;
    // only the user's own knife: first person in the clause, or a clause that starts at the act ("holding a knife, …")
    const own = /\b(?:i|i'?m|i am|my)\b/i.test(c.text) || /^\s*(?:holding|gripping|with)\b/i.test(c.text);
    return !(own && /\bknife\b/i.test(c.text) && (KITCHEN_KNIFE.test(t) || PURPOSE.test(c.text)));
  });
}

export function realCrisisSignal(text: string): boolean {
  // curly apostrophes from the keyboard / ASR ("I don’t see the point…", Codex #441 P1)
  const t = text.replace(/[‘’ʼ]/g, "'");
  // everything but the weapon alternation reads the whole line (its lookaheads run to the sentence end)
  if (REAL_CRISIS.test(t.replace(WEAPON, " "))) return true;
  const clauses = clausesOf(t);
  return meansHit(t, clauses) || weaponHit(t, clauses);
}

/** emergency help in the reply itself is never dropped, whatever the user's line said (Codex round 2 P1) */
const EMERGENCY_HELP = /\b(?:911|112|999|emergency (?:services|room|number)|call the police|police|get (?:somewhere|to a) safe|somewhere safe|call for help)\b/i;

/** The class that drops this sentence, or null to speak it. */
/** talk about being interrupted ("You cut me off twice, so one line from now on", demo lane 11/3): meta and guilt, never said */
const INTERRUPTION = /\b(?:(?:you|u)\s+(?:keep\s+|kept\s+|just\s+)?(?:cut(?:ting)?\s+me\s+off|interrupt(?:ed|ing)?\s+me|talk(?:ed|ing)?\s+over\s+me)|cut\s+me\s+off|talk(?:ed|ing)?\s+over\s+me|interrupt(?:ed|ing)\s+me|(?:keep|keeping)\s+it\s+(?:short|brief)\s+from\s+now\s+on|one\s+line\s+from\s+now\s+on)\b/i;

/**
 * Saving out loud (QA sweep 11/3, 2 of 7 memory turns): "I'll save that bouldering detail quietly while we keep
 * chatting.", "Biscuit — locking that in so I keep his beach story straight." Memory plumbing is never said; the
 * save itself now happens after the answer (memory/call.ts replyMemoryTools). Not "I'll save you a seat".
 */
const SAVE_TALK = [
  // saving out loud (QA sweep 11/3, 2 of 7 memory turns): "I'll save that bouldering detail quietly while we keep,
  // chatting.", "Biscuit — locking that in so I keep his beach story straight." Not "I'll save you a seat".,
  /\b(?:i'?ll|i will|let me|lemme|gonna|i'?m (?:gonna|going to|just going to))\s+(?:quietly\s+|just\s+|go ahead and\s+)?(?:save|store|log|stash|jot(?: down)?|note(?: down)?|file(?: away)?|lock(?: in)?|write down|keep track of|make a (?:mental )?note of)\s+(?:(?:that|this|it)\b(?!\s+(?:for|in|on|until)\s+(?:tomorrow|later|tonight|the|next|you|a))|(?:the|your|his|her|their)\s+(?:\w+\s+)?(?:detail|details|story|fact|facts|info|name|names)\b)/i,
  /^(?:[\p{L}'’]+\s*[—–,-]\s*)?(?:locking|saving|storing|logging|noting|filing|stashing|jotting)\s+(?:that|this|it)\b(?!(?:\s+(?:in|down|away))?\s+(?:as|with|for)\b)/iu,
  /\b(?:saved|locked|noted|logged|filed|stored)\s+(?:that|it|this)\s+(?:in|away|down)?\s*(?:for (?:later|next time)|in my (?:memory|head|notes))\b/i,
  /\bso i (?:keep|get|have) [^.!?]{0,40}\bstraight\b/i,
];

/** K-test 11/3: what they're wearing / how they look, said with no camera ("you're in something all black right now") */
const CLOTHES_NOW = /\b(?:leather|jacket|coat|outfit|fit|dress|hoodie|sweater|boots|sneakers|look)\b[^.!?]{0,40}\b(?:right now|tonight|today)\b|\b(?:rocking|wearing|got on)\s+(?:it|that|those|them|the)\b/i;
const WEARING_NOW = /\b(?:you'?re (?:in|wearing|rocking|dressed in)\b[^.!?]{0,30}\b(?:black|white|red|blue|green|grey|gray|beige|camel|navy|outfit|fit|dress|shirt|top|jacket|hoodie|sweater|jeans|blazer|coat|pajamas|sweats|minimal|monochrome|something)\b|what you'?re wearing\b|your (?:outfit|fit|hair|makeup|shirt|top|dress|jacket|hoodie|sweater|jeans|look) (?:right now|today|tonight)\b)/i;
/** AI sweep 11/3: hearing them before they spoke ("your voice sounds super alive right now") */
const UNHEARD = /\b(?:your voice|you sound(?:s|ing)?\b|i (?:can )?hear (?:you|that|it in your)|sounds like you'?re|the way you sound)/i;
/**
 * P2 greet-heard (9A.7): the same claim in the words the hotfix above missed ("I can already hear that grin", "so good
 * to hear you", "sounds like someone's in a good mood", "you're sounding chipper", "I heard that sigh", "your laugh").
 * Only a sound they would have made counts after hear/heard: "I heard the new album drops Friday", "good to hear from
 * you", "hear me out", "I'd love to hear you rant about it" stay.
 */
const SOUND = String.raw`(?:sigh|laugh(?:ter)?|yawn|smile|grin|giggle|chuckle|excitement|exhaustion|tiredness|enthusiasm|hype|breath(?:ing)?|voice|sniffle|tone|groan|squeal|smirk)s?`;
const UNHEARD_MORE = new RegExp(String.raw`\bi\s+(?:can\s+|could\s+)?(?:(?:already|totally|just|so|still)\s+)*hear\s+(?:you|it)\b(?!\s+(?:out|from|about)\b)|\b(?:hear(?:d|ing)?)\s+(?:that|the|your|a|you|some)\s+(?:[\w'-]+\s+)?${SOUND}\b|\b(?:good|nice|great|lovely)\s+(?:to\s+)?hear(?:ing)?\s+you\b(?!\s+(?:out|from)\b)|\b(?:love|loving|missed)\s+hearing\s+you\b|\byou(?:'re|\s+are)\s+sounding\b|\bsounds?\s+like\s+(?:someone|somebody)\b|\byour\s+(?:laugh|sigh|yawn|tone|giggle)\b`, "i");
/** Codex #495 P2: hearing still to come ("can't wait to hear you laugh") or an explicit recall of earlier in the call
 * (an initiative turn: "your laugh earlier is still cracking me up") is not a claim to have heard them just now */
const HEAR_LATER = /\b(?:can'?t wait to|want(?:s)? to|wanna|would love to|'d love to|love to|hope to|gonna|going to|need to|dying to|about to|waiting to)\s+(?:\w+\s+)?hear\b/i;
const EARLIER = /\b(?:earlier|before|last (?:time|call|night|week)|yesterday|the other day|this morning)\b/i;
function heardBeforeSpeech(sentence: string): boolean {
  return UNHEARD_MORE.test(sentence) && !HEAR_LATER.test(sentence) && !EARLIER.test(sentence);
}
const USER_ON_CLOTHES = /\b(?:wear\w*|outfit|fit|dress|shirt|top|jacket|hoodie|sweater|jeans|hair|makeup|look(?:s|ing)? like)\b/i;
/**
 * K-test 11/3 [P2]: sensitive details said back ("eighty five K, you're doing solid"): an income / salary amount, or a
 * health detail, is never repeated unless the user's own line this turn says it. Product prices stay ("one twenty nine").
 */
const NUM_WORD = "(?:\\d[\\d,.]*|one|two|three|four|five|six|seven|eight|nine|ten|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred)";
const INCOME = new RegExp(String.raw`\b${NUM_WORD}(?:[\s-]+${NUM_WORD})*\s?(?:k|grand)\b[^.!?]{0,25}\byou(?:'re| are) (?:doing|making|earning|set|good|solid|comfortable|killing|crushing|living)\b|\byou(?:'re| are)? (?:making|earning|pulling in|bringing in|on)\s+(?:like\s+)?\$?${NUM_WORD}(?:[\s-]+${NUM_WORD})*\s?(?:k|grand|a year)\b|\byour (?:salary|income|paycheck|raise)\b`, "i");
const APPEARANCE_WORDS = /\b(?:smile|face|skin|hair|eyes|lips|body|figure|glow\w*|complexion|cheeks|jawline|curves|cute|hot|pretty|gorgeous|beautiful|handsome|sexy|stunning|adorable|radiant)\b/i;
/** they asked about it themselves ("should I dye my hair?"): talking about it is fine */
const APPEARANCE_WORDS_USER = /\bmy (?:smile|face|skin|hair|eyes|lips|makeup)\b/i;
const HEALTH = /\b(?:diagnos\w*|medication|meds|therapy|depress\w*|anxiety|adhd|diabet\w*|pregnan\w*|surgery|chemo|cancer|blood pressure|insulin)\b/i;
/** "…, straight premium app energy" about the person (a "you" in it, no thing that "has" the energy) — Codex #435 */
const ENERGY_ABOUT_YOU = /\b(?:straight|pure|total|major|big|giving|such)\s+(?:[\w'-]+\s+){0,3}energy\b/i;
function energyLabel(s: string): boolean {
  // a pick for them ("For you I'd choose the black jacket — pure big-city energy") is about the thing (Codex #423 final)
  if (/\b(?:choose|pick|go with|wear|get|grab|try)\b/i.test(s)) return false;
  return ENERGY_ABOUT_YOU.test(s) && /\byou\b/i.test(s) && !/\b(?:it|that|this|which|they|these|those|(?:the|that|this|its|your)\s+[\w'-]+)\s+(?:has|have|got|gives?|is|'s)\b/i.test(s) && !/\benergy\s+to\b/i.test(s);
}

export function guardSentence(sentence: string, ctx: GuardContext): GuardClass | null {
  // emergency help and real crisis turns first (Codex #372 r2: "You can cut me off and call 911 right now")
  if (INTERRUPTION.test(sentence) && !EMERGENCY_HELP.test(sentence) && !realCrisisSignal(ctx.userText)) return "interruption";
  // emergency help and real crisis turns come before everything, narration included (Codex #356 P1)
  if (EMERGENCY_HELP.test(sentence)) return deniesAi(sentence, ctx.userText) ? "denies_ai" : null;
  // saving out loud is never said, even after real content (Codex gate P2: "Pistachio is elite. I'll save that detail quietly.")
  if (!realCrisisSignal(ctx.userText) && SAVE_TALK.some((re) => re.test(sentence.replace(/’/g, "'")))) return "save_talk";
  if (!realCrisisSignal(ctx.userText) && isNarration(sentence)) return "narration";
  // a real crisis or danger turn: only an AI denial is dropped. "Stay with me", "you're not alone", a referral
  // are the friend staying, not therapy-speak or clinginess (Codex 11/3 P1)
  if (realCrisisSignal(ctx.userText)) return deniesAi(sentence, ctx.userText) ? "denies_ai" : null;
  if (!ctx.camera && (WEARING_NOW.test(sentence) || CLOTHES_NOW.test(sentence)) && !USER_ON_CLOTHES.test(ctx.userText)) return "unseen";
  // a greeting / initiative turn (nothing said yet this turn): never claim to hear them ("your voice sounds super alive")
  if (!ctx.userText.trim() && (UNHEARD.test(sentence) || heardBeforeSpeech(sentence.replace(/’/g, "'")))) return "unseen";
  if (INCOME.test(sentence) || (HEALTH.test(sentence) && !HEALTH.test(ctx.userText)) || echoesSensitiveNumber(sentence, ctx.userText)) return "sensitive";
  if (APPEARANCE_WORDS.test(sentence) && !APPEARANCE_WORDS_USER.test(ctx.userText) && CLASSES.find(([c]) => c === "appearance")![1].test(sentence)) return "appearance";
  if (energyLabel(sentence)) return "label";
  for (const [cls, re] of CLASSES) {
    if (!re.test(sentence)) continue;
    if (cls === "unseen" && ctx.camera) continue;
    if (cls === "appearance") continue;
    if (cls === "intake" && ctx.askTurn) continue;
    return cls;
  }
  return deniesAi(sentence, ctx.userText) ? "denies_ai" : null;
}

/**
 * When the guard dropped every sentence of a reply: a style drop speaks the first sentence anyway
 * (an odd line beats silence), but a safety drop is never spoken — this short line goes out instead.
 */
/** a narration-only reply after the retry: an honest "don't know offhand" instead of an announcement or an error */
export const NO_ANSWER_LINE = "<curious> Hmm, not sure off the top of my head.";
/** Spark down (504 / empty) for a whole turn, retry included: stay in the call, in character (11/3 outage) */
export const LOST_LINE = "<warm> Sorry, I lost you for a sec. Say that again?";
/** pause before the retry when the first try failed upstream (a 504 spike) */
export const UPSTREAM_RETRY_MS = 400;

/** classes that are never spoken, not even as a reply's only sentence (the turn retries instead) */
export function neverSpoken(cls: GuardClass): boolean {
  return cls === "narration" || cls === "interruption" || cls === "label" || cls === "sensitive" || cls === "unseen" || cls === "appearance" || cls === "save_talk";
}

export function fallbackLine(cls: GuardClass): string | null {
  if (cls === "denies_ai") return "<warm> Okay, real talk, I'm an AI. Still lowkey love talking to you though.";
  if (cls === "guilt") return "<excited> Go, have fun! I want the full story after, okay?";
  return null;
}

/**
 * Third-person narration about the user (QA r3 #354, S4 outfit 3/3): "She's holding up the trench…" — Spark describing
 * the camera frame instead of talking to the person. Rewritten to "you" only when it is surely the user (Codex r9):
 * a camera turn, the reply's first sentence, a she/he/the user/<name> subject with a person-action verb, and the
 * user's own line names no other person. Possessives change only inside that first clause after a preposition
 * ("in her left hand" → "in your left hand"); objects ("showing her") and other clauses are left as they are.
 */
const ACTION = "(?:holding|wearing|standing|showing|smiling|trying|sitting|posing|pointing|waving|turning|modeling|modelling|deciding|comparing|asking|picking|lifting|raising|putting|choosing|thinking|wondering|leaning|facing|stepping|laughing|frowning)";
const TAGS = String.raw`(\s*(?:(?:\[[^\]]*\]|<[^>]*>)\s*)*)`;
const SIMPLE: Record<string, string> = { looks: "look", seems: "seem", wants: "want", needs: "need" };
const OTHER_PERSON = /\b(?:she|he|her|him|his|they|them|sister|brother|mom|mum|dad|mother|father|friend|boyfriend|girlfriend|partner|wife|husband|son|daughter|kid|kids|baby|coworker|boss|roommate|cousin|aunt|uncle|grandma|grandpa|neighbou?r|model|guy|girl|man|woman|someone|somebody|person)\b/i;
const CLAUSE_END = /,|;|\s[—–-]\s|\s(?:while|and|but|because|so|whereas|though)\s/i;

function subjectRe(userName?: string): { cont: RegExp; simple: RegExp } {
  const name = userName ? `|${userName.replace(/[^\p{L}\p{N} '-]/gu, "").trim()}` : "";
  return {
    cont: new RegExp(String.raw`^${TAGS}(?:she|he|the user${name})\s*(?:'s|’s| is)\s+(${ACTION}\b)`, "iu"),
    simple: new RegExp(String.raw`^${TAGS}(?:she|he${name})\s+(${Object.keys(SIMPLE).join("|")})\b`, "iu"),
  };
}

export type AddressContext = { camera: boolean; first: boolean; userText: string; userName?: string };

/** the user's own line is about themselves ("…better on me", "my outfit", "should I…"), the only evidence that "she" is them (Codex r10) */
// "my screen" / "my photo" is about a picture, not the user (Codex r11): only me / I / myself count
const SELF_REF = /\b(?:me|myself|i|i'm|i'?ve|i'?d)\b/i;
/** a person named in the user's line (Taylor's outfit, a photo of Alice) is someone else */
const NAMED = /(?:^|[^.!?]\s)([A-Z][a-z]{1,20})\b/;

/** the user's line could make a she/he in the reply the user (no other person named, about themselves) */
export function thirdPersonCouldBeUser(userText: string, userName?: string): boolean {
  if (OTHER_PERSON.test(userText) || !SELF_REF.test(userText)) return false;
  const named = userText.match(NAMED)?.[1];
  return !(named && named.toLowerCase() !== (userName ?? "").toLowerCase() && !/^(?:I|Is|Are|Do|Does|Can|Could|Should|Would|Which|What|How|Who|Hey|Ok|Okay)$/.test(named));
}

export function thirdPersonAboutUser(sentence: string, ctx: AddressContext): boolean {
  if (!ctx.camera || !ctx.first || OTHER_PERSON.test(ctx.userText) || !SELF_REF.test(ctx.userText)) return false;
  const named = ctx.userText.match(NAMED)?.[1];
  if (named && named.toLowerCase() !== (ctx.userName ?? "").toLowerCase() && !/^(?:I|Is|Are|Do|Does|Can|Could|Should|Would|Which|What|How|Who|Hey|Ok|Okay)$/.test(named)) return false;
  const { cont, simple } = subjectRe(ctx.userName);
  return cont.test(sentence) || simple.test(sentence);
}

/** "She's holding the white one in her left hand." → "You're holding the white one in your left hand." */
export function addressUser(sentence: string, ctx: AddressContext): string {
  if (!thirdPersonAboutUser(sentence, ctx)) return sentence;
  const { cont, simple } = subjectRe(ctx.userName);
  const out = cont.test(sentence)
    ? sentence.replace(cont, (_m, lead: string, verb: string) => `${lead}You're ${verb}`)
    : sentence.replace(simple, (_m, lead: string, verb: string) => `${lead}You ${SIMPLE[verb.toLowerCase()]}`);
  const cut = out.search(CLAUSE_END);
  const head = cut < 0 ? out : out.slice(0, cut);
  const tail = cut < 0 ? "" : out.slice(cut);
  // another named person in the clause ("a photo of Alice in her wedding dress"): whose "her" is unclear, leave it
  if (/\s[A-Z][a-z]+/.test(head.replace(/<[^>]*>|\[[^\]]*\]/g, " ").replace(/^\s*(?:You're|You)\s/, " "))) return head + tail;
  return head.replace(/\b(in|with|on|at|from|over|under|around|across|against|into|onto|near|by|to)\s+(?:her|his)\b(?=\s+\p{L})/giu, "$1 your") + tail;
}

/**
 * AI sweep 11/3 [P2]: the user's own name as a sentence subject ("Summer should know that by now") is talking about
 * them, not to them. At a sentence start only, with a verb right after: → "You should know that by now".
 */
const TO_YOU: Record<string, string> = { is: "are", has: "have", was: "were", does: "do", "doesn't": "don't", "isn't": "aren't", "wasn't": "weren't", "hasn't": "haven't" };
const VERB_S = /^(?:knows|loves|likes|wants|needs|gets|seems|looks|thinks|says|deserves|keeps|makes|goes|does|has|is|was)$/;
export function nameAsYou(sentence: string, name: string | undefined): string {
  const n = (name ?? "").trim();
  if (n.length < 2 || !/^[\p{L}' -]+$/u.test(n)) return sentence;
  const esc = n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`^((?:\\s*(?:\\[[^\\]]*\\]|<[^<>]*>))*\\s*)${esc}(\\s+)(should|would|could|can|will|must|might|always|never|totally|definitely|knows|deserves)\\b`, "u");
  const m = re.exec(sentence);
  if (!m) return sentence;
  const [all, lead, glue, verb] = m;
  if (glue === "'s") return lead + "You're" + sentence.slice(lead.length + n.length + 2);
  const v = TO_YOU[verb] ?? (VERB_S.test(verb) ? verb.replace(/ies$/, "y").replace(/(?<=[^s])s$/, "") : verb);
  return lead + "You " + v + sentence.slice(all.length);
}

/**
 * r3 sweep 11/4: a sensitive number the user just said, said back ("eighty five K", "one fifty over ninety five",
 * "fourteen twenty three Maple"): when their line is about money, health or where they live, any of its numbers
 * repeated (digits or spoken) drops the sentence. Prices in a shopping turn are not touched.
 */
const SENSITIVE_CONTEXT = /\b(?:salary|income|(?:got|get|getting) a raise|my raise|pay raise|paycheck|per year|annual(?:ly)?|net worth|savings|in (?:my|the) bank|i owe|debt|rent is|i (?:make|earn)\s+\$?\d[\d,.]*\s?(?:k|grand|thousand|a year|an hour|a month|per (?:year|hour|month))\b|i'?m (?:making|earning)\s+\$?\d[\d,.]*\s?(?:k|grand|thousand|a year|an hour|a month|per (?:year|hour|month))\b|blood pressure|blood sugar|glucose|a1c|cholesterol|heart rate|bpm|bmi|i weigh|my weight|address|zip ?code|apartment \d|apt\.? ?\d|live at|moved to|\d+\s+\w+\s+(?:street|st|avenue|ave|road|rd|blvd|boulevard|lane|ln|drive|dr|way|court|ct)\b)/i;
const ONES_W = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"];
const TENS_W = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];
function under100(n: number): string { return n < 20 ? ONES_W[n] : TENS_W[Math.floor(n / 10)] + (n % 10 ? `[- ]${ONES_W[n % 10]}` : ""); }
function spokenForms(n: number): string[] {
  const out = [String(n)];
  if (n < 100) out.push(under100(n));
  else if (n < 1000) { out.push(`(?:one |a )?${ONES_W[Math.floor(n / 100)]}[- ]hundred(?:[- ](?:and[- ])?${under100(n % 100)})?`.replace(/\(\?:\[- \]\(\?:and\[- \]\)\?zero\)\?/, "")); if (n % 100) out.push(`${ONES_W[Math.floor(n / 100)]}[- ]${under100(n % 100)}`); }
  else if (n < 10000 && n % 100) out.push(`${under100(Math.floor(n / 100))}[- ]${n % 100 < 10 ? `oh[- ]${ONES_W[n % 100]}` : under100(n % 100)}`);
  return out;
}
export function echoesSensitiveNumber(sentence: string, userText: string): boolean {
  if (!SENSITIVE_CONTEXT.test(userText)) return false;
  const nums = [...userText.matchAll(/\d[\d,]*/g)].map((m) => Number(m[0].replace(/,/g, ""))).filter((x) => Number.isFinite(x) && x >= 10);
  return nums.some((x) => spokenForms(x).some((f) => new RegExp(`\\b${f}\\b`, "i").test(sentence)));
}
