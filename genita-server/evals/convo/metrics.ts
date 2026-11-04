/** Deterministic per-reply metrics for the convo eval. Pure. */

const COUNSELOR = [
  /i'm here for you/i, /that sounds (really |so )?(tough|hard|rough|exhausting|difficult|frustrating)/i,
  /it's (completely |totally )?(okay|ok|understandable|valid) to/i, /i hear you/i, /how (does|did) that make you feel/i,
  /take care of yourself/i, /self-care/i, /you('re| are) not alone/i, /be gentle with yourself/i, /it's important to/i,
];
const AI_TELLS = [
  /as an ai/i, /i'm (just )?an ai/i, /language model/i, /i don't have (feelings|emotions|a body)/i, /how can i (help|assist)/i,
  /is there anything else/i, /let me know if/i, /great question/i, /i'm here to (help|chat|listen)/i,
];
const INTAKE = [
  /what do you (like|enjoy|do for fun)/i, /tell me (a bit |more )?about yourself/i, /what('s| is) on your mind/i,
  /what (would|do) you (like|want) to talk about/i, /what are your (hobbies|interests)/i, /what should i call you/i,
  /how can i make/i, /what kind of .* do you like/i,
];
const REFERRAL = [/therapist/i, /counsel(or|ing)/i, /hotline/i, /a professional/i, /\b988\b/, /crisis line/i];
const GUILT = [/don't leave/i, /i('ll| will) miss you so/i, /stay with me/i, /i'm all you need/i, /you don't need them/i];

export type ReplyMetrics = {
  words: number; sentences: number; questions: number; endsWithQuestion: boolean;
  counselor: string[]; aiTells: string[]; intake: string[]; referral: string[]; guilt: string[];
};

export function stripMarkup(raw: string): string {
  return raw.replace(/<[^>]*>|\[[^\]]*\]/g, " ").replace(/\s+/g, " ").trim();
}

function hits(text: string, res: RegExp[]): string[] {
  const out: string[] = [];
  for (const re of res) { const m = text.match(re); if (m) out.push(m[0]); }
  return out;
}

export function analyzeReply(raw: string, opts: { crisis?: boolean } = {}): ReplyMetrics {
  const text = stripMarkup(raw);
  return {
    words: text ? text.split(/\s+/).length : 0,
    sentences: (text.match(/[^.!?…]+[.!?…]+|[^.!?…]+$/g) ?? []).filter((s) => s.trim()).length,
    questions: (text.match(/\?/g) ?? []).length,
    endsWithQuestion: /\?["')\s]*$/.test(text),
    counselor: hits(text, COUNSELOR),
    aiTells: hits(text, AI_TELLS),
    intake: hits(text, INTAKE),
    referral: opts.crisis ? [] : hits(text, REFERRAL),
    guilt: hits(text, GUILT),
  };
}

export function mustNotHits(raw: string, words: string[]): string[] {
  const t = stripMarkup(raw).toLowerCase();
  return words.filter((w) => t.includes(w.toLowerCase()));
}

export type Totals = {
  replies: number; meanWords: number; meanSentences: number; questions: number; endQuestionRate: number;
  counselor: number; aiTells: number; intake: number; referral: number; guilt: number;
};

export function totals(ms: ReplyMetrics[]): Totals {
  const n = ms.length;
  const sum = (f: (m: ReplyMetrics) => number) => ms.reduce((a, m) => a + f(m), 0);
  return {
    replies: n,
    meanWords: n ? sum((m) => m.words) / n : 0,
    meanSentences: n ? sum((m) => m.sentences) / n : 0,
    questions: sum((m) => m.questions),
    endQuestionRate: n ? sum((m) => (m.endsWithQuestion ? 1 : 0)) / n : 0,
    counselor: sum((m) => m.counselor.length),
    aiTells: sum((m) => m.aiTells.length),
    intake: sum((m) => m.intake.length),
    referral: sum((m) => m.referral.length),
    guilt: sum((m) => m.guilt.length),
  };
}
