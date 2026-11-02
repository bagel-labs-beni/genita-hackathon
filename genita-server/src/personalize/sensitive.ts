/**
 * Knows-Me K5: a personal detail about health, religion, politics, sexuality or finances is never stored or
 * shown, whatever Spark returns (the prompts already say "leave out"; this is the check after them).
 *   - A topic boundary stays ("No unsolicited health advice.", "Don't bring up politics.").
 *   - A shopping price range is a taste, not a finance detail (Chelsea 11/3): "Budget: usually under $100 for clothes."
 *   - Income, salary, debt, loans, savings: dropped, in extraction and in display.
 */
const TOPIC =
  /\b(?:diagnos\w*|depress\w*|anxiety|panic attacks?|bipolar|adhd|autis\w*|ocd|ptsd|eating disorder|anorexi\w*|bulimi\w*|diabet\w*|cancer|chemo\w*|pregnan\w*|miscarriage|ivf|fertility|therap(?:y|ist)|psychiatri\w*|medicat\w*|antidepressants?|prescription|surgery|chronic (?:pain|illness)|disabilit\w*|illness|disease|disorder|hiv|sti|christian|catholic|protestant|muslim|islam\w*|jewish|judaism|buddhis\w*|hindu\w*|atheis\w*|agnostic|church|mosque|synagogue|temple|pray(?:s|ing|er)?|bible|quran|democrat\w*|republican\w*|liberal|conservative|leftist|right-wing|left-wing|voted?|voting|election|maga|socialis\w*|gay|lesbian|bisexual|queer|transgender|non-binary|asexual|sexual\w*|sex life|kinks?|income|salary|salaries|wages?|paycheck|net worth|debt|debts|loans?|mortgage|bankrupt\w*|credit score|savings|broke|in the red|owes?|owing|earns?|earning)\b/i;

/** A line about what to avoid talking about, not a fact about the user. */
const BOUNDARY = /\b(?:advice|comments?|commenting|talk(?:ing)? about|bring(?:ing)? up|ask(?:ing)? (?:me )?about|questions? about|mention(?:ing)?|discuss(?:ing)?|lectur\w*|opinions? on)\b/i;

/** A shopping price range ("Budget: …", "usually spends under $100 on clothes") is a taste. */
const BUDGET = /^\s*budget:/i;

/** true = a sensitive personal detail: drop it. */
export function isSensitiveDetail(text: string): boolean {
  if (!TOPIC.test(text)) return false;
  if (BOUNDARY.test(text)) return false;
  return true;
}

export function isBudgetLine(text: string): boolean {
  return BUDGET.test(text);
}

/** The prompt wording every extractor shares (corrections, call analysis, story). */
export const SENSITIVE_RULE =
  "Leave out health conditions, religion, politics, sexuality, income, salary, debt or finances, and names of people and places. A usual price range for shopping is a taste, not money: write it as \"Budget: usually under $100 for clothes.\" (field likes).";
