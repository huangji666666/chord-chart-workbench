/**
 * 谱面 PNG 导出。
 *
 * ## 为什么是 canvas 手绘，而不是「把页面截图」
 *
 * 常见的两种做法这里都不能用：
 *
 * - **`html2canvas` 之类的库**：要引一个几十 KB 的依赖，而且对 `flex`、自定义属性、
 *   中文字体的还原度不可控——「导出结果和屏幕上不一样」这个 bug 几乎查不动。
 * - **SVG `foreignObject`**：把 HTML 塞进 SVG 再画进 canvas，看起来省事，
 *   但要求把所有样式内联，且不同浏览器对它的支持差别很大，失败时是**静默**出白图。
 *
 * 所以这里按谱面的排版规则直接画：时值比例、空白小节宽度、每行小节数、
 * 和弦名 / 级数的换算，全部复用和屏幕同一套规则（`layoutsBars` 与
 * `chart.js` 的 `eventDisplayLines`）。画出来的东西是确定的，也能算得清页数。
 *
 * ## 分页规则（§8.3）
 *
 * - **不把一个小节截断到两页**：整行一起换页。
 * - **段落标题不和它的小节分离**：放标题之前先检查「标题 + 第一行小节」放不放得下。
 *
 * ## 尺寸
 *
 * 版面按 A4 纵横比（900 × 1273 逻辑像素），导出时乘 `scale`（默认 2.5），
 * 所以一张图大约 2250 × 3183，打印和放屏都够用。
 *
 * @module ui/png
 */

import { TIME_SIGNATURES, getBeatsPerBar, normalizeDisplayLines } from '../core/constants.js';
import { getThemeColors, DEFAULT_THEME } from '../core/theme.js';
import { canShowDegrees } from '../core/degrees.js';
import { eventDisplayLines } from './chart.js';
import { formatBeatsLabel } from './dom.js';

