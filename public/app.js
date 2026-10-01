const ROW = 28;
const $ = s => document.querySelector(s);
const el = (t, c, x) => { const n = document.createElement(t); if (c) n.className = c; if (x != null) n.textContent = x; return n; };

const S = {
  rows: [], view: [], dupes: [], byId: new Map(),
  sort: { key: 'name', dir: 1 },
  sel: new Set(), anchor: null,
  filters: { ext: new Set(), designer: new Set(), application: new Set(),
             root: new Set(), tag: new Set(), dupe: null },
  q: '', tab: 'files', plan: null, titlePlan: null, allTags: [],
  cur: { r: 0, c: 0 },   // keyboard cell cursor: row index into view, column index
};

const fmtSize = b => {
  if (b == null) return '';
  const u = ['B', 'KB', 'MB', 'GB']; let i = 0, n = b;
  while (n >= 1024 && i < 3) { n /= 1024; i++; }
  return (i ? n.toFixed(1) : n) + ' ' + u[i];
};
const fmtDate = ms => ms ? new Date(ms).toISOString().slice(0, 10) : '';

const api = async (p, body) => {
  const r = await fetch(p, body ? {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  } : {});
  if (!r.ok) throw new Error(await r.text());
  return r.json();
};

// `edit` marks a column you can double-click to change. Widths are pixels
// because the table is fixed-layout, which is what makes drag-resizing work.
const COLS = [
  { k: 'name',           t: 'Name',       w: 260 },
  { k: 'title',          t: 'Title',      w: 200, edit: true },
  { k: 'designer',       t: 'Designer',   w: 140, edit: true },
  { k: 'tags',           t: 'Tags',       w: 220, edit: true },
  { k: 'ext',            t: 'Type',       w: 54,  mono: true },
  { k: 'size',           t: 'Size',       w: 80,  num: true, fmt: fmtSize },
  { k: 'objects',        t: 'Obj',        w: 50,  num: true },
  { k: 'layer_height',   t: 'Layer',      w: 62,  num: true, fmt: v => v ? v + 'mm' : '' },
  { k: 'bbox',           t: 'Size (mm)',  w: 124, mono: true, muted: true },
  { k: 'folder',         t: 'Folder',     w: 160, muted: true },
  { k: 'mtime',          t: 'Modified',   w: 96,  mono: true, fmt: fmtDate },
  { k: '_dupe',          t: 'Dupe',       w: 64 },
];

const WKEY = 'colwidths.v1';
try {
  const saved = JSON.parse(localStorage.getItem(WKEY) || '{}');
  for (const c of COLS) if (saved[c.k] > 40) c.w = saved[c.k];
} catch {}
const saveWidths = () => {
  try {
    localStorage.setItem(WKEY, JSON.stringify(
      Object.fromEntries(COLS.map(c => [c.k, c.w]))));
  } catch {}
};

