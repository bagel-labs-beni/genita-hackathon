import {build} from 'esbuild';
import {readFileSync,writeFileSync} from 'node:fs';
await build({entryPoints:['shared/Handoff/EffectSource/native-entry.ts'],bundle:true,outfile:'shared/Handoff/handoff-effect.js',loader:{'.txt':'text'},minify:true,target:'safari18'});
const js=readFileSync('shared/Handoff/handoff-effect.js','utf8').replaceAll('</script','<\\/script');
writeFileSync('shared/Handoff/handoff-effect.html',`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1"><style>html,body{margin:0;width:100%;height:100%;overflow:hidden;background:transparent}canvas{width:100%;height:100%;display:block}</style><body><script>window.effectErrors=[];try{${js}}catch(e){window.effectErrors.push(String(e.stack||e));}</script></body>`);
