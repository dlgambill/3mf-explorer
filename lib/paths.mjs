import path from 'node:path';

// Windows caps ordinary paths at 260 chars and Node fails on longer ones.
// The \\?\ prefix lifts the limit. A real downloaded model library already
// produces paths long enough to hit this - the first survey silently missed ~50 files
// because of it - so every fs call goes through here.
export function longPath(p) {
  if (process.platform !== 'win32') return p;
  if (p.startsWith('\\\\?\\')) return p;
  const abs = path.resolve(p);
  return abs.startsWith('\\\\') ? '\\\\?\\UNC\\' + abs.slice(2) : '\\\\?\\' + abs;
}
