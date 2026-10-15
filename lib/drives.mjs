import path from 'node:path';
import { execFile } from 'node:child_process';

// E4 (1.6.1): Windows has no Recycle Bin for network locations. Deleting a
// file on a UNC path or a mapped network drive "to the Recycle Bin" deletes
// it outright, with no dialog and no way back. The app promises nothing is
// ever hard-deleted, so files on network drives go to quarantine instead.
//
// networkLetters() asks Windows which drive letters are network drives
// (DriveInfo.DriveType = Network, the same answer GetDriveType gives). It is
// cached for five minutes. If Windows can't be asked, the answer is null and
// isNetworkPath treats EVERY path as network: when in doubt, quarantine,
// because quarantine is the action that can be undone.
//
// EXPLORER_NETWORK_PREFIXES (test hook, ';'-separated folders) marks extra
// folders as network so the tests can exercise this on a local temp dir.

const TTL = 5 * 60 * 1000;
let cache = { at: 0, letters: null };

export function networkLetters() {
  if (process.platform !== 'win32') return Promise.resolve(new Set());
  if (cache.letters && Date.now() - cache.at < TTL) return Promise.resolve(cache.letters);
  return new Promise(resolve => {
    execFile('powershell.exe', ['-NoProfile', '-Command',
      "[System.IO.DriveInfo]::GetDrives() | Where-Object { $_.DriveType -eq 'Network' } | ForEach-Object { $_.Name.Substring(0,1) }"],
      { windowsHide: true, timeout: 10000, encoding: 'utf8' }, (err, stdout) => {
        if (err) return resolve(null);
        const letters = new Set(String(stdout).split(/\r?\n/).map(s => s.trim().toUpperCase()).filter(s => /^[A-Z]$/.test(s)));
        cache = { at: Date.now(), letters };
        resolve(letters);
      });
  });
}

function extraPrefixes() {
  return String(process.env.EXPLORER_NETWORK_PREFIXES || '').split(';').map(s => s.trim()).filter(Boolean)
    .map(s => path.resolve(s).toLowerCase());
}

// letters: Set of upper-case drive letters, or null when unknown.
export function isNetworkPath(p, letters) {
  const s = String(p || '');
  if (/^(\\\\|\/\/)/.test(s)) return true;                          // UNC: \\server\share
  const lp = path.resolve(s).toLowerCase();
  if (extraPrefixes().some(x => lp === x || lp.startsWith(x + path.sep))) return true;
  if (letters == null) return true;                                 // unknown: play safe
  const m = /^([a-z]):/i.exec(s);
  return !!m && letters.has(m[1].toUpperCase());
}
