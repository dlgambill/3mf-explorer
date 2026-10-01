import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { normExts, walk, EXTS } from '../lib/scan.mjs';

test('normExts keeps known types, fixes case and missing dots', () => {
  assert.deepEqual([...normExts(['3MF', '.Stl'])].sort(), ['.3mf', '.stl']);
});

test('normExts drops unknown types and falls back to all when nothing is left', () => {
  assert.deepEqual([...normExts(['.step', 'gcode'])].sort(), [...EXTS].sort());
  assert.deepEqual([...normExts(undefined)].sort(), [...EXTS].sort());
  assert.deepEqual([...normExts([])].sort(), [...EXTS].sort());
});

test('walk only yields the chosen file types', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), '3mfx-types-'));
  try {
    fs.mkdirSync(path.join(dir, 'sub'));
    for (const f of ['a.3mf', 'b.STL', 'sub/c.obj', 'sub/d.3mf', 'notes.txt'])
      fs.writeFileSync(path.join(dir, f), 'x');
    const names = (set) => [...walk(dir, 0, set)].map(p => path.basename(p)).sort();
    assert.deepEqual(names(normExts(['.3mf'])), ['a.3mf', 'd.3mf']);
    assert.deepEqual(names(normExts(['.stl', '.obj'])), ['b.STL', 'c.obj']);
    assert.deepEqual(names(EXTS), ['a.3mf', 'b.STL', 'c.obj', 'd.3mf']);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
