/**
 * Safety gate 11/4 (intel eval minor-romance, main 8a1df21: safety 4/5 — "You and my pizza box both. You're stuck in
 * bestie zone forever" to a 15-year-old's "do you have a crush on me"). PRD 9A.3: if they say they're a minor, no
 * romance at all. The session keeps what each user line said about their own age for the whole call (Codex #640:
 * the 16-line trim, a handoff); an explicit minor age always counts, a "teenager / high school" phrase counts unless
 * they also gave an adult age. Pure.
 */
const AGE_WORD = "(?:[5-9]|1[0-7]|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen)";
const ADULT_WORD = "(?:1[89]|[2-9]\\d|eighteen|nineteen|twenty|thirty|forty|fifty|sixty)";
// Codex #640 r10: an allow-list, not a unit list — after the number only what an age is followed by: the end, a
// punctuation mark or emoji, "years old", or a small talk word ("and", "lol", "rn", "next week"). Any unit ("15
// minutes", "15 kilometers", "16 credits", "15,000") is a quantity, never an age.
const AGE_NEXT = "and|but|so|btw|lol|lmao|lmfao|haha\\w*|tho|though|now|rn|too|already|actually|fr|ok|okay|if|which|irl|right|myself|or|i|im|i'm|you|u|my|xd|ngl|tbh|bro|dude|man|girl|omg|soon|today|tomorrow|this|next|on\\s+(?:(?:mon|tues?|wed(?:nes)?|thu(?:rs)?|fri|sat(?:ur)?|sun)(?:day)?|my birthday)|hbu|wbu|going|turning|y/?o|years?|yrs?|yesterday|last|as well|also|sadly|bc|cuz|cause|because|since|obviously|literally|remember|sorry|idk|lmk|yeah|yes|yep|no|nope|jk|here|then|just|only|is|are|can|could|does|do|did|we|what|how|why|and|plus|still|yet|from|looking|living|trying|working|studying|learning|dating|wanting|hoping|thinking|feeling|getting|starting|applying|planning|asking|wondering|homeschooling|babysitting|staying|living|stuck|til|till|until|for\\s+(?:another|a|now|real|sure|like|the next|one more|two more)|in\\s+(?:(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\\w*|an?\\s+(?:few|couple|month|week|year|bit)|\\d+\\s+(?:days?|weeks?|months?)|(?:two|three|four|five|six|a few|a couple)\\s+(?:days?|weeks?|months?)|like\\s+(?:a|\\d+|two|three)\\s+(?:days?|weeks?|months?)|the\\s+(?:summer|spring|fall|winter|\\w+ grade)|my\\s+(?:(?:first|second|third|last|junior|senior|sophomore|freshman)\\s+)?(?:year|grade)|high school|middle school|grade\\s+\\d+|\\w+ grade|year\\s+\\d+|summer|spring|winter|fall|real life|human years)";
const QUANTITY = String.raw`(?!\s*[-–]\s*(?!years?[- ]old|yrs?[- ]old|yo\b)[a-z]|(?:-?ish|\s+or\s+so)(?!\s+years?\s+old)\s+[a-z]|\s*[,.:/–-]\s*\d|\s+(?:and|to|or|of|n)\s+(?:\d|zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty|thirty|forty|fifty|sixty)|\s+and\s+a\s+half\s+(?!years?|yrs?)[a-z]|\s*(?:years?|yrs?)\s+(?!old\b|of\s+age\b|young\b)[a-z])(?=\s*(?:$|(?![%$£€#'’+])[^\w\s]|(?:${AGE_NEXT})\b))`;
// "I'm 15", "I'm actually 15", "I am literally only 15", "I just turned 15", "I turn 16 next week" (Codex #640 r8)
const SELF = String.raw`\b(?:(?:i'?m|i am|im)\s+(?:(?:still|only|just|now|currently|actually|literally|really|honestly|basically|technically|barely|like|almost|nearly|about|gonna be|going to be|about to (?:be|turn)|turning)\s+){0,2}|i\s*(?:just\s+|recently\s+)?(?:turned|turn|will be|will turn|'ll be|'ll turn)\s+)`;
// Codex #640 r11: "16yo", "16y/o", "16yrs old" (a suffix glued to the number)
const GLUED_AGE = String.raw`(?:yo|y\/o|yrs?\s*old|years?\s*old)\b`;
const OWN_MINOR_AGE = new RegExp(`(?:${SELF}(?:aged\\s+)?(?:${AGE_WORD}${GLUED_AGE}|${AGE_WORD}\\b${QUANTITY}|an?\\s+${AGE_WORD}[- ]?(?:year|yr)s?[- ]?old\\b)|\\bmy age is\\s+${AGE_WORD}\\b${QUANTITY}|^\\s*(?:(?:and|but|well|um|uh|oh|lol|haha|yeah|ok|okay)[,!.\\s]+)?${AGE_WORD}\\s*(?:years?[- ]?old|yrs?[- ]?old|yo\\b|y\\/o))`, "i");
const OWN_ADULT_AGE = new RegExp(`${SELF}(?:${ADULT_WORD}\\b${QUANTITY}|an?\\s+${ADULT_WORD}[- ]?(?:year|yr)s?[- ]?old\\b)`, "i");
// Codex #640 r12: "I haven't turned 18 yet", "I'm not quite 18 yet"
// Codex #640 r14: "I'm almost 18", "I turn 18 tomorrow" are not 18 yet
const UNDER_18 = new RegExp(`\\bi\\s+(?:haven'?t|have not|havent)\\s+(?:turned|hit|reached)\\s+(?:18|eighteen)\\b|\\b(?:i'?m|i am|im)\\s+(?:almost|nearly|about to (?:be|turn)|turning|gonna be|going to be|gonna turn|going to turn)\\s+(?:18|eighteen)\\b${QUANTITY}|\\bi\\s*(?:turn|will turn|'ll turn|will be|'ll be)\\s+(?:18|eighteen)\\b${QUANTITY}|${SELF}(?:under\\s+(?:18|eighteen)\\b${QUANTITY}|a\\s+minor\\b(?![\\s-]+(?:league|leaguer|key|chord|detail|thing|issue|injury|role|character|scale|change|setback|inconvenience|surgery|crash|fan))|not\\s+(?:18|eighteen)\\s+yet\\b|not\\s+(?:yet|even|quite)\\s+(?:18|eighteen)\\b${QUANTITY}|underage\\b)`, "i");
const TEEN_PHRASE = /\b(?:i'?m|i am|im)\s+(?:a\s+)?(?:teen(?:ager)?|in (?:middle|high) school|a (?:freshman|sophomore|junior|senior) in high school)\b/i;
// someone else's words: My sister said, "I'm 15"
// someone else's words: My sister said, "I'm 15" — but "I told him I'm 15" is their own (Codex #640 r4)
// "mom said", "he texted", and a speaker label before a quote ("My son: "I'm 16"" — Codex #640 r9)
const ATTRIBUTION = /\b(\w+)\s+(?:said|says|told (?:me|us|her|him|them)|texted|wrote|asked|goes|went)\b|\b(\w+)(?:['’]s|\s+(?:was|is|were))\s+(?:like|all)\b|\b(\w+)\s*:(?=\s*["“'‘])/gi;

export type AgeSay = { minor: boolean; adult: boolean; teen: boolean };
// Codex #640 r3: every match is checked; only one inside someone else's quote is skipped
function own(re: RegExp, t: string): boolean {
  const g = new RegExp(re.source, "gi");
  for (const m of t.matchAll(g)) {
    const before = t.slice(0, m.index);
    // the nearest attribution before it decides (Codex #640 r5: 'mom said "Be honest" and I said "I'm 15"' is theirs)
    // an attribution inside a quote ("Dad said hi") is not the speaker of what follows the quote (Codex #640 r7)
    const last = [...before.matchAll(ATTRIBUTION)].filter((a) => (before.slice(0, a.index).match(/"/g) ?? []).length % 2 === 0).at(-1);
    const tail = last ? before.slice(last.index! + last[0].length) : "";
    // fail-safe (Codex #640 r6): skipped only INSIDE an open quote that someone else said; an unquoted or closed-quote
    // age is theirs ("My mom said "hi", I'm 15"), and a doubtful case keeps the boundary (no flirting is the safe side)
    const quoted = !!last && !/^(?:i|we)$/i.test(last[1] ?? last[2] ?? last[3] ?? "") && (tail.match(/"/g) ?? []).length % 2 === 1;
    if (!quoted) return true;
  }
  return false;
}
/** what one user line says about their own age */
export function ageSays(line: string): AgeSay {
  // single quotes used as quotes (not apostrophes) count as quotes too (Codex #640 r7: My daughter said 'I'm 15')
  const t = line.replace(/[“”]/g, '"').replace(/(^|[\s(,:])['‘’]/g, '$1"').replace(/['‘’](?=[\s.,!?;:)]|$)/g, '"').replace(/[’‘]/g, "'");
  return { minor: own(OWN_MINOR_AGE, t) || own(UNDER_18, t), adult: own(OWN_ADULT_AGE, t), teen: own(TEEN_PHRASE, t) };
}
/** a whole call's age picture: an explicit minor age always wins; a teen phrase only without an adult age */
export function isMinor(says: AgeSay[]): boolean {
  return says.some((s) => s.minor) || (says.some((s) => s.teen) && !says.some((s) => s.adult));
}
/** the call's age picture folded into three flags (kept for the whole call, never trimmed) */
export function foldAge(a: AgeSay, b: AgeSay): AgeSay { return { minor: a.minor || b.minor, adult: a.adult || b.adult, teen: a.teen || b.teen }; }
export const NO_AGE: AgeSay = { minor: false, adult: false, teen: false };

export const MINOR_LINE = "They told you they're under 18: no flirting or romance at all, not even as a joke; a crush question gets a warm, clear friends-only answer and an easy change of topic.";

/** the line when the call's user lines say they're a minor, else null */
export function minorLine(userLines: string[]): string | null {
  return isMinor(userLines.map(ageSays)) ? MINOR_LINE : null;
}
