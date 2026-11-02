// genita-server launcher on EC2: reads SSM Parameter Store /genita/server/* at boot
// (SecureStrings decrypted with the instance role; multi-line values such as
// APPLE_PRIVATE_KEY stay intact), puts them in process.env, then runs src/main.ts.
// Keys never touch disk or logs. Changing a parameter = `systemctl restart genita-server`.
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const path = process.env.GENITA_SSM_PATH ?? "/genita/server";
let token;
const names = [];
do {
  const args = ["ssm", "get-parameters-by-path", "--path", path, "--recursive", "--with-decryption", "--output", "json"];
  if (token) args.push("--starting-token", token);
  const page = JSON.parse(execFileSync("aws", args, { encoding: "utf8", maxBuffer: 8 << 20 }));
  for (const p of page.Parameters ?? []) {
    const name = p.Name.slice(p.Name.lastIndexOf("/") + 1);
    if (!/^[A-Z_][A-Z0-9_]*$/.test(name)) continue;
    if (process.env[name] === undefined) process.env[name] = p.Value; // unit Environment= wins
    names.push(name);
  }
  token = page.NextToken;
} while (token);
console.log(`ssm: loaded ${names.length} parameters from ${path} (${names.sort().join(", ")})`);
await import(pathToFileURL(join(process.cwd(), "src/main.ts")).href);
