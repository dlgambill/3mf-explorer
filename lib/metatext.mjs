// Turn a raw <metadata> value from a 3MF model header into plain text.
//
// The header is read as latin1 so byte offsets stay stable while streaming,
// but 3MF files are UTF-8, so a value has to be re-decoded or "Pokémon"
// arrives as "PokÃ©mon". The value is also XML text, so its entities have to
// be decoded once. Bambu Studio and Orca store Description as HTML that was
// escaped again before it went into the XML, which is why the detail panel
// showed "&amp;lt;p&amp;gt;": that takes a second decode, after which the HTML
// tags are turned into line breaks and dropped.
//
// Pure and deterministic, so the same function can clean values already
// stored by older versions (lib/db.mjs runs it once over existing rows).

const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

export function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : m;
    }
    const v = NAMED[e.toLowerCase()];
    return v === undefined ? m : v;
  });
}

const looksUtf8Mangled = s => /[Â-ô][\u0080-¿]/.test(s);

export function metaText(raw) {
  if (raw == null) return '';
  let s = String(raw);
  // latin1 -> utf8, only when the bytes really are UTF-8 (a stray latin1
  // value would otherwise turn into replacement characters).
  if (looksUtf8Mangled(s)) {
    const u = Buffer.from(s, 'latin1').toString('utf8');
    if (!u.includes('�')) s = u;
  }
  s = decodeEntities(s);                       // the XML layer
  if (/&(lt|gt|amp|quot|#\d+);/i.test(s)) s = decodeEntities(s); // escaped HTML inside it
  if (/<\/?[a-z][^>]*>/i.test(s)) {
    s = s
      .replace(/<\s*br\s*\/?>/gi, '\n')
      .replace(/<\/\s*(p|div|li|h[1-6])\s*>/gi, '\n')
      .replace(/<li[^>]*>/gi, '- ')
      .replace(/<[^>]+>/g, '');
    s = decodeEntities(s);                     // &amp; etc. that sat inside the HTML
  }
  return s
    .replace(/ /g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
