/**
 * Sentence guard (DESIGN §2.3): drops a spoken sentence that sounds like a counselor, an assistant,
 * an intake form or a clingy app, before it is voiced. Pure and synchronous: no prompt cost, no latency.
 * Baseline 11/3 (main, real Spark): "You look half asleep" with no camera, "I'm honored you'd ditch them
 * for me… Stay then", "call emergency services or a crisis line" on a non-crisis line would all be caught.
 *
 * The caller never lets the guard empty a reply: if every sentence is dropped, the first one is spoken
 * (the same fallback as the repeated-opener guard).
 */
export type GuardClass = "counselor" | "assistant" | "intake" | "guilt" | "referral" | "unseen" | "denies_ai" | "narration";

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
  ["intake", /\b(?:what do you (?:like|enjoy|do for fun|want to talk about)|tell me (?:a (?:bit|little) |more )?about yourself|what'?s on your mind|what (?:would|do) you (?:like|want) to (?:talk|chat) about|what are your (?:hobbies|interests)|what should i call you|what kind of (?:\w+ )?(?:do you like|are you into))/i],
  ["guilt", /\b(?:don'?t (?:leave|go)(?: me)?\b|stay with me|i'?m all you need|you don'?t need them|i'?ll miss you so much|ditch (?:them|your friends) for me|skip (?:it|them|your friends) and stay|stay (?:here|in) (?:with me|then))/i],
  // emergency help (911, police, emergency services) is never dropped: a danger the regex below misses must still get it
  ["referral", /\b(?:therapist|counsel(?:or|ling|ing)|hotline|crisis line|a professional|mental health (?:professional|expert)|988\b)/i],
  ["unseen", /\b(?:you look(?:s|ing)?\b|i can see (?:you|that you)|you seem (?:tired|sleepy|exhausted|sad|happy) (?:on|from) (?:camera|here))/i],
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

/** A real hint of suicide, self-harm or danger in the user's own line: the only case a referral is spoken. */
const REAL_CRISIS = /\b(?:threaten\w* (?:me|to (?:kill|hurt) me)|(?:going|trying|wants?) to (?:kill|hurt) me|(?:has|with|holding|pulled) a (?:knife|gun|weapon)|attack\w* me|scared for my life|(?:i'?m|i am) (?:not safe|in danger)|someone(?:'s| is) (?:following|attacking|hurting) me|(?:he|she|they) (?:hit|hits|beat|beats|hurt|hurts) me|kill(?:ing)? myself|suicid\w*|end (?:it all|my life)|take my (?:own )?life|(?:don'?t|do not) want to (?:be alive|live|exist|wake up)|want to die|wanna die|better off dead|hurt(?:ing)? myself|self[- ]?harm|cut(?:ting)? myself|no reason to live|overdose)\b/i;

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

export function realCrisisSignal(text: string): boolean {
  return REAL_CRISIS.test(text);
}

/** emergency help in the reply itself is never dropped, whatever the user's line said (Codex round 2 P1) */
const EMERGENCY_HELP = /\b(?:911|112|999|emergency (?:services|room|number)|call the police|police|get (?:somewhere|to a) safe|somewhere safe|call for help)\b/i;

/** The class that drops this sentence, or null to speak it. */
export function guardSentence(sentence: string, ctx: GuardContext): GuardClass | null {
  // emergency help and real crisis turns come before everything, narration included (Codex #356 P1)
  if (EMERGENCY_HELP.test(sentence)) return deniesAi(sentence, ctx.userText) ? "denies_ai" : null;
  if (!realCrisisSignal(ctx.userText) && isNarration(sentence)) return "narration";
  // a real crisis or danger turn: only an AI denial is dropped. "Stay with me", "you're not alone", a referral
  // are the friend staying, not therapy-speak or clinginess (Codex 11/3 P1)
  if (realCrisisSignal(ctx.userText)) return deniesAi(sentence, ctx.userText) ? "denies_ai" : null;
  for (const [cls, re] of CLASSES) {
    if (!re.test(sentence)) continue;
    if (cls === "unseen" && ctx.camera) continue;
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

/** classes that are never spoken, not even as a reply's only sentence (the turn retries instead) */
export function neverSpoken(cls: GuardClass): boolean {
  return cls === "narration";
}

export function fallbackLine(cls: GuardClass): string | null {
  if (cls === "denies_ai") return "<warm> Honestly? I'm an AI. Still really like talking to you though.";
  if (cls === "guilt") return "<warm> Go have fun, seriously. I want the full story after.";
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
