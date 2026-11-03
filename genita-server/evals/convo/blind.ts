/** Blind before/after sheet for Chelsea + judge-vs-human agreement. Pure builders; run.ts does the I/O. */
import { mulberry32, seededShuffle } from "./stats.ts";
import { transcriptText, type Report } from "./run.ts";

export type Side = { label: string; runIndex: number };
export type BlindKey = { seed: number; labels: [string, string]; pairs: { scenarioId: string; A: Side; B: Side }[] };
export type BlindAnswers = { pairs: Record<string, { choice: "A" | "B" | "same"; human?: number; fun?: number }> };

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

type R = Pick<Report, "label" | "scenarios">;

/** Shows ONE run per side per scenario (seeded pick), positions shuffled so A is not always "before". */
export function buildBlind(a: R, b: R, seed = 1): { html: string; key: BlindKey } {
  const rng = mulberry32(seed);
  const ids = seededShuffle(a.scenarios.map((s) => s.id).filter((id) => b.scenarios.some((s) => s.id === id)), seed);
  const pairs: BlindKey["pairs"] = [];
  const cards: { id: string; title: string; A: string; B: string }[] = [];
  for (const id of ids) {
    const sa = a.scenarios.find((s) => s.id === id)!, sb = b.scenarios.find((s) => s.id === id)!;
    if (!sa.runs.length || !sb.runs.length) continue;
    const ra = Math.floor(rng() * sa.runs.length), rb = Math.floor(rng() * sb.runs.length);
    const swap = rng() < 0.5;
    const x: Side = { label: a.label, runIndex: ra }, y: Side = { label: b.label, runIndex: rb };
    const tx = transcriptText(sa.runs[ra].steps as never, sa.runs[ra].prior), ty = transcriptText(sb.runs[rb].steps as never, sb.runs[rb].prior);
    const [A, B] = swap ? [y, x] : [x, y];
    pairs.push({ scenarioId: id, A, B });
    cards.push({ id, title: sa.title, A: swap ? ty : tx, B: swap ? tx : ty });
  }
  const key: BlindKey = { seed, labels: [a.label, b.label], pairs };
  return { html: render(cards), key };
}

function render(cards: { id: string; title: string; A: string; B: string }[]): string {
  const body = cards.map((c, i) => `<section class="card" data-id="${esc(c.id)}">
<h2>${i + 1}. ${esc(c.title)}</h2>
<div class="cols"><div><h3>A</h3><pre>${esc(c.A)}</pre></div><div><h3>B</h3><pre>${esc(c.B)}</pre></div></div>
<div class="row choice"><label><input type="radio" name="c-${i}" value="A"> A가 더 좋아</label><label><input type="radio" name="c-${i}" value="B"> B가 더 좋아</label><label><input type="radio" name="c-${i}" value="same"> 비슷해</label></div>
<div class="row"><label>더 사람 같음 (1-5): <input type="range" min="1" max="5" step="1" value="3" data-k="human"><b class="v">3</b></label><label>더 재밌음 (1-5): <input type="range" min="1" max="5" step="1" value="3" data-k="fun"><b class="v">3</b></label></div>
</section>`).join("\n");
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>블라인드 비교</title>
<style>:root{--bg:#fff;--fg:#1a1a1a;--card:#f5f5f7;--bd:#d8d8de}@media(prefers-color-scheme:dark){:root{--bg:#111;--fg:#eee;--card:#1c1c20;--bd:#333}}
body{background:var(--bg);color:var(--fg);font:15px/1.5 -apple-system,system-ui,sans-serif;margin:0 auto;max-width:980px;padding:16px}
.card{background:var(--card);border:1px solid var(--bd);border-radius:12px;padding:14px;margin:16px 0}.cols{display:grid;grid-template-columns:1fr 1fr;gap:12px}
@media(max-width:700px){.cols{grid-template-columns:1fr}}pre{white-space:pre-wrap;word-break:break-word;font:14px/1.5 inherit;background:var(--bg);border:1px solid var(--bd);border-radius:8px;padding:10px;margin:0}
.row{display:flex;flex-wrap:wrap;gap:16px;margin-top:10px}h2{font-size:17px;margin:0 0 8px}h3{margin:0 0 4px}textarea{width:100%;height:160px;font:12px monospace}</style></head><body>
<h1>어느 쪽이 더 사람 같고 재밌어?</h1><p>20개 통화를 A/B로 비교해줘. 어느 쪽이 어느 버전인지는 몰라야 해. 답은 이 브라우저에 자동 저장돼.</p>
${body}
<h2>export</h2><p>다 끝나면 아래 JSON을 복사해서 보내줘.</p><textarea id="out" readonly></textarea>
<script>
(function(){var K="genita-blind-v1";var secs=[].slice.call(document.querySelectorAll(".card"));
function load(){try{return JSON.parse(localStorage.getItem(K)||"{}")}catch(e){return{}}}
function save(o){try{localStorage.setItem(K,JSON.stringify(o))}catch(e){}}
var st=load();
function collect(){var pairs={};secs.forEach(function(s,i){var c=s.querySelector("input[type=radio]:checked");if(!c)return;var h=s.querySelector("[data-k=human]").value,f=s.querySelector("[data-k=fun]").value;pairs[s.getAttribute("data-id")]={choice:c.value,human:+h,fun:+f}});return {pairs:pairs}}
function sync(){var o=collect();save(o);document.getElementById("out").value=JSON.stringify(o,null,2)}
secs.forEach(function(s){var p=(st.pairs||{})[s.getAttribute("data-id")];if(p){var r=s.querySelector("input[value="+p.choice+"]");if(r)r.checked=true;[["human",p.human],["fun",p.fun]].forEach(function(kv){var e=s.querySelector("[data-k="+kv[0]+"]");if(e&&kv[1]){e.value=kv[1];e.nextElementSibling.textContent=kv[1]}})}
s.addEventListener("input",function(ev){var t=ev.target;if(t.type==="range")t.nextElementSibling.textContent=t.value;sync()})});
sync();})();
</script></body></html>`;
}

type Judged = { fun: number; humanness: number };
const runScore = (r: Pick<Report, "scenarios">, id: string, idx: number): number | null => {
  const j = r.scenarios.find((s) => s.id === id)?.runs[idx]?.judge as Judged | null | undefined;
  return j ? (j.fun + j.humanness) / 2 : null;
};

/** judge pick for each shown pair: higher (fun+humanness)/2 of the two shown runs; equal = "same". */
export function agreement(ans: BlindAnswers, key: BlindKey, a: R, b: R) {
  const reps: Record<string, R> = { [a.label]: a, [b.label]: b };
  let pairs = 0, agree = 0, dPairs = 0, dAgree = 0;
  const rows: { scenarioId: string; human: string; judge: string; match: boolean }[] = [];
  for (const p of key.pairs) {
    const h = ans.pairs[p.scenarioId];
    if (!h) continue;
    const sa = runScore(reps[p.A.label], p.scenarioId, p.A.runIndex), sb = runScore(reps[p.B.label], p.scenarioId, p.B.runIndex);
    if (sa == null || sb == null) continue;
    const judge = sa > sb ? "A" : sb > sa ? "B" : "same";
    const match = judge === h.choice;
    pairs++; if (match) agree++;
    if (judge !== "same" && h.choice !== "same") { dPairs++; if (match) dAgree++; }
    rows.push({ scenarioId: p.scenarioId, human: h.choice, judge, match });
  }
  return { pairs, agree, rate: pairs ? agree / pairs : 0, decisive: { pairs: dPairs, agree: dAgree, rate: dPairs ? dAgree / dPairs : 0 }, rows };
}
