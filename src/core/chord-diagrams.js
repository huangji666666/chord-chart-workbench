import { Note } from 'tonal';
import { parseChordSymbol, formatChordSymbol } from './chord.js';

export function diagramCatalog(database) {
  return Object.values(database.chords).flatMap((chords) => chords.flatMap((entry) => {
    const suffix = { major: '', minor: 'm', '69': '6add9', m69: 'm6add9' }[entry.suffix] ?? entry.suffix;
    const parsed = parseChordSymbol(entry.key + suffix);
    return parsed.ok ? [{ symbol: formatChordSymbol(parsed.value, { glyphs: false }), chord: parsed.value, positions: entry.positions }] : [];
  }));
}

export function sameDiagramChord(a, b) {
  return Note.chroma(a.root) === Note.chroma(b.root) && a.quality === b.quality
    && (a.bass ? Note.chroma(a.bass) : null) === (b.bass ? Note.chroma(b.bass) : null);
}

export const findDiagramChord = (catalog, chord) => catalog.find((entry) => sameDiagramChord(entry.chord, chord));

export function searchDiagramChords(catalog, query) {
  const term = query.trim().replace(/♯/g, '#').replace(/♭/g, 'b');
  const parsed = parseChordSymbol(term);
  const exact = parsed.ok ? findDiagramChord(catalog, parsed.value) : null;
  const matches = catalog.filter((entry) => entry !== exact && entry.symbol.toLowerCase().startsWith(term.toLowerCase()));
  return [...(exact ? [exact] : []), ...matches].slice(0, 16);
}

/** DB frets are relative to baseFret. Only span the actual strings of a barre,
 * so x13331 does not acquire a fictitious sixth-string barre. */
export function svguitarShape(position, showFingers = true) {
  return {
    position: position.baseFret ?? 1,
    fingers: position.frets.map((fret, index) => [6 - index, fret < 0 ? 'x' : fret, showFingers && position.fingers[index] ? String(position.fingers[index]) : '']),
    barres: (position.barres ?? []).flatMap((fret) => {
      const indexes = position.frets.flatMap((value, index) => value === fret ? [index] : []);
      return indexes.length > 1 ? [{ fromString: 6 - indexes[0], toString: 6 - indexes.at(-1), fret }] : [];
    }),
  };
}

export function songDiagramChords(song) {
  const chords = [];
  for (const section of song.sections) for (const bar of section.bars) for (const event of bar.events) {
    if (event.kind === 'chord' && !chords.some((chord) => sameDiagramChord(chord, event.chord))) chords.push(event.chord);
  }
  return chords;
}

let catalogPromise;
export function loadDiagramCatalog() {
  return catalogPromise ??= import('@tombatossals/chords-db/lib/guitar.json')
    .then(({ default: database }) => diagramCatalog(database)).catch((error) => { catalogPromise = null; throw error; });
}
