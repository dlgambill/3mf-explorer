import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeProtector, normProtected, BUILTIN_PROTECTED } from '../lib/protect.mjs';

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

// E5: the safety floor is code, not config. An empty, missing or damaged
// "protected" list must still protect the U1 templates and their folders.
test('an empty or missing config list still protects the built-in floor', () => {
  for (const list of [[], undefined, null, 'not a list']) {
    const p = makeProtector(list);
    assert.equal(p.configEmpty, true);
    assert.equal(p(j('u1_template.3mf')), true);
    assert.equal(p(j('Deep', 'U1_TEMPLATE_SUPPORTS.3mf')), true);
    assert.equal(p(j('filament_types.3mf')), true);
    assert.equal(p(j('_templates', 'anything.3mf')), true);
    assert.equal(p(j('sub', '_Templates', 'x', 'y.stl')), true);
    assert.equal(p(j('tool', '_protected_backups', 'a.3mf')), true);
    assert.equal(p(j('a.3mf')), false);
    assert.equal(p(j('_templates_old', 'a.3mf')), false);
    assert.equal(p(j('tool', 'a.3mf')), false);
    assert.equal(p(j('mytool', '_protected_backups', 'a.3mf')), false);
  }
});

test('BUILTIN_PROTECTED is the documented floor and config entries add to it', () => {
  assert.deepEqual(BUILTIN_PROTECTED,
    ['u1_template*.3mf', 'filament_types.3mf', '_templates/**', 'tool/_protected_backups/**']);
  const p = makeProtector(['keep*.stl']);
  assert.equal(p.configEmpty, false);
  assert.equal(p(j('keep-me.stl')), true);
  assert.equal(p(j('u1_template.3mf')), true);
});

test('normProtected trims, drops blanks and case-insensitive repeats', () => {
  assert.deepEqual(normProtected(['  a*.3mf ', '', 'A*.3MF', 'b.3mf']), ['a*.3mf', 'b.3mf']);
});
