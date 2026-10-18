import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { checkVersion } from '../scripts/check-version.mjs';

// Sprint 4 (1.7.1): F10 - the CI workflow and the tag/version check it runs.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'xsprint4ci-'));
assert.ok(!/^x:/i.test(tmp), 'tests must never run on X:');
const read = p => fs.readFileSync(path.join(REPO, p), 'utf8');
// ---- F10: version check + workflow ----
test('F10: checkVersion wants the tag, package.json and the first CHANGELOG heading to agree', () => {
  const pkg = JSON.stringify({ version: '1.7.1' });
  assert.deepEqual(checkVersion('v1.7.1', pkg, '# Changelog\n\n## 1.7.1 - things\n\n## 1.7.0 - older\n'), { ok: true, version: '1.7.1' });
  assert.match(checkVersion('v1.7.2', pkg, '## 1.7.1 - x').error, /package\.json says 1\.7\.1 and CHANGELOG\.md's first heading says 1\.7\.1/);
  assert.match(checkVersion('v1.7.1', pkg, '## 1.7.0 - x').error, /CHANGELOG\.md's first heading says 1\.7\.0/);
  assert.match(checkVersion('1.7', pkg, '## 1.7.1').error, /not vX\.Y\.Z/);
  assert.match(checkVersion('v1.7.1', pkg, 'no headings').error, /\(none\)/);
});
test('F10: the script exits 1 on a mismatch and 0 on a match', () => {
  const p = path.join(tmp, 'v-pkg.json'), c = path.join(tmp, 'v-cl.md');
  fs.writeFileSync(p, '{"version":"2.0.0"}');
  fs.writeFileSync(c, '# Changelog\n\n## 2.0.0 - big\n');
  const script = path.join(REPO, 'scripts', 'check-version.mjs');
  const ok = spawnSync(process.execPath, [script, 'v2.0.0', p, c], { encoding: 'utf8' });
  assert.equal(ok.status, 0, ok.stderr);
  const bad = spawnSync(process.execPath, [script, 'v2.0.1', p, c], { encoding: 'utf8' });
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /tag v2\.0\.1 is 2\.0\.1 but package\.json says 2\.0\.0/);
});
test('F10: the workflow runs npm ci and node --test on ubuntu and windows with Node 22, and checks tags', () => {
  const y = read('.github/workflows/ci.yml');
  assert.match(y, /ubuntu-latest, windows-latest/);
  assert.match(y, /node-version: 22/);
  assert.match(y, /run: npm ci/);
  assert.match(y, /run: node --test/);
  assert.match(y, /pull_request:/);
  assert.match(y, /tags: \['v\*'\]/);
  assert.match(y, /startsWith\(github\.ref, 'refs\/tags\/v'\)/);
  assert.match(y, /scripts\/check-version\.mjs/);
});

