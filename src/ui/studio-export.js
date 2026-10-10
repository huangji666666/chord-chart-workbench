import { button, downloadBlob, el, replaceChildren } from './dom.js';
import { openSheet, toast } from './dialogs.js';
import { renderChart } from './chart.js';
import { waitForMelodies } from './melody.js';
import { waitForChordDiagrams } from './chord-diagrams.js';
import { collectDurationIssues } from '../core/duration.js';
import { getThemeColors } from '../core/theme.js';

/** A4 portrait at 96 CSS pixels per inch. The canvas is rendered at 2x for print clarity. */
export const SCORE_PAGE = Object.freeze({ width: 794, height: 1123, margin: 44, scale: 2 });

function cloneSong(song, sections) {
  return {
    ...song,
    sections,
    layout: { ...song.layout, barsPerRow: song.layout.barsPerRow },
  };
}

function splitRows(song) {
  const columns = Math.max(1, Number(song.layout?.barsPerRow) || 4);
  const rows = [];
  let number=song.sections[0]?.bars[0]?.sourceNumber??1;
  for (const section of song.sections) {
    const bars = (section.bars ?? []).map((bar)=>({...bar,sourceNumber:number++}));
    for (let index = 0; index < bars.length; index += columns) {
      rows.push({
        section: {
          ...section,
          repeat: index === 0 ? section.repeat : 1,
          bars: bars.slice(index, index + columns),
        },
      });
    }
  }
  return rows;
}

function hasLyrics(song) {
  if(song.layout.showLyrics===false)return false;
  return song.sections?.some((section) => section.bars?.some((bar) =>
    bar.lyrics?.some((lyric) => String(lyric?.text ?? '').trim()),
  ));
}

function hasMelody(song) {
  return song.layout.showMelody!==false && song.sections?.some((section) => section.bars?.some((bar) => bar.showMelody!==false && bar.melody?.length));
}

function makePageSong(song, rows) {
  const sections = [];
  for (const row of rows) {
    const last = sections.at(-1);
    if (last && last.id === row.section.id) last.bars.push(...row.section.bars);
    else sections.push({ ...row.section, bars: [...row.section.bars] });
  }
  return cloneSong(song, sections);
}

function makeExportRoot(song, mode = 'preview') {
  const root = el('div', {
    class: 'score-export-page',
    style: [
      `width:${SCORE_PAGE.width}px`,
      `height:${SCORE_PAGE.height}px`,
      `padding:${SCORE_PAGE.margin}px`,
      'box-sizing:border-box',
      'overflow:hidden',
      'position:absolute',
      'left:0',
      'top:0',
      'background:#fff',
      'color:#1f2925',
    ].join(';'),
  });
  const chart = renderChart(song, {
    mode,
    availableWidth: SCORE_PAGE.width - SCORE_PAGE.margin * 2,
  });
  root.append(chart);
  return root;
}

function canvasToBlob(canvas, type = 'image/png', quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error('浏览器没有返回图片数据')), type, quality);
  });
}

/**
 * Render the current Song into independent A4 canvases.
 *
 * Rows are kept together. Measure the actual render after fonts and melody load;
 * large lyrics or notes can reduce the number of rows on an A4 page.
 */
export async function buildScorePages(song, options = {}) {
  if (!song?.sections?.length) throw new Error('这首歌没有可以导出的谱面内容');
  const { toCanvas } = await import('html-to-image');
  const colors = getThemeColors(options.theme ?? 'pure');
  const rows = splitRows(song);
  const rowsPerPage = Math.max(1, Number(options.rowsPerPage) || (hasMelody(song) || hasLyrics(song) ? 4 : 5));
  const pages = [];
  // html-to-image needs the source node to be painted in the document. Keeping it
  // at the viewport origin is more reliable across Chromium/WebView versions than
  // placing it thousands of pixels off-screen; the short-lived holder is inert to
  // pointer input and is removed before the export sheet finishes opening.
  const holder = el('div', { class: 'score-export-holder', style: 'position:fixed;left:0;top:0;z-index:1;pointer-events:none;' });
  document.body.append(holder);
  try {
    await document.fonts?.ready;
    for (let index = 0; index < rows.length || (!rows.length && !pages.length);) {
      const chunk = rows.slice(index, index + rowsPerPage);
      let pageSong = makePageSong(song, chunk);
      const root = makeExportRoot(pageSong);
      root.style.setProperty('--paper', '#ffffff');
      root.style.setProperty('--paper-alt', colors.paperAlt);
      root.style.setProperty('--bg', '#ffffff');
      root.style.setProperty('--line', colors.line);
      root.style.setProperty('--line-strong', colors.lineStrong);
      root.style.setProperty('--ink', colors.ink);
      root.style.setProperty('--ink-soft', colors.inkSoft);
      root.style.setProperty('--accent', colors.accent);
      root.style.setProperty('--accent-ink', colors.accentInk);
      root.style.setProperty('--accent-soft', colors.accentSoft);
      holder.append(root);
      await Promise.all([waitForMelodies(root),waitForChordDiagrams(root)]);
      const availableHeight = SCORE_PAGE.height - SCORE_PAGE.margin * 2;
      while (root.firstElementChild.getBoundingClientRect().height > availableHeight && chunk.length > 1) {
        chunk.pop();
        pageSong = makePageSong(song, chunk);
        root.replaceChildren(renderChart(pageSong, { mode:'preview', availableWidth:SCORE_PAGE.width - SCORE_PAGE.margin * 2 }));
        await Promise.all([waitForMelodies(root),waitForChordDiagrams(root)]);
      }
      if (root.firstElementChild.getBoundingClientRect().height > availableHeight) {
        throw new Error('一个完整谱行超过 A4 可用高度，请减小字号或缩短演奏备注。');
      }
      const canvas = await toCanvas(root, {
        width: SCORE_PAGE.width,
        height: SCORE_PAGE.height,
        pixelRatio: SCORE_PAGE.scale,
        backgroundColor: '#ffffff',
        cacheBust: true,
      });
      pages.push({ canvas, root, song: pageSong });
      root.remove();
      index += chunk.length;
      if (!rows.length) break;
    }
  } finally {
    holder.remove();
  }
  return { pages, rowsPerPage };
}

