#!/usr/bin/env node
// Adds one signed DMG to the Sparkle appcast (genita-legal Pages, /mac/appcast.xml) and prunes old DMGs.
// Usage: node appcast.mjs --dir <site>/mac --dmg Genita-Mac-4121.dmg --build 4121 --version 0.1 \
//          --signature <edSignature> --length <bytes> [--base https://bagel-labs-beni.github.io/genita-legal/mac] [--keep 3] [--commit <sha>]
// Items are ones this script wrote, newest build first; DMGs no longer listed are deleted from <dir>.
import { readFileSync, writeFileSync, existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith("--") ? [...acc, [a.slice(2), all[i + 1]]] : acc), []),
);
const need = ["dir", "dmg", "build", "version", "signature", "length"];
for (const k of need) if (!args[k]) throw new Error(`missing --${k}`);
const base = (args.base ?? "https://bagel-labs-beni.github.io/genita-legal/mac").replace(/\/$/, "");
const keep = Number(args.keep ?? 3);
const build = Number(args.build);
if (!Number.isInteger(build) || build <= 0) throw new Error("--build must be a positive integer");
if (!/^[A-Za-z0-9+/=]{80,100}$/.test(args.signature)) throw new Error("--signature does not look like an EdDSA signature");
if (!/^Genita-Mac-[0-9]+\.dmg$/.test(args.dmg)) throw new Error("--dmg must be Genita-Mac-<build>.dmg");

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const file = join(args.dir, "appcast.xml");
const old = existsSync(file) ? readFileSync(file, "utf8") : "";
const items = [...old.matchAll(/<item>[\s\S]*?<\/item>/g)]
  .map((m) => ({ xml: m[0], build: Number(/<sparkle:version>(\d+)<\/sparkle:version>/.exec(m[0])?.[1] ?? 0) }))
  .filter((i) => i.build && i.build !== build);

const item = `<item>
      <title>Genita ${esc(args.version)} (${build})</title>
      <pubDate>${new Date().toUTCString()}</pubDate>
      <sparkle:version>${build}</sparkle:version>
      <sparkle:shortVersionString>${esc(args.version)}</sparkle:shortVersionString>
      <sparkle:minimumSystemVersion>15.0</sparkle:minimumSystemVersion>
      <description><![CDATA[<p>Genita for Mac, build ${build}${args.commit ? ` (${esc(args.commit.slice(0, 7))})` : ""}.</p>]]></description>
      <enclosure url="${esc(`${base}/${args.dmg}`)}" sparkle:edSignature="${esc(args.signature)}" length="${Number(args.length)}" type="application/octet-stream"/>
    </item>`;
const all = [{ xml: item, build }, ...items].sort((a, b) => b.build - a.build).slice(0, keep);

writeFileSync(
  file,
  `<?xml version="1.0" encoding="utf-8"?>
<rss version="2.0" xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle">
  <channel>
    <title>Genita for Mac</title>
    <link>${esc(`${base}/appcast.xml`)}</link>
    <language>en</language>
    ${all.map((i) => i.xml).join("\n    ")}
  </channel>
</rss>
`,
);

// DMGs no longer in the feed go away (Pages repo stays small)
const listed = new Set(all.map((i) => /url="[^"]*\/(Genita-Mac-\d+\.dmg)"/.exec(i.xml)?.[1]).filter(Boolean));
for (const f of readdirSync(args.dir)) if (/^Genita-Mac-\d+\.dmg$/.test(f) && !listed.has(f)) rmSync(join(args.dir, f));
console.log(`appcast: ${all.map((i) => i.build).join(", ")} (kept ${listed.size} DMG)`);