/** 数据里存的是 ASCII 的 # / b，画到图上要换成 ♯ / ♭。 */
function glyph(text) {
  return String(text ?? '').replace(/#/g, '♯').replace(/b/g, '♭');
}

/** 版面（逻辑像素）。比例接近 A4 纵向。导出到 PDF 时它同时就是页面尺寸（pt）。 */
export const PAGE = Object.freeze({ width: 900, height: 1273, margin: 56 });

const FONT_STACK = 'system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", "PingFang SC", sans-serif';

/**
 * 当前活跃的色表。颜色唯一真相在 `core/theme.js`（SPEC §9.2），这里只保存一个
 * 「当前主题」的可变引用，`buildPngPages` 入口处按 `theme` 参数切换。
 *
 * 渲染代码里历史上有几个键名（`line` / `lineSoft` / `warn`）和主题色表不完全一致，
 * 由 `themeView()` 派生一份对齐视图，避免逐个改绘制调用点。
 */
let COLORS = themeView(DEFAULT_THEME);

/** 把主题色表派生成本模块惯用的键名视图。 */
function themeView(theme) {
  const c = getThemeColors(theme);
  return {
    ink: c.ink,
    inkSoft: c.inkSoft,
    line: c.lineStrong, // 历史 `line` = 深线
    lineSoft: c.line, // 历史 `lineSoft` = 浅线
    accent: c.accent,
    paper: c.paper,
    paperAlt: c.paperAlt, // 空白小节底色
    warn: c.danger, // 6/8 单位提示，沿用原来的红褐色
  };
}

/** 版面尺寸表。集中放这里，改版式只动这一处。 */
const METRICS = Object.freeze({
  titleSize: 30,
  artistSize: 17,
  factSize: 14,
  notesSize: 14,
  sectionSize: 19,
  sectionHeadHeight: 34,
  symbolSize: 20,
  beatsSize: 11,
  sectionGap: 22,
  rowGap: 8,
  /** 只显示一行时的块高（基准）。每多一行再增加 `barHeightPerLine` —— 多行只增高，不加宽。 */
  barBaseHeight: 66,
  barHeightPerLine: 21,
  barGap: 6,
  footerSize: 11,
});

/** 次行（级数行）相对主行（和弦名）的字号比例。 */
const SECONDARY_LINE_SCALE = 0.86;

function setFont(ctx, size, weight = '400') {
  ctx.font = `${weight} ${size}px ${FONT_STACK}`;
}

/**
 * 这首歌的一个和弦块实际会显示几行（SPEC §8.1.1）。
 *
 * 小调时级数行会被跳过、只剩和弦名 —— 这里的判断必须和屏幕渲染保持一致，
 * 否则 PNG 的块高会比屏幕上多一行，两边对不上。
 */
function displayRowCount(song) {
  const degreeUsable = canShowDegrees(song.key).ok;
  const lines = normalizeDisplayLines(song.layout?.displayLines).filter(
    (line) => line === 'chord' || degreeUsable,
  );
  return Math.max(lines.length, 1);
}

/** 按实际行数算块高。宽度不受行数影响（§8.2）。 */
function barHeightFor(song) {
  return METRICS.barBaseHeight + (displayRowCount(song) - 1) * METRICS.barHeightPerLine;
}

/**
 * 这首歌有没有任何歌词（SPEC §8.9）。
 *
 * 分页高度必须和实际绘制一致：只要有歌词就统一把块高加上歌词行，否则有词的小节
 * 会被挤到下一页、甚至和小节框重叠。用「整首歌是否有词」这个统一判据，比分页时
 * 逐小节判断更稳——块高是每页排版的分母，不能忽大忽小。
 */
function hasLyrics(song) {
  return (song.sections ?? []).some((section) =>
    (section.bars ?? []).some((bar) =>
      Array.isArray(bar.lyrics) && bar.lyrics.some((fragment) => fragment && String(fragment.text ?? '').trim() !== ''),
    ),
  );
}

/** 歌词行画在小节框下方，占的额外高度。 */
const LYRIC_ROW_HEIGHT = 16;

/**
 * 级数里「小字后缀」的排版参数（SPEC §6.6 的四档，切分规则见 `core/degrees.js`）。
 *
 * 两档共用一个缩放比、只是偏移方向相反：
 *
 * - **角标（缺省）往下沉**，让它落在右下角 —— 上标会被读成幂（`5` 的 `7` 次方），
 *   这正是要避开的那种误读。
 * - **上标往上浮**，是设置里明确选出来的档（有人不在乎那个误读、或者就要 `5⁷` 这个观感）。
 *
 * 缩放比保持一致，是为了让两档切换时只有「往哪偏」变化 ——
 * 字号一起变的话，用户切档之后看到的是「变大了也挪位了」两件事，说不清哪个才是他改的。
 *
 * `'plain'` 与 `'parens'` 两档不产生 `script` 标记，走普通绘制路径，用不到这两个值。
 */
const SCRIPT_SCALE = 0.68;
const SUBSCRIPT_DROP = 0.32;
const SUPERSCRIPT_RISE = 0.42;

/** 逐字符换行。中文按字、西文按字断开——够用，而且不会算错行数。 */
function wrapLines(ctx, text, maxWidth) {
  const lines = [];
  let current = '';
  for (const char of String(text ?? '')) {
    if (char === '\n') {
      lines.push(current);
      current = '';
      continue;
    }
    const test = current + char;
    if (ctx.measureText(test).width > maxWidth && current !== '') {
      lines.push(current);
      current = char;
    } else {
      current = test;
    }
  }
  if (current !== '') lines.push(current);
  return lines;
}

/** 圆角矩形路径。 */
function roundRect(ctx, x, y, width, height, radius) {
  const r = Math.min(radius, width / 2, height / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + width - r, y);
  ctx.quadraticCurveTo(x + width, y, x + width, y + r);
  ctx.lineTo(x + width, y + height - r);
  ctx.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
  ctx.lineTo(x + r, y + height);
  ctx.quadraticCurveTo(x, y + height, x, y + height - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

/** 把「每行小节数」拆成一行一行的小节。 */
function layoutBars(section, barsPerRow) {
  const rows = [];
  for (let index = 0; index < section.bars.length; index += barsPerRow) {
    rows.push(
      section.bars.slice(index, index + barsPerRow).map((bar, offset) => ({
        bar,
        barIndex: index + offset,
      })),
    );
  }
  return rows;
}

/** 谱头（标题 / 艺人 / 事实 / 备注）画在第 1 页顶部。 */
function drawHeader(ctx, song) {
  let y = PAGE.margin;
  const contentWidth = PAGE.width - PAGE.margin * 2;

  setFont(ctx, METRICS.titleSize, '700');
  ctx.fillStyle = COLORS.ink;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  for (const line of wrapLines(ctx, song.title, contentWidth)) {
    ctx.fillText(line, PAGE.margin, y);
    y += METRICS.titleSize * 1.3;
  }

  if (song.artist) {
    setFont(ctx, METRICS.artistSize);
    ctx.fillStyle = COLORS.inkSoft;
    ctx.fillText(song.artist, PAGE.margin, y);
    y += METRICS.artistSize * 1.5;
  }

  const timeSignature = TIME_SIGNATURES[song.timeSignature];
  const tempoNote = timeSignature?.beatNote === 'eighth' ? '♪' : '♩';
  const facts = [
    `调号 ${glyph(song.key.tonic)} 大调`,
    `拍号 ${song.timeSignature}`,
    `${tempoNote} = ${song.bpm}`,
    song.style ? `风格 ${song.style}` : null,
  ].filter(Boolean);

  setFont(ctx, METRICS.factSize);
  ctx.fillStyle = COLORS.inkSoft;
  ctx.fillText(facts.join('   ·   '), PAGE.margin, y);
  y += METRICS.factSize * 2;

  if (song.timeSignature === '6/8') {
    setFont(ctx, METRICS.factSize);
    ctx.fillStyle = COLORS.warn;
    ctx.fillText('单位提示：1 拍 = 八分音符，每小节 6 拍', PAGE.margin, y);
    y += METRICS.factSize * 1.6;
  }

  if (song.notes) {
    setFont(ctx, METRICS.notesSize);
    ctx.fillStyle = COLORS.inkSoft;
    for (const line of wrapLines(ctx, song.notes, contentWidth)) {
      ctx.fillText(line, PAGE.margin, y);
      y += METRICS.notesSize * 1.5;
    }
  }

  // 谱头下面一条分隔线，和谱面内容分开。
  y += 6;
  ctx.strokeStyle = COLORS.lineSoft;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(PAGE.margin, y);
  ctx.lineTo(PAGE.width - PAGE.margin, y);
  ctx.stroke();

  return y + METRICS.sectionGap;
}

/** 画一行小节。 */
function drawBarRow(ctx, row, y, { song, beatsPerBar, contentWidth, barsPerRow, barHeight }) {
  const barWidth = (contentWidth - METRICS.barGap * (barsPerRow - 1)) / barsPerRow;
  const withLyrics = hasLyrics(song);
  // 框高已经包含歌词行（buildPngPages 里加过），这里把歌词行从框底部分出来。
  const lyricBand = withLyrics ? LYRIC_ROW_HEIGHT : 0;
  const chordBoxHeight = barHeight - lyricBand;

  row.forEach((entry, column) => {
    const x = PAGE.margin + column * (barWidth + METRICS.barGap);
    const { bar } = entry;

    // 小节框
    roundRect(ctx, x, y, barWidth, barHeight, 5);
    ctx.fillStyle = bar.type === 'empty' ? COLORS.paperAlt : COLORS.paper;
    ctx.fill();
    ctx.strokeStyle = COLORS.lineSoft;
    ctx.lineWidth = 1;
    if (bar.type === 'empty') ctx.setLineDash([4, 3]);
    ctx.stroke();
    ctx.setLineDash([]);

    // 小节序号（画在框内左上角，不占宽度）
    setFont(ctx, 10);
    ctx.fillStyle = COLORS.inkSoft;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText(String(entry.barIndex + 1), x + 5, y + 4);

    if (bar.type === 'empty') {
      setFont(ctx, 13);
      ctx.fillStyle = COLORS.inkSoft;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('空白', x + barWidth / 2, y + chordBoxHeight / 2 + 4);
      return;
    }

    // 事件：宽度严格按时值比例分配（§8.2）
    const totalBeats = bar.events.reduce((sum, event) => sum + event.beats, 0) || beatsPerBar;
    const usable = barWidth - 10;
    let cursor = x + 5;

    bar.events.forEach((event, eventIndex) => {
      const ratio = event.beats / totalBeats;
      const width = usable * ratio;
      const centerX = cursor + width / 2;
      // 和弦之间的细分隔线，让时值比例看得见
      if (eventIndex > 0) {
        ctx.strokeStyle = COLORS.lineSoft;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(cursor, y + 20);
        ctx.lineTo(cursor, y + chordBoxHeight - 6);
        ctx.stroke();
      }

      const { lines } = eventDisplayLines(event, song);
      const weight = event.kind === 'chord' ? '600' : '400';

      // 角标 / 上标画小一号，其余段按原字号（`sizeOf` 是唯一的判据来源）。
      const sizeOf = (base, part) => (part.script === null || part.script === undefined ? base : base * SCRIPT_SCALE);

      const measureParts = (base, parts) =>
        parts.map((part) => {
          setFont(ctx, sizeOf(base, part), weight);
          return ctx.measureText(glyph(part.text)).width;
        });
      const totalOf = (widths) => widths.reduce((sum, w) => sum + w, 0);

      // 行数与屏幕一致（§8.1.1）：第一行是主行，其余是次行、小一档。
      const regionTop = y + 6;
      const regionHeight = chordBoxHeight - 22;
      const step = regionHeight / lines.length;

      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';

      lines.forEach((entry, lineIndex) => {
        const primary = lineIndex === 0;
        const baseSize = METRICS.symbolSize * (primary ? 1 : SECONDARY_LINE_SCALE);

        let size = baseSize;
        let widths = measureParts(size, entry.parts);

        while (size > 8 && totalOf(widths) > width - 6) {
          size -= 1;
          widths = measureParts(size, entry.parts);
        }

        const baseline = regionTop + step * (lineIndex + 0.5);
        ctx.fillStyle = primary && event.kind === 'chord' ? COLORS.ink : COLORS.inkSoft;

        let drawX = centerX - totalOf(widths) / 2;
        entry.parts.forEach((part, partIndex) => {
          const fontSize = sizeOf(size, part);
          setFont(ctx, fontSize, weight);
          const drawY =
            part.script === 'sub'
              ? baseline + fontSize * SUBSCRIPT_DROP
              : part.script === 'sup'
                ? baseline - fontSize * SUPERSCRIPT_RISE
                : baseline;
          ctx.fillText(glyph(part.text), drawX, drawY);
          drawX += widths[partIndex];
        });
      });

      // 拍数标签仍然居中
      ctx.textAlign = 'center';
      setFont(ctx, METRICS.beatsSize);
      ctx.fillStyle = COLORS.inkSoft;
      ctx.fillText(formatBeatsLabel(event.beats), centerX, y + chordBoxHeight - 13);

      cursor += width;
    });

    // 歌词行（SPEC §8.9）：画在小节框底部，按事件比例对齐。
    if (withLyrics && Array.isArray(bar.lyrics)) {
      const lyricY = y + chordBoxHeight + 4;
      const totalBeatsLyric = bar.events.reduce((sum, event) => sum + event.beats, 0) || beatsPerBar;
      let lx = x + 5;
      bar.events.forEach((event, eventIndex) => {
        const fragment = bar.lyrics[eventIndex];
        const text = fragment ? String(fragment.text ?? '').trim() : '';
        const width = usable * (event.beats / totalBeatsLyric);
        if (text !== '') {
          setFont(ctx, 12);
          ctx.fillStyle = COLORS.inkSoft;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'top';
          // 片段内多字均匀铺开：按字符数均分宽度逐个画，让「字对着和弦」成立。
          const chars = [...text];
          const charWidth = width / Math.max(chars.length, 1);
          chars.forEach((char, charIndex) => {
            const cx = lx + charWidth * (charIndex + 0.5);
            ctx.fillText(char, cx, lyricY);
          });
        }
        lx += width;
      });
    }

    // 自由文字块（SPEC §8.10）：画在小节框内，按 x/y 比例坐标定位，支持 \n 换行。
    // 文字是主角、必须大：字号对齐和弦主行（symbolSize），顶部对齐往下长，跟屏幕一致。
    if (Array.isArray(bar.textBlocks)) {
      bar.textBlocks.forEach((block) => {
        const text = String(block.text ?? '').trim();
        if (text === '') return;
        const bx = x + (Number.isFinite(block.x) ? block.x : 0.5) * barWidth;
        const by = y + (Number.isFinite(block.y) ? block.y : 0.5) * barHeight;
        const lines = text.split('\n');
        setFont(ctx, METRICS.symbolSize, '600');
        ctx.fillStyle = COLORS.ink;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        const lineHeight = METRICS.symbolSize * 1.3;
        lines.forEach((line, lineIndex) => {
          ctx.fillText(line, bx, by + lineIndex * lineHeight);
        });
      });
    }
  });

  return y + barHeight + METRICS.rowGap;
}

/**
 * 把整首歌画成若干页 canvas。
 *
 * @param {import('../core/song.js').Song} song
 * @param {{scale?: number}} [options]
 * @returns {{pages: Array<{index: number, canvas: HTMLCanvasElement}>, cols: number}}
 */
export function buildPngPages(song, options = {}) {
  const scale = options.scale ?? 2.5;
  // 切换到当前主题的色表。颜色随主题走（SPEC §9.2），屏幕、打印、导出共用一份。
  COLORS = themeView(options.theme ?? DEFAULT_THEME);
  const cols = song.layout.barsPerRow;
  const beatsPerBar = getBeatsPerBar(song.timeSignature);
  const contentWidth = PAGE.width - PAGE.margin * 2;
  const bottomLimit = PAGE.height - PAGE.margin - 24;
  // 块高由显示行数决定，有歌词时再往下加歌词行。分页判断和实际绘制必须用**同一个**值。
  const barHeight = barHeightFor(song) + (hasLyrics(song) ? LYRIC_ROW_HEIGHT : 0);

  /** @type {Array<{index: number, canvas: HTMLCanvasElement}>} */
  const pages = [];
  let ctx = null;
  let y = 0;

  function newPage() {
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(PAGE.width * scale);
    canvas.height = Math.round(PAGE.height * scale);
    const context = canvas.getContext('2d');
    if (!context) throw new Error('无法创建 canvas 画布（浏览器不支持 2D 上下文）');
    context.scale(scale, scale);
    context.fillStyle = COLORS.paper;
    context.fillRect(0, 0, PAGE.width, PAGE.height);
    context.textBaseline = 'top';
    pages.push({ index: pages.length, canvas });
    ctx = context;
    y = PAGE.margin;
    return context;
  }

  newPage();
  y = drawHeader(ctx, song);

  song.sections.forEach((section, sectionIndex) => {
    const rows = layoutBars(section, cols);
    const isFirstSection = sectionIndex === 0;

    // 段落标题不和它的小节分离（§8.3）：放标题之前先确认第一行放得下。
    if (!isFirstSection) {
      const needed = METRICS.sectionHeadHeight + barHeight;
      if (y + needed > bottomLimit) {
        newPage();
        y = PAGE.margin;
        // 续页也标一下歌曲名，打印出来散页了也知道是哪首。
        setFont(ctx, 12);
        ctx.fillStyle = COLORS.inkSoft;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'top';
        ctx.fillText(`${song.title}（续）`, PAGE.margin, y);
        y += 24;
      }
    }

    // 段落标题
    setFont(ctx, METRICS.sectionSize, '700');
    ctx.fillStyle = COLORS.accent;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    const headText = section.repeat > 1 ? `${section.name}  ×${section.repeat}` : section.name;
    ctx.fillText(headText, PAGE.margin, y);
    if (section.cue) {
      setFont(ctx, 12);
      ctx.textAlign = 'right';
      ctx.fillStyle = COLORS.inkSoft;
      ctx.fillText(section.cue, PAGE.width - PAGE.margin, y + 5);
    }
    y += METRICS.sectionHeadHeight;

    rows.forEach((row) => {
      // 整行一起换页，绝不把小节截断到两页（§8.3）
      if (y + barHeight > bottomLimit) {
        newPage();
        setFont(ctx, 12);
        ctx.fillStyle = COLORS.inkSoft;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'top';
        ctx.fillText(`${song.title}（续） · ${section.name}`, PAGE.margin, y);
        y += 24;
      }
      y = drawBarRow(ctx, row, y, { song, beatsPerBar, contentWidth, barsPerRow: cols, barHeight });
    });

    y += METRICS.sectionGap;
  });

  // 页脚：页码 / 总页数 / 本页属于哪首（打印出来散页也能对回去）
  pages.forEach((page, index) => {
    const context = page.canvas.getContext('2d');
    context.save();
    context.setTransform(scale, 0, 0, scale, 0, 0);
    setFont(context, METRICS.footerSize);
    context.fillStyle = COLORS.inkSoft;
    context.textAlign = 'center';
    context.textBaseline = 'bottom';
    context.fillText(
      `${song.title} · 第 ${index + 1} / ${pages.length} 页`,
      PAGE.width / 2,
      PAGE.height - PAGE.margin / 2,
    );
    context.restore();
  });

  return { pages, cols };
}

/**
 * 把 canvas 转成指定 MIME 的 Blob。
 *
 * @param {HTMLCanvasElement} canvas
 * @param {'image/png'|'image/jpeg'} [mime]
 * @param {number} [quality] 仅对 JPEG 生效（0–1）
 * @returns {Promise<Blob>}
 */
export function canvasToBlob(canvas, mime = 'image/png', quality) {
  return new Promise((resolve, reject) => {
    try {
      canvas.toBlob(
        (blob) => {
          if (blob) resolve(blob);
          else reject(new Error('浏览器返回了空的图片数据'));
        },
        mime,
        quality,
      );
    } catch (error) {
      reject(error);
    }
  });
}

/** 文件系统不接受的字符换掉，和控制台里的工程文件名保持一套规则。 */
export function safeBaseName(song) {
  const raw = [song.title, song.artist].filter(Boolean).join('-') || '功能谱';
  return raw.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 60) || '功能谱';
}
