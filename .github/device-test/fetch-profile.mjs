// Usage: node fetch-profile.mjs "<profile name>" <out.mobileprovision>
// Downloads the ACTIVE provisioning profile with this name from App Store Connect.
// Env: ASC_KEY_P8, ASC_KEY_ID, ASC_ISSUER_ID. Prints only the profile name and expiry.
import { createSign, createPrivateKey } from 'node:crypto';
import { writeFileSync } from 'node:fs';
const [name, out] = process.argv.slice(2);
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const now = Math.floor(Date.now() / 1000);
const head = b64({ alg: 'ES256', kid: process.env.ASC_KEY_ID, typ: 'JWT' });
const body = b64({ iss: process.env.ASC_ISSUER_ID, iat: now, exp: now + 600, aud: 'appstoreconnect-v1' });
const sig = createSign('SHA256').update(`${head}.${body}`).sign({ key: createPrivateKey(process.env.ASC_KEY_P8), dsaEncoding: 'ieee-p1363' }).toString('base64url');
const url = `https://api.appstoreconnect.apple.com/v1/profiles?filter[name]=${encodeURIComponent(name)}&filter[profileState]=ACTIVE&fields[profiles]=name,profileContent,expirationDate`;
const res = await fetch(url, { headers: { Authorization: `Bearer ${head}.${body}.${sig}` } });
if (!res.ok) { console.error(`ASC HTTP ${res.status}`); process.exit(1); }
const p = (await res.json()).data.find((d) => d.attributes.name === name);
if (!p) { console.error(`No active profile named ${name}`); process.exit(1); }
writeFileSync(out, Buffer.from(p.attributes.profileContent, 'base64'));
console.log(`Fetched ${p.attributes.name} (expires ${p.attributes.expirationDate})`);
