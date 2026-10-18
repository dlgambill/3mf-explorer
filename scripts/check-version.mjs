#!/usr/bin/env node
// F10 (1.7.1): a tag build fails unless the tag, package.json and the first
// "## " heading in CHANGELOG.md all name the same version.
//
//   node scripts/check-version.mjs v1.7.1                  check against this repo
//   node scripts/check-version.mjs v1.7.1 pkg.json CL.md   other files (tests)
//
// Exit 0 when all three agree, 1 with the mismatch on stderr otherwise.
// checkVersion() is exported so the test can call it without a process.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function firstHeadingVersion(changelog) {
  const m = changelog.match(/^## +(?:v)?(\d+\.\d+\.\d+)\b/m);
  return m ? m[1] : null;
}

export function checkVersion(tag, pkgText, changelogText) {
  const t = String(tag || '').trim().match(/^v?(\d+\.\d+\.\d+)$/);
  if (!t) return { ok: false, error: `tag "${tag}" is not vX.Y.Z` };
  const want = t[1];
  let pkgVersion;
  try { pkgVersion = JSON.parse(pkgText).version; } catch (e) { return { ok: false, error: 'package.json: ' + e.message }; }
  const clVersion = firstHeadingVersion(changelogText);
  const problems = [];
  if (pkgVersion !== want) problems.push(`package.json says ${pkgVersion}`);
  if (clVersion !== want) problems.push(`CHANGELOG.md's first heading says ${clVersion || '(none)'}`);
  return problems.length
    ? { ok: false, error: `tag ${tag} is ${want} but ${problems.join(' and ')}` }
    : { ok: true, version: want };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [tag, pkgFile = path.join(ROOT, 'package.json'), clFile = path.join(ROOT, 'CHANGELOG.md')] = process.argv.slice(2);
  if (!tag) { console.error('usage: node scripts/check-version.mjs vX.Y.Z [package.json] [CHANGELOG.md]'); process.exit(2); }
  const r = checkVersion(tag, fs.readFileSync(pkgFile, 'utf8'), fs.readFileSync(clFile, 'utf8'));
  if (!r.ok) { console.error('version check failed: ' + r.error); process.exit(1); }
  console.log('version check ok: ' + r.version);
}
