import { el, button, field, input, select, downloadText } from './dom.js';
import { openSheet } from './dialogs.js';
import { formatChordSymbol } from '../core/chord.js';
import { loadDiagramCatalog, findDiagramChord, searchDiagramChords, svguitarShape, songDiagramChords, sameDiagramChord } from '../core/chord-diagrams.js';

export async function drawChordDiagram(node, item, options = {}) {
  const [catalog, { SVGuitarChord }] = await Promise.all([loadDiagramCatalog(), import('svguitar')]);
  const entry = findDiagramChord(catalog, item.chord);
  const position = entry?.positions[item.position ?? 0];
  if (!position) throw new Error('开源指法库暂未收录这个和弦或把位，请选择其他和弦。');
  node.replaceChildren();
  new SVGuitarChord(node).configure({
    style: 'normal', color: 'currentColor', titleColor: 'currentColor',
    title: formatChordSymbol(item.chord, { glyphs: false }), strings: 6,
    frets: Math.max(4, ...position.frets), fontFamily: 'Arial',
    fingerTextColor: '#ffffff', titleFontSize: 42, strokeWidth: 2,
  }).chord(svguitarShape(position, options.showFingers !== false)).draw();
  const svg = node.querySelector('svg');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', `${formatChordSymbol(item.chord, { glyphs: false })} 吉他指法，${position.baseFret ?? 1} 品起`);
  svg.setAttribute('width', '100%');
  svg.setAttribute('height', '100%');
  return svg;
}

export function renderChordDiagrams(song, options = {}) {
  if (!song.chordDiagrams?.length) return null;
  const strip = el('div', { class: 'score-chord-diagrams', 'aria-label': '本曲和弦指法' });
  song.chordDiagrams.forEach((item, index) => {
    const node = el('div', { class: 'score-chord-diagram', style: `width:${item.size}px`, dataset: { chordDiagram: String(index) } });
    if (options.mode === 'edit') {
      node.tabIndex = 0; node.setAttribute('role', 'button'); node.setAttribute('aria-label', `调整 ${formatChordSymbol(item.chord)} 和弦图`);
      node.addEventListener('click', () => options.onDiagram?.(index));
      node.addEventListener('keydown', (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); options.onDiagram?.(index); } });
    }
    strip.append(node);
    node.diagramReady = drawChordDiagram(node, item).catch((error) => {
      node.diagramError = error; node.replaceChildren(el('span', { class: 'notice', text: formatChordSymbol(item.chord) + '：指法图未加载' }));
    });
  });
  return strip;
}

export async function waitForChordDiagrams(root) {
  const nodes = [...root.querySelectorAll('[data-chord-diagram]')];
  await Promise.all(nodes.map((node) => node.diagramReady));
  const failed = nodes.find((node) => node.diagramError);
  if (failed) throw failed.diagramError;
}

