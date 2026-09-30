// Order-independent geometry signature.
//
// Why not just hash the file? Because re-slicing the same model rewrites
// metadata, settings and often the vertex ordering, so byte hashes miss
// copies that are geometrically identical. This accumulates a signature
// that depends only on the SET of vertices, in one pass and O(1) memory.

const P32 = 16777619;

function fnv(str, seed) {
  let h = seed;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, P32);
  }
  return h >>> 0;
}

export function newMeshAcc() {
  return {
    n: 0, tris: 0,
    sumA: 0, sumB: 0, xorA: 0, xorB: 0,
    minX: Infinity, minY: Infinity, minZ: Infinity,
    maxX: -Infinity, maxY: -Infinity, maxZ: -Infinity,
  };
}

export function addVertex(a, x, y, z) {
  // 3 decimals ~= 1 micron. Enough to be stable across slicer round-trips.
  const k = x.toFixed(3) + ',' + y.toFixed(3) + ',' + z.toFixed(3);
  const h1 = fnv(k, 2166136261);
  const h2 = fnv(k, 1099511628);
  a.sumA = (a.sumA + h1) >>> 0;
  a.sumB = (a.sumB + h2) >>> 0;
  a.xorA = (a.xorA ^ h1) >>> 0;
  a.xorB = (a.xorB ^ h2) >>> 0;
  a.n++;
  if (x < a.minX) a.minX = x;
  if (y < a.minY) a.minY = y;
  if (z < a.minZ) a.minZ = z;
  if (x > a.maxX) a.maxX = x;
  if (y > a.maxY) a.maxY = y;
  if (z > a.maxZ) a.maxZ = z;
}

const hex = n => (n >>> 0).toString(16).padStart(8, '0');

export function finishMesh(a) {
  if (!a.n) return null;
  const dx = +(a.maxX - a.minX).toFixed(2);
  const dy = +(a.maxY - a.minY).toFixed(2);
  const dz = +(a.maxZ - a.minZ).toFixed(2);
  const sig = [
    a.n.toString(16), a.tris.toString(16),
    hex(a.sumA), hex(a.sumB), hex(a.xorA), hex(a.xorB),
    dx, dy, dz,
  ].join('-');
  return { geom: sig, vcount: a.n, tcount: a.tris, bbox: `${dx} x ${dy} x ${dz}` };
}
