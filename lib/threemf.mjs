// 3MF reader: metadata, slicer settings, thumbnail, geometry signature.
import { openZip, readEntry, streamEntry, closeZip } from './zip.mjs';
import { newMeshAcc, addVertex, finishMesh } from './mesh.mjs';

// One regex for both tokens so a chunk has a single resume point. Scanning
// vertices and triangles separately means two different stopping places, and
// carrying from the wrong one silently drops geometry.
const TOKEN_RE = /<vertex[^>]*\sx="([-\d.eE+]+)"[^>]*\sy="([-\d.eE+]+)"[^>]*\sz="([-\d.eE+]+)"|<triangle\b/g;
const META_RE   = /<metadata[^>]*name="([^"]+)"[^>]*>([^<]*)</g;

function pickThumb(entries) {
  const prefer = [
    'Metadata/plate_1.png', 'Metadata/plate_1_small.png',
    'Metadata/plate_no_light_1.png', 'Metadata/top_1.png',
  ];
  for (const p of prefer) if (entries.has(p)) return p;
  for (const k of entries.keys()) if (/^Metadata\/.*\.png$/i.test(k)) return k;
  return null;
}

// Slicer config files are loose key=value or JSON depending on the slicer.
function parseConfig(text) {
  const out = {};
  if (!text) return out;
  const t = text.trim();
  if (t.startsWith('{')) {
    try { return JSON.parse(t); } catch { /* fall through */ }
  }
  for (const line of t.split(/\r?\n/)) {
    const m = line.match(/^\s*([^=;#]+?)\s*=\s*(.*)$/);
    if (m) out[m[1].trim()] = m[2].trim();
  }
  return out;
}

const first = v => Array.isArray(v) ? v[0] : v;
const num = v => { const n = parseFloat(first(v)); return Number.isFinite(n) ? n : null; };

export async function read3mf(filePath, { wantGeometry = true, wantThumb = true } = {}) {
  const zip = await openZip(filePath);
  try {
    const out = { objects: 0, plates: 0 };

    // --- metadata from the model header (first chunk only; meshes follow) ---
    let header = '';
    await streamEntry(zip, '3D/3dmodel.model', c => {
      if (header.length < 32768) header += c.toString('latin1');
    });
    const meta = {};
    for (const m of header.matchAll(META_RE)) meta[m[1]] = m[2].trim();

    out.title       = meta.Title || '';
    out.designer    = meta.Designer || '';
    out.description = meta.Description || '';
    out.license     = meta.License || meta.LicenseTerms || '';
    out.copyright   = meta.Copyright || meta.CopyRight || '';
    out.application = meta.Application || '';
    out.created     = meta.CreationDate || '';
    out.modified    = meta.ModificationDate || '';

    // --- slicer settings ---
    const ps = parseConfig((await readEntry(zip, 'Metadata/project_settings.config'))?.toString('utf8'));
    out.layer_height = num(ps.layer_height);
    out.nozzle       = num(ps.nozzle_diameter);
    const fil = ps.filament_type ?? ps.filament_settings_id;
    out.filaments = fil ? [...new Set([].concat(fil).map(String))].join(', ').slice(0, 120) : '';

    const si = parseConfig((await readEntry(zip, 'Metadata/slice_info.config'))?.toString('utf8'));
    out.print_time = si.prediction || si.Prediction || '';

    // object + plate counts
    const ms = (await readEntry(zip, 'Metadata/model_settings.config'))?.toString('utf8') || '';
    out.objects = (ms.match(/<object\b/g) || []).length;
    out.plates  = (ms.match(/<plate\b/g) || []).length;
    if (!out.plates) {
      out.plates = [...zip.entries.keys()].filter(k => /^Metadata\/plate_\d+\.png$/.test(k)).length;
    }

    // --- thumbnail ---
    if (wantThumb) {
      const t = pickThumb(zip.entries);
      if (t) out.thumbBuf = await readEntry(zip, t);
    }

    // --- geometry signature across every mesh in the package ---
    if (wantGeometry) {
      const acc = newMeshAcc();
      const meshFiles = ['3D/3dmodel.model',
        ...[...zip.entries.keys()].filter(k => /^3D\/Objects\/.*\.model$/i.test(k))];

      const OVERLAP = 400; // comfortably longer than any <vertex .../> tag

      // Count tokens ending at or before `limit` and report where scanning
      // stopped. The caller carries everything from that point forward, so
      // a tag split across two chunks is seen exactly once.
      const consume = (s, limit) => {
        TOKEN_RE.lastIndex = 0;
        let m, end = 0;
        while ((m = TOKEN_RE.exec(s)) !== null) {
          if (TOKEN_RE.lastIndex > limit) break;
          if (m[1] !== undefined) addVertex(acc, +m[1], +m[2], +m[3]);
          else acc.tris++;
          end = TOKEN_RE.lastIndex;
        }
        return end;
      };

      for (const mf of meshFiles) {
        let carry = '';
        await streamEntry(zip, mf, chunk => {
          const s = carry + chunk.toString('latin1');
          const end = consume(s, Math.max(0, s.length - OVERLAP));
          // Resume exactly where counting stopped. If nothing matched, keep
          // a bounded tail - a token can straddle the cut by at most its own
          // length, so 2x OVERLAP is always enough to reconstruct it.
          carry = end > 0 ? s.slice(end) : s.slice(Math.max(0, s.length - 2 * OVERLAP));
        });
        if (carry) consume(carry, carry.length); // flush the remainder
      }
      Object.assign(out, finishMesh(acc) || { geom: null, vcount: 0, tcount: 0, bbox: '' });
    }

    return out;
  } finally {
    await closeZip(zip);
  }
}