export async function openChordDiagrams(ctx, options = {}) {
  const originalSong = ctx.store.getSong();
  const original = options.index !== undefined ? originalSong.chordDiagrams?.[options.index] : null;
  const query = input({ value: original ? formatChordSymbol(original.chord, { glyphs: false }) : options.chord ? formatChordSymbol(options.chord, { glyphs: false }) : '', placeholder: '搜索和弦，例如 C、Am、F♯m、G/B', ariaLabel: '搜索和弦图' });
  const matches = el('div', { class: 'diagram-search-results', 'aria-label': '和弦搜索结果' });
  const preview = el('div', { class: 'diagram-preview' });
  const message = el('p', { class: 'field__hint', role: 'status', text: '正在加载开源指法库…' });
  const voicing = select({ value: '0', ariaLabel: '选择和弦指法', options: [] });
  const size = input({ type: 'range', min: 60, max: 180, step: 2, value: original?.size ?? 96, ariaLabel: '和弦图大小' });
  const sizeLabel = el('span', { text: `${size.value} px` });
  const error = el('p', { class: 'field__error', role: 'alert' });
  const currentChords = el('div', { class: 'quick-chords' });
  const addUsed = button('加入本曲用到的和弦图', { variant:'quiet', disabled:true, onClick:() => {
    const chords= songDiagramChords(ctx.store.getSong());
    const missing=chords.filter((chord)=>!findDiagramChord(catalog,chord));
    if(commit((items)=>[...items,...chords.filter((chord)=>findDiagramChord(catalog,chord)&&!items.some((item)=>sameDiagramChord(item.chord,chord))).map((chord)=>({chord:{...chord},position:0,size:Number(size.value)}))])){
      if(missing.length){error.textContent='已加入已有指法。暂未收录：'+missing.map((chord)=>formatChordSymbol(chord)).join('、');}
      else handle.close(null);
    }
  } });
  addUsed.hidden=!songDiagramChords(originalSong).length;
  let catalog, selected, handle, revision = 0, closed = false;
  const refreshPreview = async () => {
    const stamp = ++revision; confirm.disabled = true;
    if (!selected) { preview.replaceChildren(); return; }
    const target = el('div', { class: 'diagram-preview-svg', style: `width:${size.value}px` }); preview.replaceChildren(target);
    try {
      await drawChordDiagram(target, { chord: selected.chord, position: Number(voicing.value), size: Number(size.value) });
      if (closed || stamp !== revision) return;
      confirm.disabled = false; error.textContent = '';
    } catch (e) { if (stamp === revision && !closed) error.textContent = e.message; }
  };
  const choose = (entry, position = 0) => {
    selected = entry; query.value = entry.symbol;
    voicing.replaceChildren(...entry.positions.map((p, index) => el('option', { value: String(index), text: `指法 ${index + 1} · ${p.baseFret ?? 1} 品起`, selected: index === position })));
    for (const node of matches.children) node.classList.toggle('is-active', node.textContent === entry.symbol);
    refreshPreview();
  };
  const search = () => {
    if (!catalog) return;
    revision++;
    selected = null; confirm.disabled = true; preview.replaceChildren(); voicing.replaceChildren();
    const entries = query.value.trim() ? searchDiagramChords(catalog, query.value) : ['C','G','Am','F','Dm','Em','D','A','E','Bm','G7','Cmaj7'].flatMap((symbol) => searchDiagramChords(catalog,symbol).slice(0,1));
    matches.replaceChildren(...entries.map((entry) => button(entry.symbol, { class: 'chord-suggestion', onClick: () => choose(entry) })));
    message.textContent = entries.length ? '选择和弦，再挑一个适合自己的指法。' : '暂无匹配指法；可以尝试常用和弦名。斜杠和弦只显示库中已有的准确指法。';
    if (query.value.trim() && entries[0]?.symbol.toLowerCase() === query.value.trim().replace(/♯/g,'#').replace(/♭/g,'b').toLowerCase()) choose(entries[0]);
  };
  const commit = (mutate) => {
    if (ctx.store.getSong().id !== originalSong.id) { error.textContent = '当前歌曲已切换，请重新打开和弦图。'; return false; }
    const result = ctx.store.run('调整谱面和弦图', (song) => ({ ok: true, value: { ...song, chordDiagrams: mutate(song.chordDiagrams ?? []) } }));
    if (!result.ok) { error.textContent = result.message; return false; } return true;
  };
  const confirm = button(original ? '保存和弦图' : '加入谱面', { variant: 'primary', disabled: true, onClick: () => {
    if (!selected || confirm.disabled) return;
    const item = { chord: { ...selected.chord }, position: Number(voicing.value), size: Number(size.value) };
    // Keep the original spelling (Db rather than C#) when only its voicing changes.
    if (original && sameDiagramChord(original.chord, item.chord)) item.chord = { ...original.chord };
    if (commit((items) => original ? items.map((current, index) => index === options.index ? item : current) : [...items, item])) handle.close(null);
  } });
  query.addEventListener('input', search);
  voicing.addEventListener('change', refreshPreview);
  size.addEventListener('input', () => { sizeLabel.textContent = `${size.value} px`; const target = preview.firstElementChild; if (target) target.style.width = `${size.value}px`; });
  const management = original ? el('div', { class: 'diagram-management' }, [
    button('向前排列', { disabled: options.index === 0, onClick: () => { if (commit((items) => { const next = [...items]; [next[options.index-1], next[options.index]] = [next[options.index], next[options.index-1]]; return next; })) handle.close(null); } }),
    button('向后排列', { disabled: options.index === originalSong.chordDiagrams.length - 1, onClick: () => { if (commit((items) => { const next = [...items]; [next[options.index+1], next[options.index]] = [next[options.index], next[options.index+1]]; return next; })) handle.close(null); } }),
    button('移除和弦图', { variant: 'danger', onClick: () => { if (commit((items) => items.filter((_, index) => index !== options.index))) handle.close(null); } }),
  ]) : null;
  handle = openSheet({ title: original ? '调整和弦图' : '和弦图', subtitle: '清晰的 SVG 指法，可随谱保存与导出', body: el('div', { class: 'compact-form diagram-panel' }, [
    field({ label: '搜索和弦', control: query }), matches, message,
    currentChords, addUsed, preview, field({ label: '选择指法', control: voicing }),
    field({ label: '谱面大小', control: el('div', { class: 'diagram-size-control' }, [size, sizeLabel]) }),
    button('下载当前 SVG', { variant: 'quiet', onClick: async () => {
      const svg = preview.querySelector('svg'); if (!svg || !selected) return;
      const clone = svg.cloneNode(true); clone.setAttribute('xmlns','http://www.w3.org/2000/svg'); clone.style.color = getComputedStyle(preview).color;
      clone.setAttribute('width',String(size.value)); clone.setAttribute('height', String(Number(size.value) * svg.viewBox.baseVal.height / svg.viewBox.baseVal.width));
      downloadText(`${selected.symbol.replace(/\//g,'-')}-指法.svg`, clone.outerHTML, 'image/svg+xml');
    } }), management, error,
  ]), actions: [button('取消', { onClick: () => handle.close(null) }), confirm], onClose: () => { closed = true; } });
  try {
    catalog = await loadDiagramCatalog(); if (closed) return;
    addUsed.disabled=false;
    search();
    const chords = songDiagramChords(originalSong);
    currentChords.replaceChildren(...chords.flatMap((chord) => {
      const entry = findDiagramChord(catalog, chord);
      return entry ? [button(formatChordSymbol(chord), { class: 'chord-suggestion', onClick: () => choose({ ...entry, chord, symbol: formatChordSymbol(chord, { glyphs: false }) }) })] : [];
    }));
    if (currentChords.children.length) currentChords.prepend(el('span', { class: 'field__hint', text: '本曲用到：' }));
    const initial = original?.chord ?? options.chord;
    if (initial) { const entry = findDiagramChord(catalog, initial); if (entry) choose({ ...entry, chord: initial, symbol: formatChordSymbol(initial, { glyphs: false }) }, original?.position ?? 0); }
  } catch (e) { message.textContent = '指法库暂时无法加载。'; error.textContent = e.message; }
}
