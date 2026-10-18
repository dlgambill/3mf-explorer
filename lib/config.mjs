import fs from 'node:fs';
import path from 'node:path';

// F8 (1.7.1): config.json is checked when it is read, by hand, with no
// dependency. The rules are small on purpose:
//   - a key this app does not know is a warning in the log, never a failure
//     (a newer config on an older build, or a typo, should not stop the
//     service), and keys starting with "_" are notes and are not checked;
//   - a value of the wrong type stops startup with the key name and the type
//     it should be, because "port": "7333" or "roots": "D:\\Models" would
//     otherwise fail somewhere far from the cause;
//   - a relative path is resolved against the data folder (EXPLORER_DATA, or
//     the app folder), so "quarantine": "_quarantine" means next to the app;
//   - a UTF-8 byte order mark at the start of the file is stripped with a
//     warning. PowerShell 5's Set-Content -Encoding UTF8 writes one, and
//     JSON.parse refuses it.

// Leaf types: 'number' | 'string' | 'boolean' | 'string[]'. A nested object
// is a sub-schema; an array of objects is [sub-schema].
const SCHEMA = {
  port: 'number',
  roots: 'string[]',
  fileTypes: 'string[]',
  protected: 'string[]',
  quarantine: 'string',
  archive: 'string',
  backupDir: 'string',
  autoArchive: { enabled: 'boolean', days: 'number', everyDays: 'number' },
  concurrency: 'number',
  geometryMaxMB: 'number',
  openWith: [{ name: 'string', exe: 'string', default: 'boolean' }],
  allowedOrigins: 'string[]',
  hub: { url: 'string', dir: 'string', token: 'string' },
};
// Paths resolved against the data folder when relative: roots, quarantine,
// archive, backupDir and hub.dir (see validateConfig).

export const BOM = '\uFEFF';

// Text -> object. Only the BOM is handled here; the shape is checked by
// validateConfig so the two can be used apart (the Settings save re-reads
// the file from disk to keep hand-added keys, and must not resolve paths).
export function parseConfigText(text) {
  let bom = false;
  if (text.charCodeAt(0) === 0xFEFF) { text = text.slice(1); bom = true; }
  let raw;
  try { raw = JSON.parse(text); }
  catch (e) { throw new Error('config.json is not valid JSON: ' + e.message); }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('config.json should hold one object {...}');
  return { raw, bom };
}

const typeName = v => v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v;
const fail = (key, want, got) => {
  throw new Error(`config.json: "${key}" should be ${want} (got ${typeName(got)})`);
};

function checkNode(value, schema, prefix, warnings) {
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    const key = prefix ? prefix + '.' + k : k;
    if (k.startsWith('_')) { out[k] = v; continue; }
    const want = schema[k];
    if (want === undefined) { warnings.push(`config.json: unknown key "${key}" is ignored`); out[k] = v; continue; }
    if (v === null || v === undefined) { out[k] = v; continue; }
    if (Array.isArray(want)) {
      if (!Array.isArray(v)) fail(key, 'a list of objects', v);
      out[k] = v.map((item, i) => {
        if (!item || typeof item !== 'object' || Array.isArray(item)) fail(`${key}[${i}]`, 'an object', item);
        return checkNode(item, want[0], `${key}[${i}]`, warnings);
      });
    } else if (typeof want === 'object') {
      if (!v || typeof v !== 'object' || Array.isArray(v)) fail(key, 'an object', v);
      out[k] = checkNode(v, want, key, warnings);
    } else if (want === 'string[]') {
      if (!Array.isArray(v)) fail(key, 'a list of strings', v);
      v.forEach((s, i) => { if (typeof s !== 'string') fail(`${key}[${i}]`, 'a string', s); });
      out[k] = v;
    } else if (want === 'number') {
      if (typeof v !== 'number' || !Number.isFinite(v)) fail(key, 'a number', v);
      out[k] = v;
    } else if (typeof v !== want) {
      fail(key, want === 'boolean' ? 'true or false' : 'a ' + want, v);
    } else out[k] = v;
  }
  return out;
}

// Returns a checked copy with paths resolved, plus the warnings to log.
// Throws on a wrong type.
export function validateConfig(raw, { dataDir = process.cwd() } = {}) {
  const warnings = [];
  const cfg = checkNode(raw, SCHEMA, '', warnings);
  const resolve = p => (typeof p === 'string' && p.trim() && !path.isAbsolute(p)) ? path.resolve(dataDir, p) : p;
  if (Array.isArray(cfg.roots)) cfg.roots = cfg.roots.map(resolve);
  for (const k of ['quarantine', 'archive', 'backupDir']) if (cfg[k]) cfg[k] = resolve(cfg[k]);
  if (cfg.hub && cfg.hub.dir) cfg.hub.dir = resolve(cfg.hub.dir);
  return { cfg, warnings };
}

// Read + parse + validate one file. `log` hears the warnings.
export function loadConfig(file, { dataDir = path.dirname(file), log = m => console.warn('  ' + m) } = {}) {
  const { raw, bom } = parseConfigText(fs.readFileSync(file, 'utf8'));
  if (bom) log('WARNING: config.json starts with a UTF-8 byte order mark (PowerShell\'s Set-Content -Encoding UTF8 writes one) - ignored. Save it as UTF-8 without BOM to stop this warning.');
  const { cfg, warnings } = validateConfig(raw, { dataDir });
  for (const w of warnings) log('WARNING: ' + w);
  return cfg;
}

// The raw file for a read-modify-write (Settings save): BOM-tolerant, no
// path resolution, so what goes back to disk is what the person wrote.
export function readConfigFile(file) {
  return parseConfigText(fs.readFileSync(file, 'utf8'));
}
