// Minimal, dependency-free ZIP reader. 3MF files are ordinary zips.
// Reads only the byte ranges it needs, so a 200 MB archive costs a few KB
// to open and only the entry you ask for to read.
//
// Ranges go through createReadStream rather than filehandle.read(): the
// latter asserts that the byte offset fits in an int32, so anything past
// 2 GB aborts the whole Node process rather than throwing. Learned that
// the hard way on a scan of a big downloads folder.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import zlib from 'node:zlib';

const EOCD    = 0x06054b50;
const CEN     = 0x02014b50;
const Z64_LOC = 0x07064b50; // zip64 end-of-central-directory locator
const Z64_END = 0x06064b50; // zip64 end-of-central-directory record
const MAX_ENTRY = 512 * 1024 * 1024;

function u64(buf, off) {
  const v = buf.readBigUInt64LE(off);
  if (v > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('zip offset beyond 2^53');
  return Number(v);
}

// Zip64 extended information extra field (header id 0x0001). Only the fields
// whose 32-bit slot held 0xFFFFFFFF are present, and always in this order:
// uncompressed, compressed, local-header offset, disk start.
function zip64Extra(extra, need) {
  const out = {};
  let p = 0;
  while (p + 4 <= extra.length) {
    const id = extra.readUInt16LE(p);
    const len = extra.readUInt16LE(p + 2);
    if (p + 4 + len > extra.length) break;
    if (id === 0x0001) {
      let q = p + 4;
      const end = q + len;
      for (const field of ['usize', 'csize', 'lho']) {
        if (!need[field]) continue;
        if (q + 8 > end) break;
        out[field] = u64(extra, q);
        q += 8;
      }
      break;
    }
    p += 4 + len;
  }
  return out;
}

function readRange(file, start, len) {
  return new Promise((resolve, reject) => {
    if (len <= 0) return resolve(Buffer.alloc(0));
    const chunks = [];
    const s = fs.createReadStream(file, { start, end: start + len - 1 });
    s.on('data', c => chunks.push(c));
    s.on('end', () => resolve(Buffer.concat(chunks)));
    s.on('error', reject);
  });
}

export async function openZip(filePath) {
  const { size } = await fsp.stat(filePath);
  if (size < 22) throw new Error('too small to be a zip');

  const tailLen = Math.min(size, 66560);
  const tail = await readRange(filePath, size - tailLen, tailLen);
  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tail.readUInt32LE(i) === EOCD) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('not a zip (no EOCD)');

  let count  = tail.readUInt16LE(eocd + 10);
  let cenLen = tail.readUInt32LE(eocd + 12);
  let cenOff = tail.readUInt32LE(eocd + 16);

  // Zip64. Some writers (Bambu/Orca among them) emit zip64 unconditionally
  // because they stream entries out before knowing their size, so a 90 KB
  // 3MF can land here just as readily as a 5 GB one.
  if (eocd >= 20 && tail.readUInt32LE(eocd - 20) === Z64_LOC) {
    const z64Off = u64(tail, eocd - 20 + 8);
    const z64 = await readRange(filePath, z64Off, 56);
    if (z64.length >= 56 && z64.readUInt32LE(0) === Z64_END) {
      count  = u64(z64, 32);
      cenLen = u64(z64, 40);
      cenOff = u64(z64, 48);
    }
  }
  if (cenOff === 0xffffffff || cenLen === 0xffffffff || count === 0xffff) {
    throw new Error('zip64 markers present but no zip64 end record found');
  }
  const cen = await readRange(filePath, cenOff, cenLen);

  // Walk by signature rather than trusting the count: a truncated or
  // over-reported directory then costs us entries, not an exception.
  const entries = new Map();
  let p = 0;
  while (p + 46 <= cen.length && cen.readUInt32LE(p) === CEN) {
    const method = cen.readUInt16LE(p + 10);
    let csize    = cen.readUInt32LE(p + 20);
    let usize    = cen.readUInt32LE(p + 24);
    const nLen   = cen.readUInt16LE(p + 28);
    const eLen   = cen.readUInt16LE(p + 30);
    const cLen   = cen.readUInt16LE(p + 32);
    let lho      = cen.readUInt32LE(p + 42);
    const name   = cen.toString('utf8', p + 46, p + 46 + nLen).replace(/\\/g, '/');

    const need = {
      usize: usize === 0xffffffff,
      csize: csize === 0xffffffff,
      lho:   lho   === 0xffffffff,
    };
    if (need.usize || need.csize || need.lho) {
      const ext = zip64Extra(cen.subarray(p + 46 + nLen, p + 46 + nLen + eLen), need);
      if (need.usize) { if (ext.usize === undefined) throw new Error('missing zip64 size: ' + name); usize = ext.usize; }
      if (need.csize) { if (ext.csize === undefined) throw new Error('missing zip64 size: ' + name); csize = ext.csize; }
      if (need.lho)   { if (ext.lho   === undefined) throw new Error('missing zip64 offset: ' + name); lho = ext.lho; }
    }

    entries.set(name, { name, method, csize, usize, lho });
    p += 46 + nLen + eLen + cLen;
  }
  return { file: filePath, entries, size };
}

async function dataStart(zip, e) {
  // Local header length differs from the central one, so re-read it.
  const lh = await readRange(zip.file, e.lho, 30);
  if (lh.length < 30 || lh.readUInt32LE(0) !== 0x04034b50) {
    throw new Error('bad local header: ' + e.name);
  }
  return e.lho + 30 + lh.readUInt16LE(26) + lh.readUInt16LE(28);
}

// Read one entry fully into a Buffer.
export async function readEntry(zip, name) {
  const e = zip.entries.get(name);
  if (!e) return null;
  if (e.usize > MAX_ENTRY) throw new Error('entry too large: ' + name);
  const raw = await readRange(zip.file, await dataStart(zip, e), e.csize);
  if (e.method === 0) return raw;
  if (e.method === 8) return zlib.inflateRawSync(raw, { maxOutputLength: MAX_ENTRY });
  throw new Error('unsupported compression method ' + e.method);
}

// Stream an entry through `onChunk` without holding the decompressed whole
// in memory. Used for meshes, which can be very large.
export async function streamEntry(zip, name, onChunk) {
  const e = zip.entries.get(name);
  if (!e) return false;
  const start = await dataStart(zip, e);

  if (e.method === 0) {
    let off = 0;
    while (off < e.csize) {
      const n = Math.min(1 << 20, e.csize - off);
      onChunk(await readRange(zip.file, start + off, n));
      off += n;
    }
    return true;
  }
  if (e.method !== 8) throw new Error('unsupported compression method ' + e.method);

  await new Promise((resolve, reject) => {
    const src = fs.createReadStream(zip.file, { start, end: start + e.csize - 1 });
    const inflate = zlib.createInflateRaw();
    src.on('error', reject);
    inflate.on('error', reject);
    inflate.on('data', onChunk);
    inflate.on('end', resolve);
    src.pipe(inflate);
  });
  return true;
}

// Nothing to close now that ranges open their own streams; kept so callers
// do not have to care which implementation they are talking to.
export async function closeZip() {}
