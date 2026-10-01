// npm test   (node --test finds every *.test.mjs)
// Inputs are real values from a library indexed by 1.0.0, as the old reader
// stored them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { metaText, decodeEntities } from '../lib/metatext.mjs';

test('double-escaped HTML description becomes plain text', () => {
  const raw = '&amp;lt;p&amp;gt;#0025 Pikachu Ball -&amp;lt;br&amp;gt;Design inspired by the Famous Pokemon Pikachu.&amp;lt;br&amp;gt;&amp;lt;br&amp;gt;I modeled it&amp;lt;/p&amp;gt;';
  assert.equal(metaText(raw), '#0025 Pikachu Ball -\nDesign inspired by the Famous Pokemon Pikachu.\n\nI modeled it');
});

test('UTF-8 read as latin1 is repaired', () => {
  assert.equal(metaText('Charizard - Flexi Articulated PokÃ©mon'), 'Charizard - Flexi Articulated Pokémon');
  assert.equal(metaText('Filamentwandhalterung fÃ¼r Besenstange'), 'Filamentwandhalterung für Besenstange');
});

test('mangled non-breaking space and escaped quotes inside tags disappear', () => {
  const raw = '&amp;lt;p&amp;gt;#&amp;lt;strong&amp;gt;0058 Growlithe Â - &amp;amp;#34;&amp;lt;/strong&amp;gt;&amp;lt;span style=&amp;amp;#34;color: red&amp;amp;#34;&amp;gt;hi&amp;lt;/span&amp;gt;&amp;lt;/p&amp;gt;';
  assert.equal(metaText(raw), '#0058 Growlithe - "hi');
});

test('singly escaped HTML (one XML layer) is handled too', () => {
  assert.equal(metaText('&lt;p&gt;Tom &amp;amp; Jerry&lt;/p&gt;'), 'Tom & Jerry');
});

test('plain text passes through unchanged', () => {
  for (const s of ['Sunflower Dragon', 'Fish & Chips', 'size < 5 cm', '']) assert.equal(metaText(s), s);
  assert.equal(metaText(undefined), '');
});

test('it is idempotent, so the one-time DB cleanup cannot damage clean rows', () => {
  for (const raw of ['&amp;lt;p&amp;gt;A&amp;lt;br&amp;gt;B&amp;lt;/p&amp;gt;', 'PokÃ©mon', 'Fish &amp; Chips']) {
    const once = metaText(raw);
    assert.equal(metaText(once), once);
  }
});

test('numeric and hex entities decode', () => {
  assert.equal(decodeEntities('&#34;x&#x27;'), '"x\'');
});
