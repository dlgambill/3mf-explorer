import path from 'node:path';

// Protected files: things that live inside a library folder but are not
// library models - templates another app reads, backups, tooling. They are
// never indexed (so they can't show up as duplicates to delete), and every
// action that moves a file (Delete, quarantine, rename, the Excel import's
// Delete column) refuses them server-side, whatever the page sends.
//
// Each entry in config.json "protected" is one of:
//   - a full folder or file path   D:\Models\tool      protects it and everything under it
//   - a file name, * and ? allowed u1_template*.3mf    protects that name in any folder
//
// BUILTIN_PROTECTED is a floor that is always on, whatever config.json says:
// an empty, missing or hand-damaged "protected" list can never expose the U1
// Print Hub's templates. A "folder/**" entry protects everything under any
// folder with that relative path, at any depth in any library folder.
export const BUILTIN_PROTECTED = Object.freeze([
  'u1_template*.3mf', 'filament_types.3mf', '_templates/**', 'tool/_protected_backups/**',
]);

export function makeProtector(list) {
  const prefixes = [], names = [], segments = [];
  const configured = (Array.isArray(list) ? list : []).map(x => String(x).trim()).filter(Boolean);
  for (const s of [...BUILTIN_PROTECTED, ...configured]) {
    if (/^[^\\/:]+([\\/][^\\/:*?]+)*[\\/]\*\*$/.test(s)) {
      // relative "a/b/**": any path containing the folder segments /a/b/
      segments.push('/' + s.slice(0, -3).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase() + '/');
    } else if (/[\\/]/.test(s) || /^[a-z]:/i.test(s)) {
      const p = path.resolve(s).toLowerCase();
      prefixes.push({ exact: p, under: p.endsWith(path.sep) ? p : p + path.sep });
    } else {
      const rx = s.toLowerCase().replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
      names.push(new RegExp('^' + rx + '$'));
    }
  }
  const fn = (p) => {
    if (!p) return false;
    const lp = path.resolve(String(p)).toLowerCase();
    if (prefixes.some(x => lp === x.exact || lp.startsWith(x.under))) return true;
    const slashed = lp.replace(/\\/g, '/');
    if (segments.some(seg => slashed.includes(seg))) return true;
    const base = path.basename(lp);
    return names.some(rx => rx.test(base));
  };
  // true when config.json adds nothing to the built-in floor (worth a warning)
  fn.configEmpty = !configured.length;
  return fn;
}

// Tidy what a person typed in Settings: trim, drop blanks and repeats,
// resolve paths so "X:/foo/" and "X:\foo" are the same entry.
export function normProtected(list) {
  const out = [];
  for (const raw of Array.isArray(list) ? list : []) {
    let s = String(raw).trim();
    if (!s) continue;
    if (/[\\/]/.test(s) || /^[a-z]:/i.test(s)) s = path.resolve(s);
    if (!out.some(x => x.toLowerCase() === s.toLowerCase())) out.push(s);
  }
  return out;
}
