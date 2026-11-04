#!/usr/bin/env node
/**
 * GATE-I forbidden-word checker.
 *
 * This scans tracked text files only, skipping files over 2 MiB and files with
 * a NUL byte in their first 8 KiB. The checker and .gate-i-allow are excluded
 * so their pattern definitions and allowlist entries cannot report themselves.
 * A matching documentation line is allowed when it says "not used", "does not
 * call", or "never calls". Other exceptions belong in .gate-i-allow as
 * path-glob<TAB>pattern<TAB>reason; both * and ** path globs are supported.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

process.stdout.on('error', (error) => {
  if (error.code === 'EPIPE') process.exit(0);
  throw error;
});

const MAX_FILE_BYTES = 2 * 1024 * 1024;
const BINARY_PROBE_BYTES = 8 * 1024;
const SELF_EXCLUDED_PATHS = new Set([
  '.gate-i-allow',
  'scripts/gate-i-words.mjs',
]);
const DOCUMENTATION_EXCEPTION = /\b(?:not used|does not call|never calls)\b/i;
// Base64 so this public file does not itself contain the internal names it guards against.
// Each entry: [label, regex source], both base64. Decode to read: node -e "console.log(Buffer.from('…','base64').toString())"
const ENCODED_PATTERNS = [
  ['ZWxldmVubGFicw==', 'ZWxldmVubGFicw=='],
  ['ZmFsLmFp', 'ZmFsXC5haQ=='],
  ['ZmFsLWFp', 'ZmFsLWFp'],
  ['RkFMX0tFWQ==', 'RkFMX0tFWQ=='],
  ['cGV0ZXI=', 'XGJwZXRlclxi'],
  ['UG9ydGVkIGZyb20gc3R1ZGlvLWJlbmk=', 'UG9ydGVkIGZyb20gc3R1ZGlvLWJlbmk='],
  ['YmVuaS1vcmlnaW5hbA==', 'YmVuaS1vcmlnaW5hbA=='],
  ['L1VzZXJzLw==', 'XC9Vc2Vyc1wv'],
  ['c3R1ZGlvLWJlbmk=', 'c3R1ZGlvLWJlbmk='],
  ['YWx0ZXJpbQ==', 'YWx0ZXJpbQ=='],
  ['dmVuZG9yL2Jlbmk=', 'dmVuZG9yXC9iZW5p'],
  ['cGV0ZXItZW5naW5l', 'cGV0ZXItZW5naW5l'],
  ['a2xpbmc=', 'a2xpbmc='],
  ['bWluaW1heA==', 'bWluaW1heA=='],
  ['Z3B0LWltYWdl', 'Z3B0LWltYWdl'],
];
const decode = (value) => Buffer.from(value, 'base64').toString('utf8');
// Home paths are matched case-sensitively: lowercase `/users/` is an ordinary URL path segment.
const CASE_SENSITIVE = new Set(['/Users/']);
const FORBIDDEN_PATTERNS = ENCODED_PATTERNS.map(([label, source]) => ({ label: decode(label), expression: new RegExp(decode(source), CASE_SENSITIVE.has(decode(label)) ? '' : 'i') }));

function runGit(args, options = {}) {
  return execFileSync('git', args, { encoding: options.encoding ?? 'utf8', maxBuffer: 1024 * 1024 * 1024 }); // batch trains diff hundreds of files (ENOBUFS at the 1 MB default)
}

function trackedFiles() {
  const output = runGit(['ls-files', '-z'], { encoding: 'buffer' });
  return output
    .toString('utf8')
    .split('\0')
    .filter(Boolean);
}

function globToRegExp(glob) {
  let source = '^';
  for (let index = 0; index < glob.length; index += 1) {
    const character = glob[index];
    if (character === '*') {
      if (glob[index + 1] === '*') {
        if (glob[index + 2] === '/') {
          source += '(?:.*/)?';
          index += 2;
        } else {
          source += '.*';
          index += 1;
        }
      } else {
        source += '[^/]*';
      }
    } else if ('\\^$+?.()|{}[]'.includes(character)) {
      source += `\\${character}`;
    } else {
      source += character;
    }
  }
  return new RegExp(`${source}$`);
}

function loadAllowlist() {
  const allowlistPath = '.gate-i-allow';
  if (!fs.existsSync(allowlistPath)) return [];

  return fs.readFileSync(allowlistPath, 'utf8')
    .split(/\r?\n/)
    .filter((line) => line.trim() && !line.trimStart().startsWith('#'))
    .map((line, index) => {
      const [pathGlob, pattern, reason] = line.split('\t');
      if (!pathGlob || !pattern || !reason) {
        throw new Error(`Invalid .gate-i-allow line ${index + 1}: expected path-glob<TAB>pattern<TAB>reason`);
      }
      return {
        pathGlob,
        pattern: pattern.toLowerCase(),
        reason,
        matchesPath: globToRegExp(pathGlob),
      };
    });
}

function allowanceFor(filePath, pattern, line, allowlist) {
  if (DOCUMENTATION_EXCEPTION.test(line)) {
    return 'documentation wording';
  }

  const matchingEntry = allowlist.find((entry) => (
    entry.matchesPath.test(filePath) && entry.pattern === pattern.label.toLowerCase()
  ));
  return matchingEntry?.reason ?? null;
}

function fileSkipReason(filePath) {
  if (SELF_EXCLUDED_PATHS.has(filePath)) return 'excluded';
  const stat = fs.statSync(filePath);
  if (stat.size > MAX_FILE_BYTES) return 'large';
  const probe = Buffer.alloc(Math.min(BINARY_PROBE_BYTES, stat.size));
  const descriptor = fs.openSync(filePath, 'r');
  try {
    fs.readSync(descriptor, probe, 0, probe.length, 0);
  } finally {
    fs.closeSync(descriptor);
  }
  return probe.includes(0) ? 'binary' : null;
}

