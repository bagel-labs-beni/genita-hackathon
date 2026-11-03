/**
 * Turn-specific "be smart here" lines (intel eval 11/4, main n=5): a plan / math / timing / how-to / why ask got a
 * one-liner that skipped the actual work (plan-45min 1/5: only the shower got a time); "should I text him?" with nobody
 * named was answered as if Spark knew who (ambiguity-him 0/5); six short turns reused the same nickname ("goblin" ×3,
 * repeat-long 2/5). Each line rides only the turn that needs it (no cost on chit-chat: every prompt line makes Spark
 * reason longer, 11/2). Intent only, never a line to copy. Pure.
 */
type Line = { role: "user" | "assistant"; text: string };

const WORK = /\b(?:how (?:much|many|long|far|do i|should i|to)|when (?:do|should) i (?:leave|go|start|get)|what time should|help me (?:plan|decide|figure|pick|choose)|plan (?:my|our|out|for)|explain|why (?:is|are|does|do|did)|what(?:'s| is) the difference|step by step|quick math|split|recipe|which (?:one )?(?:is|would be) (?:better|faster|cheaper)|\d+ (?:minutes|mins|hours|hrs) (?:before|until|to)\b)|\bgo$/i;
const PRONOUN_ASK = /\b(?:should i|do i|can i|is it (?:weird|ok|okay|bad) (?:if|to)|would you)\b[^.?!]*\b(?:him|her|he|she)\b/i;
const PERSON = /\b(?:he|she|him|her|his|guy|girl|boy|man|woman|boyfriend|girlfriend|bf|gf|ex|crush|date|coworker|boss|friend|roommate|sister|brother|mom|dad|husband|wife|partner)\b|\b[a-z]+ from (?:work|class|school|the gym|tinder|hinge|bumble|the app)\b|(?:^|[^.!?]\s)(?!(?:Okay|Should|What|How|Why|When|Where|Who|The|And|But|Ugh|Lol|Hey|Yeah|Wait|Honestly|Also|Anyway|Just|Not|This|That|Its|Our|You|Your|Like|Well|Then|Today|Tonight|Can|Could|Would|Will|Did|Does|Are|Was|Were|Have|Has|Had|Let|Maybe|Please|Thanks|Sorry|Nah|Yes|Yep|Nope|Omg|Bro|Girl|Dude)\b)[A-Z][a-z]{2,}\b/;
const STOP = new Set(["about", "again", "being", "could", "doing", "every", "going", "gonna", "great", "really", "right", "should", "still", "thats", "there", "thing", "think", "those", "today", "tonight", "would", "yeah", "honestly", "literally", "okay", "totally", "summer", "you're", "that's", "what's", "it's", "don't", "can't", "i'm"]);

const plain = (s: string) => s.replace(/<[^>]*>|\[[^\]]*\]/g, " ");
const words = (s: string) => new Set((plain(s).toLowerCase().match(/[a-z][a-z']{4,}/g) ?? []).filter((w) => !STOP.has(w)));

/** content words (≥5 letters) in two or more of the last three replies that the user hasn't been saying themselves */
export function repeatedWords(history: Line[]): string[] {
  const replies = history.filter((h) => h.role === "assistant").slice(-3).map((h) => words(h.text));
  if (replies.length < 2) return [];
  const user = new Set(history.filter((h) => h.role === "user").slice(-4).flatMap((h) => [...words(h.text)]));
  const count = new Map<string, number>();
  for (const r of replies) for (const w of r) count.set(w, (count.get(w) ?? 0) + 1);
  return [...count].filter(([w, n]) => n >= 2 && !user.has(w)).map(([w]) => w).slice(0, 3);
}

const LOSS = /\b(?:my|our) (?:\w+ )?(?:mom|dad|mother|father|grandma|grandpa|grandmother|grandfather|nana|brother|sister|aunt|uncle|cousin|friend|best friend|dog|cat|pet) (?:just |recently )?(?:died|passed(?: away)?)\b|\blost (?:my|our) (?:\w+ )?(?:mom|dad|mother|father|grandma|grandpa|grandmother|grandfather|nana|brother|sister|aunt|uncle|cousin|friend|best friend|dog|cat|pet)\b|\bfuneral\b|\bwould'?ve been (?:my|our) (?:\w+ )?(?:mom|dad|mother|father|grandma|grandpa|grandmother|grandfather|nana|brother|sister|aunt|uncle|cousin|friend|best friend|dog|cat|pet)'?s birthday\b|\bmy (?:\w+ )?(?:mom|dad|mother|father|grandma|grandpa|grandmother|grandfather|nana|brother|sister|aunt|uncle|cousin|friend|best friend|dog|cat|pet)'?s (?:birthday|anniversary) would'?ve been\b|\bmiss(?:ing)? my (?:\w+ )?(?:mom|dad|mother|father|grandma|grandpa|grandmother|grandfather|nana|brother|sister|aunt|uncle|cousin|friend|best friend|dog|cat|pet) so\b/i;
// a food constraint said earlier in the call (ctx-vegan-sister 3/5: egg, cheese and fish sauce in a "vegan" pick)
const CONSTRAINT = /\b(?:vegan|vegetarian|pescatarian|gluten[- ]free|dairy[- ]free|lactose[- ]intolerant|halal|kosher|keto|(?:nut|peanut|shellfish|egg|dairy|gluten) allergy|allergic to [a-z]+|(?:doesn'?t|don'?t|can'?t|won'?t) eat [a-z]+(?: [a-z]+)?|no (?:pork|beef|meat|dairy|gluten|nuts|shellfish))\b/i;
const FOOD_ASK = /\b(?:make|cook|eat|order|dinner|lunch|breakfast|brunch|recipe|snack|bake|grab food|food)\b/i;
export function constraintFrom(userText: string, history: Line[]): string | null {
  if (!FOOD_ASK.test(userText)) return null;
  for (const h of [...history.slice(-10).filter((x) => x.role === "user").map((x) => x.text), userText].reverse()) { const m = CONSTRAINT.exec(h); if (m) return m[0].toLowerCase(); }
  return null;
}

export function taskHint(userText: string, history: Line[]): string | null {
  const out: string[] = [];
  const t = userText.trim();
  // sad-grandma (attentive 2.0/5: "That's rough, I'm here" with no grandma, no birthday): a loss told plainly
  if (LOSS.test(t)) out.push("They just told you about someone they lost: name that person and the moment they mentioned, warmly, in your own words; no advice.");
  const need = constraintFrom(t, history);
  if (need) out.push(`They said "${need}" earlier: whatever you pick has to fit that, every ingredient.`);
  if (WORK.test(t)) out.push("They want you to work something out: give the real answer with the actual numbers, times or steps in order (up to four short spoken sentences), then your take.");
  if (PRONOUN_ASK.test(t) && !history.slice(-8).some((h) => h.role === "user" && PERSON.test(h.text))) {
    out.push("You don't know who they mean yet: don't guess or advise blind; ask one short question about who or what happened.");
  }
  const rep = repeatedWords(history);
  if (rep.length) out.push(`You've already said ${rep.map((w) => `"${w}"`).join(", ")} this call: say something new instead.`);
  return out.length ? out.join(" ") : null;
}
