/**
 * 谱面渲染。
 *
 * 编辑、预览、演出、打印、PNG **共用这一套渲染规则**（docs/SPEC.md §8）：
 * 和弦按 `时值 ÷ 每小节拍数` 占水平空间，空白小节保留与普通小节相同的宽度，
 * 每行小节数由 `layout.barsPerRow` 决定。差异只在「显示多少控件」，
 * 不在「音乐内容怎么摆」——否则屏幕上看到的和导出的会是两份东西。
 *
 * ## 排版上三个容易做错的地方
 *
 * 1. **事件的宽度必须只由时值决定**：`flex: 0 1 0` + 内联 `flex-grow`。
 *    只要让内容撑开宽度，`C` 和 `Bbmaj7` 就会各占一块，
 *    「和弦按时值占位」这条就废了，而且废得很安静。
 * 2. **`minmax(0, 1fr)` 而不是 `1fr`**：栅格轨道默认最小宽度是 `auto`，
 *    长和弦名会顶宽整列，在 390px 上直接引发横向滚动（§9 不允许）。
 * 3. **小节序号只在编辑模式出现**，而且是「段落内第几小节」——
 *    这正好是 `edit.js` 定位小节用的坐标，不会出现「屏幕上的序号和操作对不上」。
 *
 * @module ui/chart
 */

import {
  DEGREE_LINE_IDS,
  TIME_SIGNATURES,
  getBeatsPerBar,
  getRestText,
  normalizeDisplayLines,
  usesAccidentalGlyphs,
} from '../core/constants.js';
import { formatChordSymbol } from '../core/chord.js';
import { canShowDegrees, formatChordForDisplay } from '../core/degrees.js';
import { el, formatBeatsLabel } from './dom.js';
import { melodyRow } from './melody.js';
import { defaultAlignment } from '../core/alignment.js';
import { attachPositionDrag } from './position.js';
import { metaIsSet } from '../core/song.js';
import { renderChordDiagrams } from './chord-diagrams.js';

/**
 * 谱头里的调号。
 *
 * 升降号字形跟随 `accidentalGlyphs`（SPEC §5.1.2）—— 调号也是**音名**，
 * 不加这个参数的话，用户把升降号设成 ASCII 之后谱头会仍然是 `F♯ 大调`，
 * 而谱面里的和弦已经变成 `F#m`，同一页上两种字形并存。
 *
 * @param {{tonic?: string, mode?: string}} key
 * @param {unknown} accidentalGlyphs
 */