function matchLine(filePath, lineNumber, line, allowlist) {
  return FORBIDDEN_PATTERNS
    .filter((pattern) => pattern.expression.test(line))
    .map((pattern) => ({
      path: filePath,
      line: lineNumber,
      pattern: pattern.label,
      text: line.trim().slice(0, 120),
      allowed: Boolean(allowanceFor(filePath, pattern, line, allowlist)),
      allowance: allowanceFor(filePath, pattern, line, allowlist),
    }));
}

function fullScan(allowlist) {
  const findings = [];
  const skipped = { binary: 0, large: 0, excluded: 0 };
  let scannedFiles = 0;

  for (const filePath of trackedFiles()) {
    const skipReason = fileSkipReason(filePath);
    if (skipReason) {
      skipped[skipReason] += 1;
      continue;
    }
    scannedFiles += 1;
    const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);
    lines.forEach((line, index) => findings.push(...matchLine(filePath, index + 1, line, allowlist)));
  }

  return { findings, scannedFiles, skipped };
}

function addedLines(baseRef) {
  const changedFiles = runGit(['diff', '--name-only', '-z', '--diff-filter=AM', `${baseRef}...HEAD`], { encoding: 'buffer' })
    .toString('utf8')
    .split('\0')
    .filter(Boolean);
  const eligibleFiles = new Set();
  const skipped = { binary: 0, large: 0, excluded: 0 };

  for (const filePath of changedFiles) {
    const skipReason = fileSkipReason(filePath);
    if (skipReason) skipped[skipReason] += 1;
    else eligibleFiles.add(filePath);
  }

  const output = runGit([
    'diff', '--no-ext-diff', '--unified=0', '--diff-filter=AM', `${baseRef}...HEAD`, '--',
  ]);
  const records = [];
  let currentPath = null;
  let nextLine = null;

  for (const diffLine of output.split('\n')) {
    const pathMatch = diffLine.match(/^\+\+\+ b\/(.*)$/);
    if (pathMatch) {
      currentPath = pathMatch[1];
      continue;
    }
    const hunkMatch = diffLine.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
    if (hunkMatch) {
      nextLine = Number(hunkMatch[1]);
      continue;
    }
    if (currentPath && nextLine !== null && diffLine.startsWith('+') && !diffLine.startsWith('+++')) {
      if (eligibleFiles.has(currentPath)) {
        records.push({ path: currentPath, line: nextLine, text: diffLine.slice(1) });
      }
      nextLine += 1;
    }
  }

  return { records, scannedFiles: eligibleFiles.size, skipped };
}

function diffScan(baseRef, allowlist) {
  const { records, scannedFiles, skipped } = addedLines(baseRef);
  return {
    findings: records.flatMap((record) => matchLine(record.path, record.line, record.text, allowlist)),
    scannedFiles,
    skipped,
  };
}

function summarize(mode, result) {
  const patternCounts = Object.fromEntries(FORBIDDEN_PATTERNS.map(({ label }) => [label, {
    hits: 0,
    failures: 0,
    allowed: 0,
  }]));
  for (const finding of result.findings) {
    const counts = patternCounts[finding.pattern];
    counts.hits += 1;
    counts[finding.allowed ? 'allowed' : 'failures'] += 1;
  }
  const allowed = result.findings.filter((finding) => finding.allowed).length;
  return {
    mode,
    summary: {
      scannedFiles: result.scannedFiles,
      skipped: result.skipped,
      hits: result.findings.length,
      failures: result.findings.length - allowed,
      allowed,
    },
    patterns: patternCounts,
    findings: result.findings,
  };
}

function printText(report) {
  for (const finding of report.findings) {
    const allowance = finding.allowed ? ` (allowed: ${finding.allowance})` : '';
    process.stdout.write(`${finding.path}:${finding.line}: ${finding.pattern}${allowance}: ${finding.text}\n`);
  }
  const { summary } = report;
  process.stdout.write(
    `GATE-I summary: ${summary.failures} failing, ${summary.allowed} allowed, ${summary.hits} hits; `
      + `${summary.scannedFiles} files scanned; ${summary.skipped.binary} binary, ${summary.skipped.large} large, `
      + `${summary.skipped.excluded} self/allowlist excluded.\n`,
  );
  for (const [pattern, counts] of Object.entries(report.patterns)) {
    process.stdout.write(`${pattern}: ${counts.hits} hits (${counts.failures} failing, ${counts.allowed} allowed)\n`);
  }
}

function parseArguments(argumentsList) {
  let json = false;
  let baseRef = null;
  for (let index = 0; index < argumentsList.length; index += 1) {
    const argument = argumentsList[index];
    if (argument === '--json') json = true;
    else if (argument === '--diff') {
      baseRef = argumentsList[index + 1];
      if (!baseRef) throw new Error('--diff requires a base ref');
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  return { json, baseRef };
}

function main() {
  const { json, baseRef } = parseArguments(process.argv.slice(2));
  const allowlist = loadAllowlist();
  const result = baseRef ? diffScan(baseRef, allowlist) : fullScan(allowlist);
  const report = summarize(baseRef ? 'diff' : 'full', result);
  if (json) process.stdout.write(`${JSON.stringify(report)}\n`);
  else printText(report);
  process.exitCode = report.summary.failures === 0 ? 0 : 1;
}

main();
