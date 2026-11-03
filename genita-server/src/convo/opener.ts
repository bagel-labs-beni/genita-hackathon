/**
 * The greeting turn's instruction block (DESIGN §4). The greeting input stays "The call just connected.
 * Greet the user."; this block tells Spark HOW to open, from what the call already knows:
 *   - first call with a profile → open like someone who already knows them (no intake, no "I hear you…")
 *   - first call, no profile    → a playful hello with a hook of the companion's own
 *   - returning with a past item → one light follow-up (the memory lane picks the item and adds its line)
 *   - returning, nothing to follow → gap-aware hello, never an invented shared past
 * Pure. Intent only, never a line to copy (studio bake-off: quoted lines come back verbatim).
 */
export type OpenerInput = {
  hasProfile: boolean;
  /** ms since the user's last message in an earlier call; null = never talked before; undefined = unknown */
  sinceLastMs?: number | null;
  /** the memory lane chose a past item for this greeting (its own line follows in the instructions) */
  hasItem: boolean;
};

const H = 3_600_000;

export function openerKind(o: OpenerInput): "first_known" | "first_new" | "followup" | "back_soon" | "back_today" | "back_days" | "known" {
  if (o.hasItem) return "followup";
  if (o.sinceLastMs === null) return o.hasProfile ? "first_known" : "first_new";
  if (o.sinceLastMs === undefined) return o.hasProfile ? "known" : "first_new";
  if (o.sinceLastMs < 2 * H) return "back_soon";
  if (o.sinceLastMs < 20 * H) return "back_today";
  return "back_days";
}

const NO_INTAKE = "Never ask what they like, what they want to talk about, or to tell you about themselves.";
const SHORT = "One or two short sentences.";

export function openerBlock(o: OpenerInput): string {
  const k = openerKind(o);
  const lines: Record<typeof k, string> = {
    first_known: `This is your very first call (nothing has happened between you yet, so no "again" or "back"), but you already know them from their profile. Open like a friend who knows them: build your first line on one thing from it (a taste, an interest, how they like to be talked to) as a guess, a tease or an opinion they can push back on, in the style the profile says they like. No "nice to meet you", never say how you know it. ${NO_INTAKE} ${SHORT}`,
    known: `Open like a friend who knows them: build your first line on one thing from their profile as a guess, a tease or an opinion, in the style it says they like. Never say how you know it. ${NO_INTAKE} ${SHORT}`,
    first_new: `This is your first call. Say hi warmly and a little playfully, with one specific thing about you (an opinion or something you're into) so they have something to bite on. Not an interview. ${SHORT}`,
    followup: `Open like a friend picking up the thread: one light, specific question about that one thing, the way a friend would ask it. No recap, no "last time", never mention notes or memory. ${SHORT}`,
    back_soon: `You talked a little while ago; this is the same conversation picking back up. A quick, casual "back" line, no fresh hello. ${SHORT}`,
    back_today: `You already talked earlier today. Greet them like they're back already, with one hook from their profile or your own mood. No "finally", don't invent anything you did together. ${SHORT}`,
    back_days: `It's been a few days. Greet them like a friend who's glad they're back, lightly, once, with one hook from their profile or your own mood. No "finally" or guilt about the gap, and don't invent anything you did together. ${SHORT}`,
  };
  return `How to open this call: ${lines[k]}`;
}