function formatKey(key, accidentalGlyphs) {
  if (!key) return '—';
  const ascii = !usesAccidentalGlyphs(accidentalGlyphs);
  const sharp = ascii ? '#' : '♯';
  const flat = ascii ? 'b' : '♭';
  const root = String(key.tonic ?? 'C')
    .replace(/#/g, sharp)
    .replace(/b/g, flat);
  return `${root} ${key.mode === 'minor' ? '小调' : '大调'}`;
}

/** 速度记号：4/4、3/4 的 1 拍是四分音符，6/8 的 1 拍是八分音符（§3.1）。 */
function formatTempoMark(song) {
  const info = TIME_SIGNATURES[song.timeSignature];
  const note = info?.beatNote === 'eighth' ? '♪' : '♩';
  return `${note} = ${song.bpm}`;
}

/** 谱头的一条事实（调号 / 拍号 / 速度 / 风格）。 */
function fact(label, value) {
  return el('span', { class: 'fact' }, [
    el('span', { class: 'fact__label', text: label }),
    el('span', { class: 'fact__value', text: value }),
  ]);
}

/**
 * 一个事件在谱面上要显示的**每一行**（SPEC §8.1.1）。
 *
 * 一个和弦块最多三行：和弦名 / 数字级数 / 罗马级数，显示哪几行由
 * `layout.displayLines` 决定，顺序固定为 `chord → degree → roman`。
 * 休止只占一行，写什么字由 `layout.restText` 决定（§8.1.2）。
 *
 * 抽出来是为了让屏幕上的谱面和导出的 PNG 走**同一个**换算，
 * 否则「级数换算失败要回退到和弦名」这条规则会在两处各写一遍，然后慢慢漂移。
 *
 * `parts` 是每一行文字的语义切分（属七的级数 = `5` + 右下角小角标 `7`）。
 * 屏幕把它渲染成嵌套 span，PNG 导出按段绘制 —— 两边读的是同一份切分，
 * 所以「哪个字符该缩小、往哪偏」这件事只在 `core/degrees.js` 里决定一次。
 *
 * **歌曲里的五个风格字段全部在这里一次性透传下去**（`displayLines` 之外还有
 * `dimSuffix` / `seventhSuffix` / `chordSymbols` / `accidentalGlyphs`）——
 * 这个函数是屏幕与 PNG 的唯一显示关口，漏传一个就会表现为「设置里改了但谱面不变」，
 * 而这种缺陷不会报错、单测也未必覆盖得到。
 *
 * @param {import('../core/song.js').SongEvent} event
 * @param {import('../core/song.js').Song} song
 * @returns {{lines: Array<{line: string, text: string, parts: Array<{text: string, script: null|'sub'|'sup'}>, usedDegree: boolean}>, note: ?string}}
 */
export function eventDisplayLines(event, song) {
  if (event.kind === 'rest') {
    // 休止在谱面上写什么字由 `restText` 决定（SPEC §8.1.2）。
    // 缺省 `'cn'` = 「休止」，等于引入这个开关之前的观感；认不出的值也退化成它。
    //
    // 注意这里**与文本导出无关**：导出的文本里休止恒为 `R`（§4.8），
    // 因为 `R` 是那套语法的记号，不是「怎么写好看」的问题。
    const label = getRestText(song.layout?.restText);
    return {
      lines: [{ line: 'rest', text: label, parts: [{ text: label, script: null }], usedDegree: false }],
      note: null,
    };
  }

  // 小调不支持级数（§6.5）：这里跳过级数行，**只影响渲染、不改数据** ——
  // 所以用户把调号改回大调时，原先选中的那几行还在。
  //
  // 顺手走一遍 `normalizeDisplayLines`：这里是屏幕与 PNG 的唯一显示关口，
  // 而它读的数据来自工程文件和 localStorage。上游当然已经规整过，但
  // 「一个拼错的值就让整个谱面空掉」的代价太大，不值得省这一次过滤。
  const degreeCheck = metaIsSet(song,'key') ? canShowDegrees(song.key) : { ok:false, message:'请填写歌曲调号后使用级数' };
  const requested = normalizeDisplayLines(song.layout?.displayLines);
  const wanted = requested.filter((line) => line === 'chord' || degreeCheck.ok);

  // 级数行因为调式被丢掉时必须**说一声**：用户明明勾了「数字级数」，
  // 谱面上却一行都没有。安静地少显示一行，用户只会以为功能坏了 ——
  // 这里把原因交出去，界面用 `ev__flag` 那个角标显示。
  let note = !degreeCheck.ok && requested.some((line) => DEGREE_LINE_IDS.includes(line))
    ? degreeCheck.message
    : null;

  const lines = (wanted.length > 0 ? wanted : ['chord']).map((line) => {
    // 五个风格字段全部从歌曲带进来，而且**直接透传 `undefined`** ——
    // 它们都是可缺省字段（SPEC §2.2），缺失等价于各自的缺省值。
    // 兜底只写在 `chordToDegree` / `formatChordSymbol` 里各一处，不在这里再来一遍：
    // 两处都兜底的话，改缺省值时总有一处会被忘掉，而忘了不会报错。
    const display = formatChordForDisplay(
      event.chord,
      {
        line,
        key: song.key,
        // 级数行用这两项
        dimSuffix: song.layout?.dimSuffix,
        seventhSuffix: song.layout?.seventhSuffix,
        // 和弦名用这两项（级数行忽略它们，见 core/degrees.js 的说明）
        chordSymbols: song.layout?.chordSymbols,
        accidentalGlyphs: song.layout?.accidentalGlyphs,
      },
      formatChordSymbol,
    );
    if (display.note && note === null) note = display.note;
    return { line, text: display.text, parts: display.parts, usedDegree: display.usedDegree };
  });

  return { lines, note };
}

/**
 * 渲染一个事件。
 *
 * @param {import('../core/song.js').SongEvent} event
 * @param {{beatsPerBar: number, song: import('../core/song.js').Song, editable: boolean,
 *   selected: boolean, onEvent: ?Function, sectionId: string, barIndex: number, eventIndex: number}} ctx
 * @returns {HTMLElement}
 */
function renderEvent(event, ctx) {
  const ratio = Math.max(event.beats / ctx.beatsPerBar, 0.001);
  const beatsLabel = formatBeatsLabel(event.beats);
  const classes = ['ev', `ev--${event.kind}`];
  if (ctx.selected) classes.push('is-selected');

  const { lines, note } = eventDisplayLines(event, ctx.song);

  // 需要特殊排版的段单独包一个 span，靠 CSS 缩小并偏移。
  // `'sub'` 沉到右下角（缺省档）、`'sup'` 浮到右上角（SPEC §6.6 的四档里各占一档）。
  // 其余段当作纯文本节点塞进去 —— 仍然走 textContent 那条路，不拼 HTML。
  const partsToNodes = (parts) =>
    parts.map((part) => {
      if (part.script === 'sub') return el('span', { class: 'deg-sub', text: part.text });
      if (part.script === 'sup') return el('span', { class: 'deg-sup', text: part.text });
      return part.text;
    });

  // 第一行是主行（`displayLines` 已按 chord → degree → roman 归一化，
  // 所以有和弦名时主行必然是和弦名），其余行小一档、颜色略淡。
  const lineNodes = lines.map((entry, index) =>
    el(
      'span',
      {
        class: index === 0 ? 'ev__line ev__line--primary' : 'ev__line',
        dataset: { line: entry.line },
      },
      partsToNodes(entry.parts),
    ),
  );

  const primary = lines[0] ?? { text: '', parts: [] };

  const title = [
    `${primary.text} · ${beatsLabel}`,
    note ? `级数换算回退到和弦名：${note}` : null,
    ctx.editable ? '点按编辑这个事件' : null,
  ]
    .filter(Boolean)
    .join('\n');

  // 屏幕阅读器会把 `57` 连读成「五十七」—— 角标在音频里根本不存在，
  // 那个小角标对读屏用户等于没用。段之间留一个空格，读成「五 七」。
  // 没有角标 / 上标时保持原样，不给普通级数（`6m7`、`1/5`）平添空格：
  // 那些后缀自带字母或斜杠，音频里本来就能分开听。
  //
  // `seventhSuffix` 另外两档按各自的实际情况处理，不强行统一：
  // - `'plain'`  —— 可见文字就是 `57`、音频也是「五十七」，两边一样糊。
  //   用户主动选了这个档，这里不单独去改音频 —— 否则会造出「看得见 57、听到五 七」
  //   这个**新的**错位，而那个错位比原来那个更难解释。
  // - `'parens'` —— `5(7)` 自带括号，音频里能听出分组，按原文读就是对的。
  // 多行之间用顿号断开，否则「C，1」会被连读成「C1」。
  const spoken = lines
    .map((entry) =>
      entry.parts.length > 1 && entry.parts.some((part) => part.script === 'sub' || part.script === 'sup')
        ? entry.parts.map((part) => part.text).join(' ')
        : entry.text,
    )
    .join('，');

  const children = [
    el('span', { class: 'ev__lines' }, lineNodes),
    el('span', { class: 'ev__beats', text: beatsLabel }),
    note ? el('span', { class: 'ev__flag', text: '级数不可用', title: note }) : null,
  ];

  const props = {
    class: classes.join(' '),
    style: `flex-grow:${ratio}`,
    title,
    dataset: { focusKey: `ev-${ctx.sectionId}-${ctx.barIndex}-${ctx.eventIndex}` },
  };

  if (!ctx.editable) return el('div', props, children);

  return el('button', {
    ...props,
    type: 'button',
    'aria-label': `第 ${ctx.barIndex + 1} 小节第 ${ctx.eventIndex + 1} 个事件：${spoken}，${beatsLabel}，点按编辑`,
    onClick: () => ctx.onEvent(ctx.sectionId, ctx.barIndex, ctx.eventIndex),
  }, children);
}

/**
 * 渲染一个小节。
 *
 * @param {import('../core/song.js').Bar} bar
 * @param {{song: Object, beatsPerBar: number, editable: boolean, sectionId: string,
 *   barIndex: number, selectedBar: boolean, selectedEventIndex: ?number,
 *   hasWarning: boolean, onBar: ?Function, onEvent: ?Function}} ctx
 * @returns {HTMLElement}
 */
function renderBar(bar, ctx) {
  ctx = { ...ctx, beatsPerBar: bar.length ?? ctx.beatsPerBar };
  const classes = ['bar'];
  if (bar.type === 'empty') classes.push('bar--empty');
  if (ctx.selectedBar) classes.push('is-selected');
  if (ctx.hasWarning) classes.push('bar--warn');
  // 有文字块时，小节底部多留一块「文字栏」，给字一个明确的下方落脚点（§8.10）。
  if (Array.isArray(bar.textBlocks) && bar.textBlocks.some((b) => b.text && b.text.trim() !== '')) {
    classes.push('bar--has-text');
  }

  const head = ctx.editable
    ? el(
        'button',
        {
          type: 'button',
          class: 'bar__head',
          title: `第 ${ctx.number} 小节：点按打开小节操作${bar.sourceNumber!==undefined&&bar.sourceNumber!==ctx.number?'（原谱第 '+bar.sourceNumber+' 小节）':''}`,
          'aria-label': `第 ${ctx.number} 小节操作`,
          dataset: { focusKey: `bar-${ctx.sectionId}-${ctx.barIndex}` },
          onClick: () => ctx.onBar(ctx.sectionId, ctx.barIndex),
        },
        [
          el('span', { class: 'bar__no', text: String(ctx.number) }),
          el('span', { class: 'bar__grip', text: '⋯', 'aria-hidden': 'true' }),
        ],
      )
    : el('div', { class: 'bar__head bar__head--static' }, [
        el('span', { class: 'bar__no', text: String(ctx.number) }),
      ]);

  const events =
    bar.type === 'empty'
      ? [el('span', { class: 'bar__empty-label', text: '空白' })]
      : bar.events.map((event, eventIndex) =>
          renderEvent(event, {
            ...ctx,
            eventIndex,
            selected: ctx.selectedEventIndex === eventIndex,
          }),
        );

  // 歌词行（SPEC §8.9）：和事件平行的 flex 行，每个片段用与事件相同的时值比例占位，
  // 这样「字对着和弦」在视觉上成立。片段内的字由 CSS 均匀铺开（justify）。
  const lyrics = renderLyrics(bar, ctx);

  // 自由文字块（SPEC §8.10）：绝对定位浮层，编辑模式下可拖拽。
  const textBlocks = renderTextBlocks(bar, ctx);

  return el('div', { class: classes.join(' '), dataset: { barId: bar.id, sectionId: ctx.sectionId, barIndex: ctx.barIndex } }, [
    head,
    bar.ending ? el('span',{class:'bar-ending',text:bar.ending+'.',title:`第 ${bar.ending} 结尾`}) : null,
    bar.repeatStart ? el('span',{class:'repeat-mark repeat-mark--start',text:'𝄆',title:'反复开始'}) : null,
    bar.repeatEnd ? el('span',{class:'repeat-mark repeat-mark--end',text:'𝄇',title:`反复 ${bar.repeatEnd} 次`},[el('small',{text:'×'+bar.repeatEnd})]) : null,
    el('div', { class: 'bar__events' }, events),
    bar.showMelody === false ? null : melodyRow(bar, ctx),
    lyrics,
    textBlocks,
    ctx.hasWarning
      ? el('span', { class: 'bar__warn', text: '时值', title: '这一小节的时值不合法，导出前需要先处理' })
      : null,
  ]);
}

/**
 * 渲染一个小节上的自由文字块（SPEC §8.10）。
 *
 * 文字块是绝对定位浮层，`x` / `y` 用 0–1 比例换算成实际像素（百分比定位），
 * 这样屏幕 / 导出 / 打印位置一致。编辑模式下可拖拽：拖动文字块本身，
 * 松手时把像素位置换算回 0–1 比例，通过 `ctx.onTextBlockMove` 写回数据。
 *
 * @param {import('../core/song.js').Bar} bar
 * @param {{editable: boolean, sectionId: string, barIndex: number,
 *   onTextBlockMove: ?Function}} ctx
 * @returns {?HTMLElement}
 */
function renderTextBlocks(bar, ctx) {
  if (!Array.isArray(bar.textBlocks) || bar.textBlocks.length === 0) return null;
  const blocks = bar.textBlocks.filter((block) => block.text && block.text.trim() !== '');

  return el(
    'div',
    { class: 'bar__textblocks' },
    blocks.map((block) => {
      const lines = String(block.text).split('\n');
      const content = lines.map((line) => el('span', { class: 'textblock__line', text: line }));

      // 百分比定位：x*100% 相对左边，y*100% 相对顶部。
      const style = `left:${Math.round(block.x * 1000) / 10}%;top:${Math.round(block.y * 1000) / 10}%`;
      const node = el('div', {
        class: 'textblock',
        style,
        dataset: { blockId: block.id, focusKey: `txt-${block.id}` },
        title: ctx.editable ? '拖动调整位置' : null,
      }, content);

      if (ctx.editable && ctx.onTextBlockMove) {
        node.draggable = false; // 不用原生 drag，用 pointer 事件做拖拽（触屏 + 桌面通用）
        node.tabIndex=0;node.setAttribute('role','button');node.setAttribute('aria-label','拖动文字块 '+block.text);
        attachPositionDrag(node,block,()=>node.parentElement.getBoundingClientRect(),(position)=>ctx.onTextBlockMove(ctx.sectionId,ctx.barIndex,block.id,position));
      }
      return node;
    }),
  );
}

/**
 * 渲染一个小节下方的歌词行（逐字对齐，SPEC §8.9）。
 *
 * 歌词按事件下标对齐：`bar.lyrics[i]` 落在 `bar.events[i]` 下方。每个片段用与事件
 * 相同的 `flex-grow`（时值比例）占位，片段内多字靠 CSS 均匀分布。没有任何歌词时
 * 返回 null，不占一行——否则每小节都凭空多出空白，把谱面拉长。
 *
 * @param {import('../core/song.js').Bar} bar
 * @param {{beatsPerBar: number}} ctx
 * @returns {?HTMLElement}
 */
function renderLyrics(bar, ctx) {
  if(ctx.song.layout.showLyrics === false)return null;
  const alignment=bar.alignment??defaultAlignment(bar,ctx.song);
  if(!alignment.words.length)return null;
  const row=el('div',{class:'bar__lyrics-free','aria-label':'逐字歌词',style:`height:${alignment.height}px`});
  const free=el('div',{class:'bar__free-lyrics','aria-label':'自由位置歌词'});
  alignment.words.forEach((word,index)=>{
    const node=el(ctx.editable?'button':'span',{class:'word-token',type:ctx.editable?'button':null,text:word.text,dataset:{focusKey:`word-${bar.id}-${index}`},style:`left:${word.x*100}%;top:${word.y*100}%;font-size:${word.scale}em`,title:ctx.editable?'点按放大编辑，拖动调整位置':'歌词','aria-label':ctx.editable?'调整歌词 '+word.text:null,onClick:ctx.editable?()=>ctx.onAlignment?.(ctx.sectionId,ctx.barIndex,{kind:'word',index}):null});
    if(ctx.editable&&ctx.onWordMove)attachPositionDrag(node,word,()=>word.free?node.closest('.bar').getBoundingClientRect():row.getBoundingClientRect(),(position)=>ctx.onWordMove(ctx.sectionId,ctx.barIndex,index,position));
    (word.free?free:row).append(node);
  });
  return el('div',{class:'lyric-layers'},[row,free]);
}

/**
 * 谱面上每个小节至少要有这么宽才够用。
 *
 * 依据：一个和弦块要能被手指点中（§9 要求常用触控目标 ≥ 44px），
 * 而一个小节里通常有 2 个和弦，所以 2 × 44 取整到 88。
 */
export const MIN_BAR_WIDTH = 88;

/**
 * 按可用宽度算「实际每行排几个小节」。
 *
 * 数据里的 `barsPerRow` 是用户设置，但在 390px 的手机上硬按 4 个排，
 * 每个和弦块会缩到 33px 左右——而**点按和弦是这个应用最频繁的操作**。
 * 所以窄屏上往下取到排得下的档位（8 / 4 / 2 / 1），
 * 并且在谱面上明确写出「现在按每行 N 小节显示」。
 *
 * 这**不是**静默改设置：`song.layout.barsPerRow` 一个字节都没动，
 * 打印和 PNG 导出仍然严格按设置来（那边宽度是 A4，不受屏幕限制）。
 *
 * @param {number} setting 数据里的设置值（2 / 4 / 8）
 * @param {number} availableWidth 谱面可用宽度（像素）
 * @param {{gap?: number}} [options]
 * @returns {{cols: number, capped: boolean}}
 */
export function effectiveColumns(setting, availableWidth, options = {}) {
  const gap = options.gap ?? 6;
  if (!Number.isFinite(availableWidth) || availableWidth <= 0) return { cols: setting, capped: false };

  for (const candidate of [8, 4, 2, 1]) {
    if (candidate > setting) continue;
    const barWidth = (availableWidth - gap * (candidate - 1)) / candidate;
    if (barWidth >= MIN_BAR_WIDTH) return { cols: candidate, capped: candidate !== setting };
  }
  return { cols: 1, capped: setting !== 1 };
}

/**
 * 渲染整份谱面。
 *
 * @param {import('../core/song.js').Song} song
 * @param {{mode?: 'edit'|'preview'|'present', selection?: ?Object,
 *   warnBars?: Set<string>, availableWidth?: number,
 *   onSection?: ?Function, onBar?: ?Function, onEvent?: ?Function}} [options]
 * @returns {HTMLElement}
 */
export function renderChart(song, options = {}) {
  const mode = options.mode ?? 'edit';
  const editable = mode === 'edit';
  const beatsPerBar = getBeatsPerBar(song.timeSignature);
  const timeSignatureInfo = TIME_SIGNATURES[song.timeSignature];
  const warnBars = options.warnBars ?? new Set();
  const selection = options.selection ?? null;
  const degreeSupport = metaIsSet(song,'key') ? canShowDegrees(song.key) : {ok:false,message:'请填写歌曲调号'};
  // 「用户选了级数行」与「这个调号能不能算级数」是两件事，分开判断（§6.5、§8.1.1）
  const wantsDegrees = (song.layout.displayLines ?? []).some((line) => line !== 'chord');

  // 每行几个小节：设置值 vs 这个屏幕实际排得下的值
  const settingBarsPerRow = song.layout.barsPerRow;
  const columns = options.availableWidth
    ? effectiveColumns(settingBarsPerRow, options.availableWidth)
    : { cols: settingBarsPerRow, capped: false };

  const header = el('header', { class: 'paper__header' }, [
    el('h2', { class: `paper__title${!song.title ? ' is-placeholder' : ''}`, text: song.title || (editable ? '歌名' : '') }),
    song.artist || (editable && !song.title) ? el('p', { class: `paper__artist${!song.artist ? ' is-placeholder' : ''}`, text: song.artist || '作者 / 歌手' }) : null,
    song.layout.showMeta !== false ? el('div', { class: 'paper__facts' }, [
      metaIsSet(song, 'key') ? fact('调号', formatKey(song.key, song.layout?.accidentalGlyphs)) : null,
      song.capo ? fact('变调夹', `${song.capo} 品`) : null,
      song.layout?.numberedKey ? fact('简谱 1=', formatKey({ tonic: song.layout.numberedKey, mode: 'major' }, song.layout?.accidentalGlyphs).replace(/ 大调$/, '')) : null,
      metaIsSet(song, 'timeSignature') ? fact('拍号', song.timeSignature) : null,
      metaIsSet(song, 'bpm') ? fact('速度', formatTempoMark(song)) : null,
      song.style ? fact('风格', song.style) : null,
    ]) : null,
    // 窄屏上减少了每行小节数时，必须说出来——否则用户会以为自己的设置没生效。
    columns.capped
      ? el('p', {
          class: 'paper__hint no-print',
          text: `这一个屏幕放不下每行 ${settingBarsPerRow} 小节，现在按每行 ${columns.cols} 小节显示，这样每个和弦才点得准。歌曲设置本身没有被改动，打印和导出的 PNG 仍然按 ${settingBarsPerRow} 小节一行。`,
        })
      : null,
    // 6/8 必须写明单位（§3.1）：不写的话 C:2 到底指两个八分音符还是两个大拍没法读。
    timeSignatureInfo && song.timeSignature === '6/8'
      ? el('p', { class: 'paper__hint', text: `单位提示：${timeSignatureInfo.hint}` })
      : null,
    wantsDegrees && !degreeSupport.ok
      ? el('p', { class: 'paper__hint paper__hint--warn', text: `当前调号无法显示级数，已按和弦名显示：${degreeSupport.message}` })
      : null,
    song.notes && song.layout.showCues !== false ? el('p', { class: 'paper__notes', text: song.notes }) : null,
  ]);

  let globalNumber=(song.sections[0]?.bars[0]?.sourceNumber??1)-1;
  const sections = song.sections.map((section, sectionIndex) => {
    const headChildren = [
      el('h3', { class: 'sec__name', text: section.name }),
      section.repeat > 1 ? el('span', { class: 'sec__repeat', text: `×${section.repeat}` }) : null,
      el('span', { class: 'sec__count', text: `${section.bars.length} 小节` }),
    ];

    const head = editable
      ? el(
          'button',
          {
            type: 'button',
            class: 'sec__head',
            title: '点按编辑这个段落',
            'aria-label': `编辑段落 ${section.name}`,
            dataset: { focusKey: `sec-${section.id}` },
            onClick: () => options.onSection?.(section.id),
          },
          headChildren,
        )
      : el('div', { class: 'sec__head sec__head--static' }, headChildren);

    const grid = el(
      'div',
      {
        class: 'sec__grid',
        // 两个变量，不是一个：屏幕上用降档后的列数，打印用设置值。
        // 打印复用的是**同一份 DOM**，所以如果只写 `--cols`，
        // 在手机 (降成 2 列) 上按打印就会印出「每行 2 小节」——
        // 那不是用户设置的东西，而 §8 要求打印严格按设置。
        style: `--cols:${columns.cols};--cols-print:${settingBarsPerRow}`,
      },
      section.bars.map((bar, barIndex) =>
        renderBar(bar, {
          song,
          beatsPerBar,
          editable,
          sectionId: section.id,
          barIndex,
          number:++globalNumber,
          selectedBar: selection?.sectionId === section.id && selection?.barIndex === barIndex,
          selectedEventIndex:
            selection?.sectionId === section.id && selection?.barIndex === barIndex
              ? (selection?.eventIndex ?? null)
              : null,
          hasWarning: warnBars.has(`${sectionIndex}#${barIndex}`),
          onBar: options.onBar,
          onEvent: options.onEvent,
          onMelody: options.onMelody,
          onTextBlockMove: options.onTextBlockMove,
          onAlignment: options.onAlignment,
          onWordMove: options.onWordMove,
        }),
      ),
    );

    return el('section', { class: 'sec' }, [
      head,
      section.cue && song.layout.showCues !== false ? el('p', { class: 'sec__cue', text: section.cue }) : null,
      grid,
    ]);
  });

  return el(
    'div',
    {
      class: `paper paper--${mode}${song.layout.compact?' paper--compact':''}${song.layout.showBarNumbers===false?' paper--no-numbers':''}`,
      style: `--font-scale:${song.layout.fontScale};--lyric-scale:${song.layout.lyricScale??1};--chord-scale:${song.layout.chordScale??1}`,
      dataset: { displayLines: (song.layout.displayLines ?? []).join(',') },
    },
    [header, renderChordDiagrams(song, options), el('div', { class: 'paper__body' }, sections)],
  );
}

/**
 * 从 `collectDurationIssues()` 的结果算出「哪些小节有问题」，
 * 供谱面标红。键是 `段落下标#小节下标`。
 *
 * @param {Array<{sectionIndex?: number, barIndex?: number}>} issues
 * @returns {Set<string>}
 */
export function buildWarnBarSet(issues) {
  const set = new Set();
  for (const issue of issues) {
    if (typeof issue.sectionIndex === 'number' && typeof issue.barIndex === 'number') {
      set.add(`${issue.sectionIndex}#${issue.barIndex}`);
    }
  }
  return set;
}