// ---- search ----------------------------------------------------------
// Plain words AND together. field:value narrows to one column.
// Bare -word excludes. dupe:exact / dupe:geometry / dupe:any also work.
function parseQuery(q) {
  const terms = [];
  for (const raw of q.toLowerCase().match(/(?:[^\s"]+|"[^"]*")+/g) || []) {
    const t = raw.replace(/"/g, '');
    if (!t) continue;
    const neg = t.startsWith('-');
    const body = neg ? t.slice(1) : t;
    const m = body.match(/^(\w+):(.*)$/);
    if (m && m[2]) terms.push({ field: m[1], val: m[2], neg });
    else terms.push({ field: null, val: body, neg });
  }
  return terms;
}

function matches(r, terms) {
  for (const t of terms) {
    let hit;
    if (t.field === 'dupe') {
      hit = t.val === 'any' ? !!r._dupe : r._dupe === t.val;
    } else if (t.field === 'tag') {
      hit = (r.tags || []).some(x => x.includes(t.val));
    } else if (t.field && t.field in r) {
      hit = String(r[t.field] ?? '').toLowerCase().includes(t.val);
    } else {
      hit = r._s.includes(t.val);
    }
    if (hit === t.neg) return false;
  }
  return true;
}

function passesFilters(r) {
  const f = S.filters;
  for (const k of ['ext', 'designer', 'application', 'root']) {
    if (f[k].size && !f[k].has(r[k] || '')) return false;
  }
  if (f.tag.size && !(r.tags || []).some(t => f.tag.has(t))) return false;
  if (f.dupe && r._dupe !== f.dupe) return false;
  return true;
}

function recompute() {
  const terms = parseQuery(S.q);
  S.view = S.rows.filter(r => passesFilters(r) && matches(r, terms));
  const { key, dir } = S.sort;
  const num = ['size', 'mtime', 'objects', 'plates', 'layer_height', 'vcount', 'tcount'].includes(key);
  S.view.sort((a, b) => {
    let x = a[key], y = b[key];
    if (num) { x = x ?? -1; y = y ?? -1; return (x - y) * dir; }
    x = String(x ?? '').toLowerCase(); y = String(y ?? '').toLowerCase();
    return x < y ? -dir : x > y ? dir : 0;
  });
  // the row count changes when you search or filter - keep the cursor in range
  S.cur.r = Math.max(0, Math.min(S.cur.r, S.view.length - 1));
  S.cur.c = Math.max(0, Math.min(S.cur.c, COLS.length - 1));
  renderTable();
  renderStat();
}

// ---- virtualised table -----------------------------------------------
function applyWidths() {
  const cg = $('#cg');
  cg.innerHTML = '';
  let total = 0;
  for (const c of COLS) {
    const col = document.createElement('col');
    col.style.width = c.w + 'px';
    cg.append(col);
    total += c.w;
  }
  $('#tbl').style.width = total + 'px';
}

function renderHead() {
  const tr = $('#hrow');
  tr.innerHTML = '';
  for (const c of COLS) {
    const th = el('th');
    th.append(el('span', null, c.t));
    if (S.sort.key === c.k) th.append(el('span', 'ar', S.sort.dir > 0 ? ' ▲' : ' ▼'));

    th.onclick = (e) => {
      if (e.target.classList.contains('rz')) return; // ignore the drag handle
      if (S.sort.key === c.k) S.sort.dir *= -1;
      else { S.sort.key = c.k; S.sort.dir = 1; }
      renderHead(); recompute();
    };

    // Excel-style drag handle on the right edge
    const rz = el('span', 'rz');
    rz.title = 'Drag to resize, double-click to fit';
    rz.onmousedown = (e) => {
      e.preventDefault(); e.stopPropagation();
      const startX = e.clientX, startW = c.w;
      document.body.style.cursor = 'col-resize';
      const move = ev => {
        c.w = Math.max(44, Math.round(startW + (ev.clientX - startX)));
        applyWidths();
      };
      const up = () => {
        document.body.style.cursor = '';
        removeEventListener('mousemove', move);
        removeEventListener('mouseup', up);
        saveWidths();
      };
      addEventListener('mousemove', move);
      addEventListener('mouseup', up);
    };
    // double-click the handle to size the column to its content
    rz.ondblclick = (e) => {
      e.preventDefault(); e.stopPropagation();
      const idx = COLS.indexOf(c);
      let max = c.t.length * 8 + 28;
      for (const tr2 of $('#tbody').querySelectorAll('tr[data-i]')) {
        const cell = tr2.children[idx];
        if (cell) max = Math.max(max, cell.scrollWidth + 18);
      }
      c.w = Math.min(600, Math.max(44, max));
      applyWidths(); saveWidths();
    };
    th.append(rz);
    tr.append(th);
  }
  applyWidths();
}

function renderTable() {
  const wrap = $('#tablewrap'), body = $('#tbody');
  const h = wrap.clientHeight || 600;
  const start = Math.max(0, Math.floor(wrap.scrollTop / ROW) - 8);
  const count = Math.ceil(h / ROW) + 16;
  const end = Math.min(S.view.length, start + count);

  body.innerHTML = '';
  if (start > 0) {
    const s = el('tr'); const td = el('td'); td.colSpan = COLS.length;
    td.style.height = (start * ROW) + 'px'; td.style.padding = '0'; td.style.border = '0';
    s.append(td); body.append(s);
  }
  for (let i = start; i < end; i++) {
    const r = S.view[i];
    const tr = el('tr');
    if (S.sel.has(r.id)) tr.className = 'sel';
    tr.dataset.i = i;
    for (const c of COLS) {
      let td, empty = false;
      if (c.k === '_dupe') {
        td = el('td');
        if (r._dupe) td.append(el('span', 'pill ' + (r._dupe === 'exact' ? 'dupe' : 'geo'),
          r._dupe === 'exact' ? 'exact' : 'geo'));
      } else if (c.k === 'tags') {
        td = el('td', 'cls');
        if (r.tags && r.tags.length) {
          for (const t of r.tags) {
            const chip = el('span', 'chip', t);
            chip.dataset.tag = t;   // click filters by it, see the tbody handler
            td.append(chip);
          }
        } else empty = true;
      } else {
        const v = c.fmt ? c.fmt(r[c.k]) : (r[c.k] ?? '');
        td = el('td', null, String(v));
        if (c.edit && !String(v)) empty = true;
      }
      const ci = COLS.indexOf(c);
      td.className = [td.className, c.num && 'num', c.mono && 'mono', c.muted && 'muted',
        c.edit && 'editable', c.edit && empty && 'empty-cell',
        (S.cur.r === i && S.cur.c === ci) && 'cur']
        .filter(Boolean).join(' ');
      if (c.edit) td.dataset.field = c.k;
      td.dataset.c = ci;
      tr.append(td);
    }
    body.append(tr);
  }
  if (end < S.view.length) {
    const s = el('tr'); const td = el('td'); td.colSpan = COLS.length;
    td.style.height = ((S.view.length - end) * ROW) + 'px';
    td.style.padding = '0'; td.style.border = '0';
    s.append(td); body.append(s);
  }
}

// ---- selection --------------------------------------------------------
// A finger has no Ctrl/Shift, so on a tablet a tap toggles that row in or
// out of the selection instead of replacing it - that's how several files
// get picked before "Mark for print". Mouse clicks behave exactly as before.
// Tracked from pointerdown (not the click's own pointerType) because older
// iPad Safari doesn't put pointerType on click events.
let lastPointer = 'mouse';
addEventListener('pointerdown', e => { lastPointer = e.pointerType; }, true);

function selectAt(i, ev) {
  const r = S.view[i];
  if (!r) return;
  const touch = lastPointer === 'touch';
  if (ev.shiftKey && S.anchor != null) {
    const [a, b] = S.anchor < i ? [S.anchor, i] : [i, S.anchor];
    if (!ev.ctrlKey && !ev.metaKey) S.sel.clear();
    for (let k = a; k <= b; k++) S.sel.add(S.view[k].id);
  } else if (ev.ctrlKey || ev.metaKey || touch) {
    S.sel.has(r.id) ? S.sel.delete(r.id) : S.sel.add(r.id);
    S.anchor = i;
  } else {
    S.sel.clear(); S.sel.add(r.id); S.anchor = i;
  }
  renderTable(); renderStat(); renderDetail();
}

function selectedRows() {
  return [...S.sel].map(id => S.byId.get(id)).filter(Boolean);
}

function renderStat() {
  $('#selstat').textContent =
    `${S.sel.size} selected · ${S.view.length.toLocaleString()} shown`;
}

// ---- detail -----------------------------------------------------------
function renderDetail() {
  const d = $('#detail');
  const rows = selectedRows();
  d.innerHTML = '';
  if (!rows.length) { d.append(el('div', 'empty', 'Nothing selected')); return; }
  if (rows.length > 1) {
    const bytes = rows.reduce((a, r) => a + (r.size || 0), 0);
    d.append(el('div', 't', rows.length + ' files selected'));
    d.append(el('div', 'sub', fmtSize(bytes) + ' total'));
    return;
  }
  const r = rows[0];
  if (r.thumb) {
    const img = el('img', 'thumb'); img.src = '/thumb/' + r.thumb; img.loading = 'lazy';
    d.append(img);
  }
  d.append(el('div', 't', r.title || r.name));
  d.append(el('div', 'sub', (r.designer || 'unknown designer') + ' · ' + fmtSize(r.size)));

  const kv = el('dl', 'kv');
  const put = (k, v) => { if (v != null && v !== '' ) { kv.append(el('dt', null, k), el('dd', null, String(v))); } };
  put('File', r.name);
  put('Folder', r.rel);
  put('Objects', r.objects || '');
  put('Plates', r.plates || '');
  put('Layer', r.layer_height ? r.layer_height + ' mm' : '');
  put('Nozzle', r.nozzle ? r.nozzle + ' mm' : '');
  put('Filament', r.filaments);
  put('Bounding box', r.bbox);
  put('Triangles', r.tcount ? r.tcount.toLocaleString() : '');
  put('Slicer', r.application);
  put('License', r.license);
  put('Created', r.created);
  put('SHA-256', (r.sha256 || '').slice(0, 24) + '…');
  put('Geometry', (r.geom || '').slice(0, 24) + '…');
  d.append(kv);

  if (r.description && r.description !== r.title) {
    d.append(el('div', 'sub', r.description.slice(0, 400)));
  }
  const tr = el('div', 'tagrow');
  for (const t of r.tags || []) {
    const b = el('span', 'tag', t);
    b.onclick = () => api('/api/tags', { ids: [r.id], remove: [t] })
      .then(() => { r.tags = r.tags.filter(x => x !== t); renderDetail(); buildFacets(); });
    tr.append(b);
  }
  d.append(tr);
}

// ---- filter rail -------------------------------------------------------
function buildFacets() {
  const aside = $('#filters');
  aside.innerHTML = '';
  const facet = (label, key, getter, onContext) => {
    const counts = new Map();
    for (const r of S.rows) {
      for (const v of [].concat(getter(r))) {
        if (v == null || v === '') continue;
        counts.set(v, (counts.get(v) || 0) + 1);
      }
    }
    if (!counts.size) return;
    aside.append(el('h3', null, label));
    const list = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 22);
    for (const [v, n] of list) {
      const row = el('div', 'f' + (S.filters[key].has(v) ? ' on' : ''));
      row.append(el('span', null, String(v).slice(0, 22)), el('span', 'n', n));
      row.onclick = () => {
        S.filters[key].has(v) ? S.filters[key].delete(v) : S.filters[key].add(v);
        buildFacets(); recompute();
      };
      if (onContext) row.oncontextmenu = e => { e.preventDefault(); onContext(v, n); };
      aside.append(row);
    }
  };

  aside.append(el('h3', null, 'Duplicates'));
  for (const [v, t] of [['exact', 'Byte-identical'], ['geometry', 'Same geometry']]) {
    const n = S.rows.filter(r => r._dupe === v).length;
    const row = el('div', 'f' + (S.filters.dupe === v ? ' on' : ''));
    row.append(el('span', null, t), el('span', 'n', n));
    row.onclick = () => { S.filters.dupe = S.filters.dupe === v ? null : v; buildFacets(); recompute(); };
    aside.append(row);
  }

  // right-click a tag to rename it. Renaming onto a tag that already exists
  // merges the two, which is how you clean up "pocket pal" vs "pocket pals".
  facet('Tags', 'tag', r => r.tags || [], async (tag, n) => {
    const to = prompt(
      `Rename tag "${tag}" (${n} file${n === 1 ? '' : 's'}).\n\n` +
      `Type an existing tag name to merge into it.\n` +
      `Leave blank to remove the tag from every file.`, tag);
    if (to === null) return;
    try {
      const r = await api('/api/tags/rename', { from: tag, to: to.trim() });
      toast(r.to ? `"${r.from}" merged into "${r.to}"` : `"${r.from}" removed`);
      S.filters.tag.delete(tag);
      await load();
    } catch (e) { toast(e.message, true); }
  });
  facet('Type', 'ext', r => r.ext);
  facet('Designer', 'designer', r => r.designer);
  facet('Slicer', 'application', r => (r.application || '').split('-')[0]);
  facet('Root', 'root', r => r.root);

  const clr = el('div', 'f', 'Clear all filters');
  clr.style.marginTop = '16px';
  clr.onclick = () => {
    for (const k of ['ext', 'designer', 'application', 'root', 'tag']) {
      S.filters[k].clear();
    }
    S.filters.dupe = null; buildFacets(); recompute();
  };
  aside.append(clr);
}

// ---- duplicates view ---------------------------------------------------
function renderDupes() {
  const p = $('#panel');
  p.innerHTML = '';
  if (!S.dupes.length) { p.append(el('div', 'empty', 'No duplicates found.')); return; }

  const waste = S.dupes.reduce((a, g) => a + g.wasted, 0);
  const hdr = el('div', 'sub');
  hdr.style.marginBottom = '16px';
  hdr.textContent = `${S.dupes.length} groups · ${fmtSize(waste)} recoverable if you keep one of each`;
  p.append(hdr);

  for (const g of S.dupes) {
    const box = el('div', 'grp');
    const hd = el('div', 'hd');
    hd.append(el('span', 'pill ' + (g.kind === 'exact' ? 'dupe' : 'geo'), g.kind));
    hd.append(el('strong', null, g.files[0]?.title || g.files[0]?.name || ''));
    hd.append(el('span', 'stat', `${g.count} copies · ${fmtSize(g.wasted)} recoverable`));
    const pick = el('button', 'btn', 'Select all but the first');
    pick.style.marginLeft = 'auto';
    pick.onclick = () => {
      for (const f of g.files.slice(1)) S.sel.add(f.id);
      renderStat(); renderDetail(); renderDupes();
    };
    hd.append(pick);
    box.append(hd);

    const files = el('div', 'files');
    g.files.forEach((f, i) => {
      const row = el('div', 'fl');
      row.append(el('span', i === 0 ? 'keep' : '', i === 0 ? 'keep' : (S.sel.has(f.id) ? '✓' : '·')));
      const pth = el('span', 'p', f.path);
      pth.title = f.path;
      row.append(pth, el('span', null, fmtSize(f.size)));
      row.onclick = () => {
        S.sel.has(f.id) ? S.sel.delete(f.id) : S.sel.add(f.id);
        renderStat(); renderDetail(); renderDupes();
      };
      files.append(row);
    });
    box.append(files);
    p.append(box);
  }
}

// ---- history view ------------------------------------------------------
async function renderHistory() {
  const p = $('#panel');
  p.innerHTML = '';

  function renderBatches(list, undoUrl, countLabel) {
    for (const b of list) {
      const box = el('div', 'grp');
      const hd = el('div', 'hd');
      hd.append(el('strong', null, b.batch));
      hd.append(el('span', 'stat', `${b.n} ${countLabel} · ${new Date(b.ts).toLocaleString()}`));
      if (b.undone >= b.n) hd.append(el('span', 'pill', 'undone'));
      else {
        const u = el('button', 'btn danger', 'Undo this batch');
        u.style.marginLeft = 'auto';
        u.onclick = async () => {
          const r = await api(undoUrl, { batch: b.batch });
          alert(`Reverted ${r.reverted}.` + (r.errors.length ? `\n${r.errors.length} failed.` : ''));
          await load(); renderHistory();
        };
        hd.append(u);
      }
      box.append(hd);
      p.append(box);
    }
  }

  const [renameBs, titleBs] = await Promise.all([
    api('/api/rename/batches'), api('/api/titles/clean-batches'),
  ]);

  p.append(el('div', 'sub', 'Renames'));
  if (!renameBs.length) p.append(el('div', 'empty', 'No rename batches yet.'));
  else renderBatches(renameBs, '/api/rename/undo', 'files');

  p.append(el('div', 'sub', 'Title cleanups'));
  if (!titleBs.length) p.append(el('div', 'empty', 'No title-cleanup batches yet.'));
  else renderBatches(titleBs, '/api/titles/clean-undo', 'titles');
}

// ---- settings view -----------------------------------------------------
// Which folders get indexed, and where "Move to quarantine" sends files.
// The server checks the folders exist, saves them to config.json and
// rescans. Files outside the folders drop out of the list - only the list;
// nothing on disk is touched, and titles/designers/tags are kept.
const errText = e => { try { return JSON.parse(e.message).error || e.message; } catch { return e.message; } };

async function renderSettings() {
  const p = $('#panel');
  p.innerHTML = '';
  let s;
  try { s = await api('/api/settings'); }
  catch (e) { p.append(el('div', 'empty', 'Could not load settings: ' + errText(e))); return; }
  if (S.tab !== 'settings') return;

  const box = (title, hint, field) => {
    const g = el('div', 'grp');
    const hd = el('div', 'hd');
    hd.append(el('strong', null, title));
    const body = el('div', 'body');
    body.append(el('div', 'hint', hint), field);
    g.append(hd, body);
    return g;
  };

  const roots = el('textarea');
  roots.rows = Math.max(3, s.roots.length + 1);
  roots.spellcheck = false;
  roots.value = s.roots.join('\n');
  roots.placeholder = 'X:\\_MMF';

  const types = el('div', 'types');
  const typeBoxes = (s.allFileTypes || ['.3mf', '.stl', '.obj']).map(ext => {
    const lab = el('label');
    const cb = el('input');
    cb.type = 'checkbox';
    cb.value = ext;
    cb.checked = (s.fileTypes || []).includes(ext);
    lab.append(cb, document.createTextNode(ext.slice(1).toUpperCase()));
    types.append(lab);
    return cb;
  });

  const quar = el('input');
  quar.type = 'text';
  quar.spellcheck = false;
  quar.value = s.quarantine;
  quar.placeholder = s.quarantineDefault;

  const save = el('button', 'btn primary', 'Save and rescan');
  save.onclick = async () => {
    save.disabled = true;
    try {
      const fileTypes = typeBoxes.filter(cb => cb.checked).map(cb => cb.value);
      if (!fileTypes.length) return toast('Pick at least one file type.', true);
      const r = await api('/api/settings', { roots: roots.value.split(/\r?\n/), fileTypes, quarantine: quar.value });
      toast(r.removed
        ? `Saved - ${r.removed.toLocaleString()} files no longer match and left the list`
        : 'Saved');
      setTab('files');
      await load();
      rescan(); // the server already started it; this just shows progress
    } catch (e) { toast(errText(e), true); }
    finally { save.disabled = false; }
  };
  const actions = el('div', 'row');
  actions.append(save);

  const wrap = el('div', 'settings');
  wrap.append(
    box('Library folders',
      'One folder per line. Only files inside these folders are indexed.', roots),
    box('File types',
      'Only these types are indexed and shown. Turning one off drops those files from the list - nothing on disk changes.', types),
    box('Quarantine folder',
      'Where "Move to quarantine" puts files. Leave blank to use ' + s.quarantineDefault + '.', quar),
    actions);
  p.append(wrap);
}

// ---- rename ------------------------------------------------------------
function showPlan(plan, heading) {
  S.plan = plan;
  setTab('files');
  const p = $('#panel');
  $('#tbl').classList.add('hidden');
  p.classList.remove('hidden');
  p.innerHTML = '';

  const changing = plan.filter(x => x.status !== 'unchanged').length;
  const bad = plan.filter(x => x.status === 'collision').length;
  const hd = el('div', 'sub');
  hd.style.marginBottom = '12px';
  hd.textContent = (heading ? heading + ' · ' : '') +
    `${changing} of ${plan.length} would change` + (bad ? ` · ${bad} unresolvable` : '');
  p.append(hd);

  const box = el('div', 'rp');
  for (const x of plan) {
    const d = el('div');
    const to = x.to.split(/[\\/]/).pop();
    const from = x.from.split(/[\\/]/).pop();
    d.append(el('span', 'from', from), document.createTextNode('  →  '));
    d.append(el('span', x.status === 'collision' ? 'bad' : x.status === 'unchanged' ? 'same' : 'to', to));
    if (x.status === 'deconflicted') d.append(el('span', 'pill', ' de-conflicted'));
    // why the name had to grow: the tag was pulled in to break a clash
    if (x.why && x.status === 'rename') {
      d.append(el('span', 'pill', ' ' + x.why));
    }
    box.append(d);
  }
  p.append(box);
  $('#applyren').classList.remove('hidden');
}

async function previewRename() {
  const ids = [...S.sel];
  if (!ids.length) return alert('Select some files first.');
  showPlan(await api('/api/rename/plan', { ids, pattern: $('#pattern').value }), 'Pattern');
}

async function previewTitles() {
  const ids = [...S.sel];
  if (!ids.length) return alert('Select some files first.');
  try {
    showPlan(await api('/api/rename/plan-titles', { ids }), 'Titles → filenames');
  } catch (e) { toast(e.message, true); }
}

async function applyRename() {
  if (!S.plan) return;
  const changing = S.plan.filter(x => x.status !== 'unchanged' && x.status !== 'collision');
  if (!changing.length) return alert('Nothing to do.');
  if (!confirm(`Rename ${changing.length} files?\n\nThis is undoable from the History tab.`)) return;
  const r = await api('/api/rename/apply', { plan: S.plan });
  alert(`Renamed ${r.renamed} files.` + (r.errors.length ? `\n${r.errors.length} failed.` : ''));
  S.plan = null;
  $('#applyren').classList.add('hidden');
  await load();
  setTab('files');
}

// ---- clean titles --------------------------------------------------------
// Same plan/apply/undo shape as rename above, but the rows read {before,
// after, note} instead of {from, to, status} - note carries why a trailing
// number was deliberately left in place (it would've collided with another
// file in this same batch).
function showTitlePlan(plan) {
  S.titlePlan = plan;
  S.plan = null;
  setTab('files');
  const p = $('#panel');
  $('#tbl').classList.add('hidden');
  p.classList.remove('hidden');
  p.innerHTML = '';

  const changing = plan.filter(x => x.changed).length;
  const kept = plan.filter(x => x.note).length;
  const hd = el('div', 'sub');
  hd.style.marginBottom = '12px';
  hd.textContent = `Clean titles · ${changing} of ${plan.length} would change` +
    (kept ? ` · ${kept} kept a number to stay unique` : '');
  p.append(hd);

  const box = el('div', 'rp');
  for (const x of plan) {
    if (!x.changed) continue;
    const d = el('div');
    d.append(el('span', 'from', x.before), document.createTextNode('  →  '));
    d.append(el('span', 'to', x.after));
    box.append(d);
  }
  for (const x of plan) {
    if (!x.note) continue;
    const d = el('div');
    d.append(el('span', 'same', x.before), el('span', 'pill', ' ' + x.note));
    box.append(d);
  }
  if (!changing) box.append(el('div', 'empty', 'Nothing to clean in this selection.'));
  p.append(box);
  $('#applyclean').classList.remove('hidden');
  $('#applyren').classList.add('hidden');
}

async function previewCleanTitles() {
  const ids = [...S.sel];
  if (!ids.length) return alert('Select some files first.');
  const words = ($('#cleanwords').value || '').split(',').map(s => s.trim()).filter(Boolean);
  try {
    showTitlePlan(await api('/api/titles/clean-plan', { ids, words }));
  } catch (e) { toast(e.message, true); }
}

async function applyCleanTitles() {
  if (!S.titlePlan) return;
  const changing = S.titlePlan.filter(x => x.changed);
  if (!changing.length) return alert('Nothing to do.');
  if (!confirm(`Clean ${changing.length} titles?\n\nThis only changes the Title field - ` +
    `no file on disk is touched. Undoable from the History tab.`)) return;
  const items = changing.map(x => ({ id: x.id, title: x.after }));
  const r = await api('/api/titles/clean-apply', { items });
  alert(`Updated ${r.updated} titles.` + (r.errors.length ? `\n${r.errors.length} failed.` : ''));
  S.titlePlan = null;
  $('#applyclean').classList.add('hidden');
  await load();
  setTab('files');
}

// ---- scanning ----------------------------------------------------------
async function rescan() {
  await api('/api/scan', {});
  $('#rescan').disabled = true;
  const tick = setInterval(async () => {
    const s = await api('/api/scan/status');
    $('#stat').textContent = !s.running ? 'finishing…'
      : s.walking || !s.total ? `finding files… ${s.total || ''}`
      : `scanning ${s.done}/${s.total} · +${s.added} new`;
    if (!s.running) {
      clearInterval(tick);
      $('#rescan').disabled = false;
      await load();
    }
  }, 700);
}

// ---- load + wiring -----------------------------------------------------
async function load() {
  const [rows, dupes, stats] = await Promise.all([
    api('/api/rows'), api('/api/dupes'), api('/api/stats'),
  ]);

  // mark duplicate membership so it is filterable and sortable like any field
  const exact = new Map(), geom = new Map();
  for (const r of rows) {
    if (r.sha256) exact.set(r.sha256, (exact.get(r.sha256) || 0) + 1);
    if (r.geom) geom.set(r.geom, (geom.get(r.geom) || 0) + 1);
  }
  for (const r of rows) {
    r._dupe = (r.sha256 && exact.get(r.sha256) > 1) ? 'exact'
            : (r.geom && geom.get(r.geom) > 1) ? 'geometry' : null;
    r._s = [r.name, r.title, r.designer, r.description, r.rel, r.folder,
            r.license, r.application, r.filaments, (r.tags || []).join(' ')]
            .join(' ').toLowerCase();
  }
  refreshTags();

  S.rows = rows;
  S.dupes = dupes;
  S.byId = new Map(rows.map(r => [r.id, r]));
  S.sel = new Set([...S.sel].filter(id => S.byId.has(id)));

  $('#stat').textContent =
    `${stats.files.toLocaleString()} files · ${fmtSize(stats.bytes)} · ${dupes.length} dupe groups`;
  buildFacets();
  recompute();
  renderDetail();
}

function setTab(name) {
  S.tab = name;
  for (const t of document.querySelectorAll('.tab')) t.classList.toggle('on', t.dataset.view === name);
  const hasPlan = !!S.plan || !!S.titlePlan;
  const showTable = name === 'files' && !hasPlan;
  $('#tbl').classList.toggle('hidden', !showTable);
  $('#panel').classList.toggle('hidden', showTable);
  if (name === 'dupes') renderDupes();
  if (name === 'history') renderHistory();
  if (name === 'settings') renderSettings();
  if (name === 'files' && !hasPlan) {
    $('#applyren').classList.add('hidden');
    $('#applyclean').classList.add('hidden');
    renderTable();
  }
}

function wire() {
  $('#q').oninput = e => { S.q = e.target.value; recompute(); };
  $('#tablewrap').onscroll = () => { if (S.tab === 'files' && !S.plan && !S.titlePlan) renderTable(); };
  $('#tbody').onclick = e => {
    // clicking a tag chip filters by that tag instead of selecting the row
    const chip = e.target.closest('span.chip[data-tag]');
    if (chip) {
      e.stopPropagation();
      const t = chip.dataset.tag;
      S.filters.tag.has(t) ? S.filters.tag.delete(t) : S.filters.tag.add(t);
      buildFacets(); recompute();
      return;
    }
    const tr = e.target.closest('tr[data-i]');
    if (tr) selectAt(+tr.dataset.i, e);
  };
  $('#tbody').ondblclick = e => {
    const tr = e.target.closest('tr[data-i]');
    if (tr) api('/api/os/reveal', { path: S.view[+tr.dataset.i].path });
  };
  for (const t of document.querySelectorAll('.tab')) {
    t.onclick = () => { S.plan = null; S.titlePlan = null; setTab(t.dataset.view); };
  }
  $('#rescan').onclick = rescan;
  $('#preview').onclick = previewRename;
  $('#applytitles').onclick = previewTitles;
  $('#applyren').onclick = applyRename;
  $('#previewclean').onclick = previewCleanTitles;
  $('#applyclean').onclick = applyCleanTitles;
  $('#reveal').onclick = () => {
    const r = selectedRows()[0];
    if (r) api('/api/os/reveal', { path: r.path });
  };

  $('#exportXlsx').onclick = () => { location.href = '/api/export/xlsx'; };

  $('#importXlsx').onclick = () => $('#importXlsxFile').click();
  $('#importXlsxFile').onchange = async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    if (!confirm(
      `Import "${file.name}"?\n\n` +
      `Title, Designer and Tags will be updated to match the sheet, and any ` +
      `row with Delete checked will be sent to the Recycle Bin.`)) return;
    try {
      const buf = await file.arrayBuffer();
      const r = await fetch('/api/import/xlsx', {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream' },
        body: buf,
      });
      if (!r.ok) throw new Error(await r.text());
      const s = await r.json();
      alert(
        `Imported ${s.total} rows (${s.skipped} skipped - not in the library).\n\n` +
        `Titles changed: ${s.titles}\n` +
        `Designers changed: ${s.designers}\n` +
        `Tags changed: ${s.tags}\n` +
        `Sent to Recycle Bin: ${s.deleted} of ${s.askedDelete} marked`);
      await load();
    } catch (err) { toast(err.message, true); }
  };

  $('#quarantine').onclick = async () => {
    const ids = [...S.sel];
    if (!ids.length) return alert('Select some files first.');
    if (!confirm(`Move ${ids.length} files to the quarantine folder?\n\n` +
                 `Nothing is deleted - they are moved so you can check before removing them.`)) return;
    const r = await api('/api/os/quarantine', { ids });
    alert(`Moved ${r.moved} files to\n${r.dest}` + (r.errors.length ? `\n\n${r.errors.length} failed.` : ''));
    S.sel.clear();
    await load();
    if (S.tab === 'dupes') renderDupes();
  };

  // "Mark for print" - tag locally + forward to the U1 Print Hub
  // (see server.mjs's /api/print-request). Tags apply even if the Hub call
  // fails, so marks are never lost to the Hub being offline - the
  // toast just says so, and re-clicking later retries the forward.
  $('#markPrint').onclick = async () => {
    const ids = [...S.sel];
    if (!ids.length) return alert('Select some files first.');
    let r;
    try { r = await api('/api/print-request', { ids }); }
    catch (e) { return toast(e.message, true); }
    for (const id of ids) {
      const row = S.byId.get(id);
      if (row && !row.tags.includes('for-print')) { row.tags.push('for-print'); row._s += ' for-print'; }
    }
    const sent = r.hub && r.hub.ok ? (r.hub.results || []).filter(x => x.ok).length : 0;
    const failed = r.hub && r.hub.ok ? (r.hub.results || []).filter(x => !x.ok) : [];
    if (r.hub && !r.hub.ok) toast(`Tagged ${r.tagged} for print - Hub not reachable (${r.hub.reason || 'not configured'})`, true);
    else if (failed.length) toast(`Tagged ${r.tagged} for print - ${sent} sent to the Hub, ${failed.length} failed (${failed[0].error || 'see server log'})`, true);
    else toast(`Marked ${r.tagged} for print - ${sent} matched on the Hub's shelf`);
    buildFacets(); renderDetail(); recompute();
  };

  $('#tagin').onkeydown = async e => {
    if (e.key !== 'Enter') return;
    const tag = e.target.value.trim().toLowerCase();
    const ids = [...S.sel];
    if (!tag || !ids.length) return;
    await api('/api/tags', { ids, add: [tag] });
    for (const id of ids) {
      const r = S.byId.get(id);
      if (r && !r.tags.includes(tag)) { r.tags.push(tag); r._s += ' ' + tag; }
    }
    e.target.value = '';
    buildFacets(); renderDetail(); recompute();
  };

  $('#theme').onclick = () => {
    const cur = document.documentElement.getAttribute('data-theme');
    const next = cur === 'light' ? '' : 'light';
    next ? document.documentElement.setAttribute('data-theme', next)
         : document.documentElement.removeAttribute('data-theme');
    try { localStorage.setItem('theme', next); } catch {}
  };

  addEventListener('keydown', e => {
    // the Settings fields are free text (paths can use / and want Ctrl+A)
    if (document.activeElement?.closest?.('.settings')) return;
    if (e.key === '/' && document.activeElement !== $('#q')) { e.preventDefault(); $('#q').focus(); }
    if (e.key === 'Escape') { $('#q').blur(); S.sel.clear(); renderTable(); renderStat(); renderDetail(); }
    if ((e.ctrlKey || e.metaKey) && e.key === 'a' && document.activeElement !== $('#q')) {
      e.preventDefault();
      for (const r of S.view) S.sel.add(r.id);
      renderTable(); renderStat(); renderDetail();
    }
  });

  addEventListener('resize', () => { if (S.tab === 'files') renderTable(); });
  try {
    if (localStorage.getItem('theme') === 'light') document.documentElement.setAttribute('data-theme', 'light');
  } catch {}
}

renderHead();
wire();
load().catch(e => { $('#stat').textContent = 'error: ' + e.message; });

// ---- toast --------------------------------------------------------------
let toastT = null;
function toast(msg, bad = false) {
  let t = $('#toast');
  if (!t) { t = el('div'); t.id = 'toast'; document.body.append(t); }
  t.className = bad ? 'bad' : '';
  t.textContent = msg;
  clearTimeout(toastT);
  toastT = setTimeout(() => t.remove(), bad ? 6000 : 3000);
}

// ---- open in a slicer ---------------------------------------------------
async function openIn(row, appName) {
  try {
    const r = await api('/api/os/open', { path: row.path, app: appName });
    toast('Opening in ' + r.app);
  } catch (e) { toast(e.message, true); }
}

// ---- delete to recycle bin ---------------------------------------------
async function recycle(ids) {
  if (!ids.length) return;
  const label = ids.length === 1
    ? S.byId.get(ids[0])?.name
    : ids.length + ' files';
  if (!confirm(`Send ${label} to the Recycle Bin?\n\nRecoverable from Windows if you change your mind.`)) return;
  try {
    const r = await api('/api/os/recycle', { ids });
    toast(`Recycled ${r.recycled} of ${r.asked}`);
    S.sel.clear();
    await load();
    if (S.tab === 'dupes') renderDupes();
  } catch (e) { toast(e.message, true); }
}

// ---- inline rename ------------------------------------------------------
function renameInline(rowIndex) {
  const row = S.view[rowIndex];
  if (!row) return;
  const tr = $(`#tbody tr[data-i="${rowIndex}"]`);
  if (!tr) return;
  const cell = tr.firstElementChild;
  const ext = row.name.includes('.') ? row.name.slice(row.name.lastIndexOf('.')) : '';
  const stem = ext ? row.name.slice(0, -ext.length) : row.name;

  cell.textContent = '';
  const inp = el('input', 'renamer');
  inp.type = 'text';
  inp.value = stem;
  cell.append(inp);
  inp.focus();
  inp.select();

  let closed = false;
  const finish = async (commit) => {
    if (closed) return;
    closed = true;
    const val = inp.value.trim();
    if (!commit || !val || val === stem) { renderTable(); return; }
    try {
      const r = await api('/api/os/renameOne', { id: row.id, name: val });
      if (r.name) { row.name = r.name; row.path = r.path; toast('Renamed to ' + r.name); }
      recompute(); renderDetail();
    } catch (e) { toast(e.message, true); renderTable(); }
  };
  inp.onkeydown = e => {
    e.stopPropagation();
    if (e.key === 'Enter') finish(true);
    if (e.key === 'Escape') finish(false);
  };
  inp.onblur = () => finish(true);
}

// ---- context menu -------------------------------------------------------
function closeMenu() { $('#menu')?.remove(); }

function showMenu(x, y, rowIndex) {
  closeMenu();
  const row = S.view[rowIndex];
  if (!row) return;
  // right-clicking outside the current selection selects just that row
  if (!S.sel.has(row.id)) { S.sel.clear(); S.sel.add(row.id); S.anchor = rowIndex; renderTable(); renderStat(); renderDetail(); }
  const ids = [...S.sel];
  const many = ids.length > 1;

  const m = el('div'); m.id = 'menu';
  const item = (label, fn, cls, disabled) => {
    const b = el('button', cls || null, label);
    if (disabled) b.disabled = true;
    else b.onclick = () => { closeMenu(); fn(); };
    m.append(b);
  };
  const sep = () => m.append(el('div', 'sep'));

  m.append(el('div', 'lbl', many ? ids.length + ' files' : row.name.slice(0, 40)));

  const apps = (S.openWith || []).filter(a => a.present);
  if (apps.length && !many) {
    for (const a of apps) item('Open in ' + a.name, () => openIn(row, a.name));
    sep();
  } else if (apps.length && many) {
    item(`Open ${ids.length} in ${apps[0].name}`, async () => {
      for (const id of ids) await openIn(S.byId.get(id), apps[0].name);
    });
    sep();
  }

  item('Rename…', () => renameInline(rowIndex), null, many);
  item(many ? `Tag ${ids.length} files…` : 'Edit tags…',
       () => editCell(rowIndex, 'tags'));
  item(many ? `Set title on ${ids.length}…` : 'Edit title…',
       () => editCell(rowIndex, 'title'));
  item(many ? `Set designer on ${ids.length}…` : 'Edit designer…',
       () => editCell(rowIndex, 'designer'));
  item('Show in folder', () => api('/api/os/reveal', { path: row.path }), null, many);
  item('Copy full path', () => {
    navigator.clipboard?.writeText(ids.map(i => S.byId.get(i).path).join('\n'));
    toast('Path copied');
  });
  sep();
  item('Find same geometry', () => {
    if (!row.geom) return toast('No geometry signature for this file', true);
    S.q = 'geom:' + row.geom; $('#q').value = S.q; recompute();
  }, null, many);
  sep();
  item('Move to quarantine', () => $('#quarantine').click());
  item('Delete to Recycle Bin', () => recycle(ids), 'danger');

  document.body.append(m);
  const r = m.getBoundingClientRect();
  m.style.left = Math.min(x, innerWidth - r.width - 8) + 'px';
  m.style.top = Math.min(y, innerHeight - r.height - 8) + 'px';
}

// ---- wiring for the direct-manipulation bits ----------------------------
function wireActions() {
  const tbody = $('#tbody');

  tbody.addEventListener('contextmenu', e => {
    const tr = e.target.closest('tr[data-i]');
    if (!tr) return;
    e.preventDefault();
    showMenu(e.clientX, e.clientY, +tr.dataset.i);
  });

  addEventListener('mousedown', e => { if (!e.target.closest('#menu')) closeMenu(); });
  addEventListener('scroll', closeMenu, true);

  addEventListener('keydown', e => {
    const typing = /^(INPUT|TEXTAREA)$/.test(document.activeElement?.tagName || '');
    if (typing) return;

    // F2 and Enter are handled by the cell-cursor handler in wireCursor(),
    // which runs in the capture phase and stops them here.
    // Delete sends the selection to the Recycle Bin
    if (e.key === 'Delete' && S.sel.size) {
      e.preventDefault();
      recycle([...S.sel]);
    }
  });

  // Double-click routes by column: an editable cell starts editing,
  // anything else opens the file in Snapmaker Orca.
  tbody.ondblclick = e => {
    const tr = e.target.closest('tr[data-i]');
    if (!tr) return;
    const td = e.target.closest('td');
    const field = td?.dataset.field;
    if (field) editCell(+tr.dataset.i, field);
    else openIn(S.view[+tr.dataset.i]);
  };

  api('/api/config').then(c => {
    S.openWith = c.openWith || [];
    const def = S.openWith.find(a => a.default && a.present) || S.openWith.find(a => a.present);
    const btn = el('button', 'btn', def ? 'Open in ' + def.name : 'No slicer found');
    btn.disabled = !def;
    btn.onclick = () => { const r = selectedRows()[0]; if (r) openIn(r); };
    $('#reveal').before(btn);

    const del = el('button', 'btn danger', 'Delete');
    del.title = 'Send to Recycle Bin (Del)';
    del.onclick = () => recycle([...S.sel]);
    $('#quarantine').after(del);
  }).catch(() => {});
}

wireActions();

// ---- edit a cell in place ----------------------------------------------
// If the row you double-clicked is part of a multi-selection, the edit is
// applied to the whole selection - that is how you classify 40 files at once.
function editCell(rowIndex, field) {
  const row = S.view[rowIndex];
  if (!row) return;
  const tr = $(`#tbody tr[data-i="${rowIndex}"]`);
  if (!tr) return;
  const idx = COLS.findIndex(c => c.k === field);
  const cell = tr.children[idx];
  if (!cell) return;

  const targets = S.sel.has(row.id) && S.sel.size > 1 ? [...S.sel] : [row.id];
  const isTags = field === 'tags';
  const before = isTags ? (row.tags || []).join(', ') : (row[field] || '');

  cell.textContent = '';
  cell.classList.remove('empty-cell');
  const inp = el('input', 'renamer');
  inp.type = 'text';
  inp.value = before;
  inp.placeholder = isTags
    ? 'comma separated, e.g. pokemon, flexi'
    : (targets.length > 1 ? `set on ${targets.length} files` : field);

  if (isTags) {
    // suggest tags already in use. A datalist on a comma-separated field only
    // completes the whole value, so this helps most on the first tag.
    const listId = 'tag-options';
    let dl = document.getElementById(listId);
    if (!dl) { dl = el('datalist'); dl.id = listId; document.body.append(dl); }
    dl.innerHTML = '';
    for (const v of S.allTags || []) {
      const o = document.createElement('option'); o.value = v; dl.append(o);
    }
    inp.setAttribute('list', listId);
  }

  cell.append(inp);
  inp.focus(); inp.select();

  let closed = false;
  const finish = async (commit) => {
    if (closed) return;
    closed = true;
    const val = inp.value.trim();
    if (!commit || val === before) { renderTable(); return; }
    try {
      const list = isTags
        ? [...new Set(val.split(',').map(t => t.trim().toLowerCase()).filter(Boolean))]
        : null;
      const r = isTags
        ? await api('/api/tags', { ids: targets, set: list })
        : await api('/api/edit', { ids: targets, field, value: val });

      // reflect it locally, including on other copies of the same file
      const shas = new Set(targets.map(i => S.byId.get(i)?.sha256).filter(Boolean));
      for (const x of S.rows) {
        if (!shas.has(x.sha256)) continue;
        if (isTags) x.tags = [...list].sort();
        else x[field] = val;
        x._s = [x.name, x.title, x.designer, x.description, x.rel, x.folder,
                x.license, x.application, x.filaments, (x.tags || []).join(' ')]
                .join(' ').toLowerCase();
      }
      toast(`${isTags ? 'tags' : field} set on ${r.updated} file${r.updated === 1 ? '' : 's'}`);
      if (isTags) refreshTags();
      buildFacets(); recompute(); renderDetail();
    } catch (e) { toast(e.message, true); renderTable(); }
  };
  inp.onkeydown = e => {
    e.stopPropagation();
    if (e.key === 'Enter') finish(true);
    if (e.key === 'Escape') finish(false);
  };
  inp.onblur = () => finish(true);
}

async function refreshTags() {
  try {
    const list = await api('/api/tags/all');
    S.allTags = list.map(x => x.v);
  } catch {}
}

// ---- keyboard cell cursor ----------------------------------------------
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

function ensureCursorVisible() {
  const wrap = $('#tablewrap');
  const headH = $('#tbl').tHead?.offsetHeight || 26;

  // vertical: the sticky header covers the top of the scroll box
  const top = S.cur.r * ROW;
  if (top < wrap.scrollTop + headH) wrap.scrollTop = Math.max(0, top - headH);
  else if (top + ROW > wrap.scrollTop + wrap.clientHeight) {
    wrap.scrollTop = top + ROW - wrap.clientHeight;
  }

  // horizontal
  let left = 0;
  for (let i = 0; i < S.cur.c; i++) left += COLS[i].w;
  const w = COLS[S.cur.c].w;
  if (left < wrap.scrollLeft) wrap.scrollLeft = left;
  else if (left + w > wrap.scrollLeft + wrap.clientWidth) {
    wrap.scrollLeft = left + w - wrap.clientWidth;
  }
}

// select = make the cursor row the selection; extend = shift-style range
function setCursor(r, c, { select = true, extend = false } = {}) {
  if (!S.view.length) return;
  S.cur.r = clamp(r, 0, S.view.length - 1);
  S.cur.c = clamp(c, 0, COLS.length - 1);

  if (extend && S.anchor != null) {
    const [a, b] = S.anchor < S.cur.r ? [S.anchor, S.cur.r] : [S.cur.r, S.anchor];
    S.sel.clear();
    for (let k = a; k <= b; k++) S.sel.add(S.view[k].id);
  } else if (select) {
    S.sel.clear();
    S.sel.add(S.view[S.cur.r].id);
    S.anchor = S.cur.r;
  }
  ensureCursorVisible();
  renderTable(); renderStat(); renderDetail();
}

const curRow = () => S.view[S.cur.r];
const curCol = () => COLS[S.cur.c];

// Enter / F2 act on whatever cell the cursor is in. On Name that means
// renaming the file; on Title, Designer or Tags it edits that value.
function activateCursorCell() {
  const col = curCol();
  if (!curRow()) return;
  if (col.k === 'name') return renameInline(S.cur.r);
  if (col.edit) return editCell(S.cur.r, col.k);
  return null;
}

function wireCursor() {
  const wrap = $('#tablewrap');

  // clicking a cell puts the cursor there too
  $('#tbody').addEventListener('mousedown', e => {
    const tr = e.target.closest('tr[data-i]');
    const td = e.target.closest('td[data-c]');
    if (!tr || !td) return;
    S.cur.r = +tr.dataset.i;
    S.cur.c = +td.dataset.c;
  }, true);

  addEventListener('keydown', e => {
    if (S.tab !== 'files' || S.plan) return;
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || '')) return;
    if (!S.view.length) return;

    const rowsPerPage = Math.max(1, Math.floor(wrap.clientHeight / ROW) - 1);
    const ctrl = e.ctrlKey || e.metaKey;
    let handled = true;

    switch (e.key) {
      case 'ArrowDown':
        setCursor(S.cur.r + 1, S.cur.c, { extend: e.shiftKey }); break;
      case 'ArrowUp':
        setCursor(S.cur.r - 1, S.cur.c, { extend: e.shiftKey }); break;
      case 'ArrowRight':
        setCursor(S.cur.r, S.cur.c + 1, { select: false }); break;
      case 'ArrowLeft':
        setCursor(S.cur.r, S.cur.c - 1, { select: false }); break;
      case 'PageDown':
        setCursor(S.cur.r + rowsPerPage, S.cur.c, { extend: e.shiftKey }); break;
      case 'PageUp':
        setCursor(S.cur.r - rowsPerPage, S.cur.c, { extend: e.shiftKey }); break;
      case 'Home':
        if (ctrl) setCursor(0, S.cur.c, { extend: e.shiftKey });
        else setCursor(S.cur.r, 0, { select: false });
        break;
      case 'End':
        if (ctrl) setCursor(S.view.length - 1, S.cur.c, { extend: e.shiftKey });
        else setCursor(S.cur.r, COLS.length - 1, { select: false });
        break;
      case 'Tab':
        setCursor(S.cur.r, S.cur.c + (e.shiftKey ? -1 : 1), { select: false }); break;
      case 'F2':
        activateCursorCell(); break;
      case 'Enter':
        // edit where editing makes sense, otherwise open in the slicer
        if (ctrl) openIn(curRow());
        else if (curCol().edit || curCol().k === 'name') activateCursorCell();
        else openIn(curRow());
        break;
      default:
        handled = false;
    }
    if (handled) { e.preventDefault(); e.stopPropagation(); }
  }, true); // capture, so this runs before the older handlers
}

wireCursor();
setCursor(0, 0, { select: false });
