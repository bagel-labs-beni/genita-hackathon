import { evaluateMemory } from "../evals/memory/runner.ts";
const results = await evaluateMemory();
for (const result of results) console.log(JSON.stringify(result));
const passed = results.filter((r) => r.pass).length;
console.log(`offline memory fixtures: ${passed}/${results.length}; deleted resurfaced: ${results.reduce((n, r) => n + r.deletedResurfaced, 0)}`);
if (passed !== results.length) process.exitCode = 1;
