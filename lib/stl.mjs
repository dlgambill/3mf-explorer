// Geometry signatures for the formats that carry no metadata: STL and OBJ.
import fs from 'node:fs';
import { newMeshAcc, addVertex, finishMesh } from './mesh.mjs';

// Binary STL: 80-byte header, uint32 triangle count, then 50 bytes each
// (12 floats + 2-byte attribute). ASCII STL starts with "solid" but so do
// some binary files, so trust the size arithmetic instead of the magic word.
function looksBinary(fd, size) {
  if (size < 84) return false;
  const head = Buffer.alloc(84);
  fs.readSync(fd, head, 0, 84, 0);
  const tris = head.readUInt32LE(80);
  return size === 84 + tris * 50;
}

function readBinarySTL(fd, size, acc) {
  const head = Buffer.alloc(84);
  fs.readSync(fd, head, 0, 84, 0);
  const tris = head.readUInt32LE(80);
  acc.tris = tris;
  const CHUNK = 50 * 4096;
  const buf = Buffer.alloc(CHUNK);
  let off = 84, left = tris;
  while (left > 0) {
    const want = Math.min(CHUNK, left * 50);
    const got = fs.readSync(fd, buf, 0, want, off);
    if (got <= 0) break;
    for (let p = 0; p + 50 <= got; p += 50) {
      for (let v = 0; v < 3; v++) {
        const b = p + 12 + v * 12;
        addVertex(acc, buf.readFloatLE(b), buf.readFloatLE(b + 4), buf.readFloatLE(b + 8));
      }
    }
    const n = Math.floor(got / 50);
    left -= n; off += n * 50;
    if (!n) break;
  }
}

// Streamed text scan shared by ASCII STL and OBJ.
function readTextMesh(path, acc, kind) {
  const OVERLAP = 400;
  const fd = fs.openSync(path, 'r');
  try {
    const buf = Buffer.alloc(1 << 20);
    let carry = '', off = 0;
    // Vertices and faces in one regex, so there is a single resume point
    // per chunk and nothing straddling a boundary gets dropped.
    const re = kind === 'stl'
      ? /vertex\s+([-\d.eE+]+)\s+([-\d.eE+]+)\s+([-\d.eE+]+)|facet\s+normal/g
      : /^v\s+([-\d.eE+]+)\s+([-\d.eE+]+)\s+([-\d.eE+]+)|^f\s/gm;

    const consume = (s, limit) => {
      re.lastIndex = 0;
      let m, end = 0;
      while ((m = re.exec(s)) !== null) {
        if (re.lastIndex > limit) break;
        if (m[1] !== undefined) addVertex(acc, +m[1], +m[2], +m[3]);
        else acc.tris++;
        end = re.lastIndex;
      }
      return end;
    };

    for (;;) {
      const got = fs.readSync(fd, buf, 0, buf.length, off);
      if (got <= 0) break;
      off += got;
      const s = carry + buf.toString('latin1', 0, got);
      const end = consume(s, Math.max(0, s.length - OVERLAP));
      carry = end > 0 ? s.slice(end) : s.slice(Math.max(0, s.length - 2 * OVERLAP));
    }
    if (carry) consume(carry, carry.length);
  } finally {
    fs.closeSync(fd);
  }
}

export function readMeshFile(path, ext) {
  const acc = newMeshAcc();
  if (ext === '.obj') {
    readTextMesh(path, acc, 'obj');
  } else {
    let binary = false;
    const fd = fs.openSync(path, 'r');
    try {
      const size = fs.fstatSync(fd).size;
      binary = looksBinary(fd, size);
      if (binary) readBinarySTL(fd, size, acc);
    } finally {
      fs.closeSync(fd);
    }
    if (!binary) readTextMesh(path, acc, 'stl');
  }
  return finishMesh(acc) || { geom: null, vcount: 0, tcount: 0, bbox: '' };
}