function safeName(song, suffix = '') {
  const raw = `${song.title || '功能谱'}${suffix}`;
  return raw.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim().slice(0, 80) || '功能谱';
}

async function buildPdf(pages) {
  const { jsPDF } = await import('jspdf');
  const pdf = new jsPDF({ orientation: 'portrait', unit: 'pt', format: 'a4', compress: true });
  const width = 595.28;
  const height = 841.89;
  pages.forEach((page, index) => {
    if (index) pdf.addPage();
    pdf.addImage(page.canvas.toDataURL('image/png'), 'PNG', 0, 0, width, height, undefined, 'FAST');
  });
  return pdf.output('blob');
}

function pageThumb(canvas) {
  const thumb = el('canvas', { class: 'export-thumb', width: '88', height: '124' });
  const context = thumb.getContext('2d');
  context?.drawImage(canvas, 0, 0, thumb.width, thumb.height);
  return thumb;
}

/** Open the compact export sheet used by the top-right action and More menu. */
export async function openScoreExport(ctx) {
  const song = ctx.store.getSong();
  const issues = collectDurationIssues(song);
  const status = el('p', { class: 'notice', text: '正在生成 A4 预览…' });
  const body = el('div', { class: 'score-export-panel' }, [status]);
  const runPdf = button('保存 PDF', { variant: 'primary', disabled: true });
  const runPng = button('保存 PNG', { disabled: true });
  let pages = [];
  let handle;

  handle = openSheet({
    title: '导出谱面',
    subtitle: issues.length ? `有 ${issues.length} 处时值需要核对` : 'A4 竖版 · 和屏幕同一套谱面',
    body,
    actions: [button('打印', { onClick: () => { handle.close(null); ctx.print(); } }), runPng, runPdf],
  });

  try {
    const result = await buildScorePages(song, { theme: 'pure' });
    pages = result.pages;
    replaceChildren(body,
      el('p', { class: 'notice', text: `${pages.length} 页 A4，${['和弦',hasLyrics(song)?'歌词':'',hasMelody(song)?'简谱':'',song.chordDiagrams?.length?'和弦图':''].filter(Boolean).join('、')}按当前显示设置导出。` }),
      el('div', { class: 'export-preview-grid' }, pages.map((page, index) => el('div', { class: 'export-preview-card' }, [pageThumb(page.canvas), el('span', { text: `第 ${index + 1} 页` })]))),
      issues.length ? el('p', { class: 'notice notice--warn', text: '导出会照当前谱面绘制；建议先点上方红色提示检查时值。' }) : null,
    );
    runPdf.disabled = false;
    runPng.disabled = false;
    runPdf.addEventListener('click', async () => {
      try { runPdf.disabled = true; downloadBlob(`${safeName(song)}.pdf`, await buildPdf(pages)); handle.close(null); toast(`已保存 ${pages.length} 页 PDF`, { type: 'success' }); }
      catch (error) { toast(`PDF 导出失败：${error.message}`, { type: 'error' }); }
      finally { runPdf.disabled = false; }
    });
    runPng.addEventListener('click', async () => {
      try {
        for (const [index, page] of pages.entries()) downloadBlob(`${safeName(song, pages.length > 1 ? `-p${index + 1}` : '')}.png`, await canvasToBlob(page.canvas));
        handle.close(null); toast(`已保存 ${pages.length} 张 PNG`, { type: 'success' });
      } catch (error) { toast(`PNG 导出失败：${error.message}`, { type: 'error' }); }
    });
  } catch (error) {
    status.className = 'field__error';
    status.textContent = `生成 A4 谱面失败：${error.message}`;
  }
}
