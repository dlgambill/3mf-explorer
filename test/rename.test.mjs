import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { checkPlan } from '../lib/rename.mjs';

// E1: the rename plan is rebuilt on the server, and every entry is checked
// against the file's own row before anything moves. A target outside the
// file's folder, outside a library folder, or on a protected name is refused.
const isWin = process.platform === 'win32';
const root = isWin ? 'D:\\Models' : '/models';
const j = (...p) => path.join(root, ...p);
const rootOf = p => (p.toLowerCase().startsWith(root.toLowerCase() + path.sep) ? root : undefined);
const isProtected = p => /u1_template/i.test(p);
const rows = new Map([[1, { id: 1, path: j('D', 'a.3mf') }], [2, { id: 2, path: j('D', 'b.3mf') }]]);

test('checkPlan keeps same-folder renames and refuses everything else', () => {
  const plan = [
    { id: 1, from: j('D', 'a.3mf'), to: j('D', 'Alpha.3mf'), status: 'rename' },
    { id: 2, from: j('D', 'b.3mf'), to: j('Other', 'b.3mf'), status: 'rename' },
  ];
  const { ok, refused } = checkPlan(plan, rows, { isProtected, rootOf });
  assert.deepEqual(ok.map(p => p.id), [1]);
  assert.match(refused[0].error, /folder/);
});

test('checkPlan refuses a from that is not the row path, a protected target, and an unknown id', () => {
  const plan = [
    { id: 1, from: j('Elsewhere', 'x.3mf'), to: j('D', 'x2.3mf'), status: 'rename' },
    { id: 2, from: j('D', 'b.3mf'), to: j('D', 'u1_template.3mf'), status: 'rename' },
    { id: 99, from: j('D', 'z.3mf'), to: j('D', 'zz.3mf'), status: 'rename' },
  ];
  const { ok, refused } = checkPlan(plan, rows, { isProtected, rootOf });
  assert.equal(ok.length, 0);
  assert.equal(refused.length, 3);
  assert.match(refused[1].error, /protected/);
});

test('checkPlan refuses a target outside every library folder', () => {
  const outside = isWin ? 'C:\\Windows' : '/etc';
  const r = new Map([[5, { id: 5, path: path.join(outside, 'a.3mf') }]]);
  const plan = [{ id: 5, from: path.join(outside, 'a.3mf'), to: path.join(outside, 'b.3mf'), status: 'rename' }];
  const { ok, refused } = checkPlan(plan, r, { isProtected, rootOf });
  assert.equal(ok.length, 0);
  assert.match(refused[0].error, /library folder/);
});
