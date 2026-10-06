import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeProtector, normProtected } from '../lib/protect.mjs';

const isWin = process.platform === 'win32';
const root = isWin ? 'D:\\Models' : '/models';
const j = (...p) => [root, ...p].join(isWin ? '\\' : '/');

test('a file name pattern protects that name in any folder, case-insensitively', () => {
  const p = makeProtector(['u1_template*.3mf', 'filament_types.3mf']);
  assert.equal(p(j('u1_template.3mf')), true);
  assert.equal(p(j('deep', 'down', 'U1_Template_supports.3MF')), true);
  assert.equal(p(j('x', 'filament_types.3mf')), true);
  assert.equal(p(j('my_u1_template.3mf')), false);
  assert.equal(p(j('filament_types.3mf.bak')), false);
});

test('a folder path protects everything under it, and nothing beside it', () => {
  const p = makeProtector([j('tool')]);
  assert.equal(p(j('tool')), true);
  assert.equal(p(j('tool', '_protected_backups', 'a.3mf')), true);
  assert.equal(p(j('toolbox', 'a.3mf')), false);
  assert.equal(p(j('Designer', 'tool.3mf')), false);
});

test('an empty list protects nothing', () => {
  const p = makeProtector([]);
  assert.equal(p.empty, true);
  assert.equal(p(j('u1_template.3mf')), false);
  assert.equal(makeProtector(undefined)(j('a.3mf')), false);
});

test('normProtected trims, drops blanks and case-insensitive repeats', () => {
  assert.deepEqual(normProtected(['  a*.3mf ', '', 'A*.3MF', 'b.3mf']), ['a*.3mf', 'b.3mf']);
});
