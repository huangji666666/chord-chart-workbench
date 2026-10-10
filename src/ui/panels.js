/**
 * 侧栏与横幅：歌曲信息、曲库、文本输入、工程文件、时值问题、存储告警。
 *
 * ## 提交时机是这一层最关键的判断
 *
 * 表单里的文本输入一律在 **`change`（失焦或回车）** 时提交一次，而不是 `input`
 * 每敲一个字提交一次。原因见 docs/SPEC.md §7.2：撤销的粒度是「一次用户操作」。
 * 如果每个字符都提交，用户想撤掉刚打错的一个和弦名，得按二十次撤销。
 *
 * 代价是失焦瞬间可能提交失败（比如标题被清空）。这时**必须把输入框的值改回
 * 歌曲里的真实值**——否则屏幕上显示的是一个并不存在于数据里的状态，
 * 那比报错更糟：用户会以为改成功了。
 *
 * @module ui/panels
 */

import {
  DEFAULT_ACCIDENTAL_GLYPHS,
  DEFAULT_CHORD_SYMBOLS,
  DEFAULT_DIM_SUFFIX,
  DEFAULT_REST_TEXT,
  DEFAULT_SEVENTH_SUFFIX,
  DEFAULT_TEXT_BLOCK_MODE,
  DEGREE_LINE_IDS,
  LIMITS,
  TIME_SIGNATURES,
  TIME_SIGNATURE_IDS,
} from '../core/constants.js';
import { canShowDegrees } from '../core/degrees.js';
import { collectDurationIssues, formatDurationIssues } from '../core/duration.js';
import { THEMES, THEME_IDS, FONT_STYLES, FONT_IDS } from '../core/theme.js';
import { formatParseIssue } from '../core/parser.js';
import { parseSongTextInto, songToText } from '../core/parser.js';
import * as edit from '../core/edit.js';
import { metaIsSet } from '../core/song.js';
import { buildProject, parseProject, serializeProject, suggestProjectFileName } from '../core/project.js';
import {
  pickFiles,
  confirmByTyping,
  confirmDialog,
  toast,
} from './dialogs.js';
import {
  button,
  details,
  downloadText,
  el,
  field,
  formatRelativeTime,
  input,
  select,
  truncate,
} from './dom.js';

/** 调号主音的常用写法（其它写法仍可经文本导入，这里是给手指用的）。 */
const TONIC_OPTIONS = ['C', 'C#', 'Db', 'D', 'Eb', 'E', 'F', 'F#', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];

function glyph(text) {
  return String(text ?? '').replace(/#/g, '♯').replace(/b/g, '♭');
}

/** 一段可折叠的区域，用于把「不常看但要能查到」的内容收起来。 */
function section(title, children, { level = 'h2', className = '', collapsed = false } = {}) {
  // 折叠时复用 dom.js 的 details()：默认收起，点标题展开，展开/收起状态在
  // 面板重建后仍被记住（§9.1 信息层级 —— 侧栏是整块重建的，不记状态会烦人）。
  if (collapsed) {
    return el('div', { class: 'panel panel--collapse' }, [
      details(title, el('div', { class: 'panel__collapsed-body' }, children), { className: 'panel__collapsed-details' }),
    ]);
  }
  return el('section', { class: `panel ${className}`.trim() }, [
    el(level, { class: 'panel__title', text: title }),
    ...children,
  ]);
}

/* ------------------------------------------------------------------ *
 * 歌曲信息表单
 * ------------------------------------------------------------------ */

/**
 * 歌曲信息表单。标题 / 艺人 / 备注 / 调号 / BPM / 拍号 / 风格 / 排版。
 *
 * @param {{store: Object, report: Function}} ctx
 * @returns {HTMLElement}
 */
export function renderSongForm(ctx) {
  const song = ctx.store.getSong();
  const degreeSupport = canShowDegrees(song.key);
  const unsetField = (field) => ctx.store.run('清空歌曲信息', (current) => ({ok:true,value:{...current,unsetMeta:[...new Set([...(current.unsetMeta??[]),field])]}}));

  /** 统一处理字段提交：失败时把控件改回歌曲里的真实值。 */
  function commit(control, label, mutator, restoreTo) {
    const result = ctx.store.run(label, mutator);
    if (!result.ok) {
      ctx.report(result);
      if (restoreTo !== undefined) control.value = restoreTo;
    }
    return result.ok;
  }

  /* 标题 */
  const titleInput = input({
    value: song.title,
    maxLength: LIMITS.titleMaxLength,
    focusKey: 'meta-title',
    ariaLabel: '歌曲标题',
  });
  titleInput.addEventListener('change', () => {
    // 空标题不是「允许的状态」，updateSongMeta 会拒绝；拒绝后要把框里的空值撤回去。
    if (titleInput.value.trim() === '' && !song.unsetMeta) {
      toast('标题不能为空。', { type: 'error' });
      titleInput.value = ctx.store.getSong().title;
      return;
    }
    commit(titleInput, '修改标题', (current) => edit.updateSongMeta(current, { title: titleInput.value }), ctx.store.getSong().title);
  });

  /* 艺人 */
  const artistInput = input({
    value: song.artist,
    maxLength: LIMITS.artistMaxLength,
    focusKey: 'meta-artist',
    ariaLabel: '艺人',
  });
  artistInput.addEventListener('change', () => {
    commit(artistInput, '修改艺人', (current) => edit.updateSongMeta(current, { artist: artistInput.value }), ctx.store.getSong().artist);
  });

  /* 备注 */
  const notesInput = el('textarea', {
    class: 'input input--textarea',
    rows: '3',
    maxlength: String(LIMITS.notesMaxLength),
    'aria-label': '备注',
    dataset: { focusKey: 'meta-notes' },
  });
  notesInput.value = song.notes;
  notesInput.addEventListener('change', () => {
    commit(notesInput, '修改备注', (current) => edit.updateSongMeta(current, { notes: notesInput.value }), ctx.store.getSong().notes);
  });

  /* 调号 */
  const tonicSelect = select({
    value: metaIsSet(song,'key') ? song.key.tonic : '',
    options: [{value:'',label:'未设置'},...TONIC_OPTIONS.map((value) => ({ value, label: glyph(value) }))],
    ariaLabel: '调号主音',
    onChange: (value) => {
      if(!value){unsetField('key');return;}
      commit(
        tonicSelect,
        '修改调号',
        (current) => edit.updateSongMeta(current, { key: { tonic: value } }),
        ctx.store.getSong().key.tonic,
      );
    },
  });

  // 调式：小调这一项**明确置灰**而不是藏起来。藏起来用户会以为是自己没找到，
  // 置灰并说明「小调级数未实现」才是实话（§6.5）。
  const modeSelect = select({
    value: metaIsSet(song,'key') ? song.key.mode : '',
    options: [
      { value:'',label:'未设置' },
      { value: 'major', label: '大调' },
      { value: 'minor', label: '小调（级数显示未实现）', disabled: true },
    ],
    ariaLabel: '调式',
    onChange: () => {},
  });
  modeSelect.disabled = true;

  /* BPM */
  const bpmInput = input({
    value: metaIsSet(song,'bpm') ? String(song.bpm) : '',
    type: 'number',
    min: LIMITS.bpmMin,
    max: LIMITS.bpmMax,
    step: 1,
    inputMode: 'numeric',
    focusKey: 'meta-bpm',
    ariaLabel: 'BPM',
  });
  bpmInput.addEventListener('change', () => {
    if(!bpmInput.value){unsetField('bpm');return;}
    const value = Number(bpmInput.value);
    if (!Number.isInteger(value)) {
      toast('BPM 必须是整数。', { type: 'error' });
      bpmInput.value = String(ctx.store.getSong().bpm);
      return;
    }
    commit(bpmInput, '修改速度', (current) => edit.updateSongMeta(current, { bpm: value }), String(ctx.store.getSong().bpm));
  });

  /* 拍号：走 setTimeSignature，改完要重新校验时值（§3.5） */
  const timeSignatureSelect = select({
    value: metaIsSet(song,'timeSignature') ? song.timeSignature : '',
    options: [{value:'',label:'未设置'},...TIME_SIGNATURE_IDS.map((value) => ({ value, label: value }))],
    ariaLabel: '拍号',
    onChange: (value) => {
      if(!value){unsetField('timeSignature');return;}
      const result = ctx.store.run('修改拍号', (current) => edit.setTimeSignature(current, value));
      if (!result.ok) {
        ctx.report(result);
        timeSignatureSelect.value = ctx.store.getSong().timeSignature;
        return;
      }
      const issues = collectDurationIssues(ctx.store.getSong());
      if (issues.length > 0) {
        toast(`拍号已改为 ${value}，但有 ${issues.length} 个小节的时值不再合法。时值不会自动重算，谱面上已标出需要处理的小节。`, {
          type: 'warn',
          duration: 9000,
        });
      }
    },
  });

  /* 风格 / 效果器预设 */
  const styleInput = input({
    value: song.style,
    maxLength: LIMITS.styleMaxLength,
    focusKey: 'meta-style',
    ariaLabel: '风格或效果器预设',
  });
  styleInput.addEventListener('change', () => {
    commit(styleInput, '修改风格', (current) => edit.updateSongMeta(current, { style: styleInput.value }), ctx.store.getSong().style);
  });

  /* 排版：每行小节数 / 显示行 / 字号 */

  /* 显示行（SPEC §8.1.1）：一个和弦块可以同时显示最多三行。
     顺序固定为 和弦名 → 数字级数 → 罗马级数，用户只能选「显示哪几行」——
     固定顺序让「哪一行是什么」始终可预期，也不至于让组合数无意义地膨胀。 */
  const LINE_CHOICES = [
    { id: 'chord', label: '和弦名', sample: 'C · Am7 · G/B' },
    { id: 'degree', label: '数字级数', sample: '1 · 6m7 · 57' },
    { id: 'roman', label: '罗马数字', sample: 'I · vi7 · V7' },
  ];
  const currentLines = song.layout.displayLines ?? ['chord'];

  const lineControls = LINE_CHOICES.map((entry) => {
    const usable = entry.id === 'chord' || degreeSupport.ok;
    const box = input({
      type: 'checkbox',
      ariaLabel: `显示${entry.label}`,
      disabled: !usable,
      focusKey: `layout-line-${entry.id}`,
    });
    box.checked = currentLines.includes(entry.id);

    box.addEventListener('change', () => {
      const next = new Set(currentLines);
      if (box.checked) next.add(entry.id);
      else next.delete(entry.id);

      // 一行都不显示等于谱面上看不到任何和弦 —— 把这一下弹回去并说明原因，
      // 而不是默默写进一个用户没打算要的状态。
      if (next.size === 0) {
        box.checked = true;
        ctx.report({ ok: false, message: '至少要保留一行，否则谱面上看不到任何和弦。' });
        return;
      }
      commit(box, '修改显示行', (current) =>
        edit.updateSongMeta(current, { layout: { displayLines: [...next] } }),
      );
    });

    return el('label', { class: 'check-line' }, [
      box,
      el('span', { class: 'check-line__text' }, [
        el('span', { class: 'check-line__name', text: entry.label }),
        el('span', { class: 'check-line__sample', text: entry.sample }),
      ]),
    ]);
  });
  const barsPerRowSelect = select({
    value: String(song.layout.barsPerRow),
    options: [2, 4, 8].map((value) => ({ value: String(value), label: `每行 ${value} 小节` })),
    ariaLabel: '每行小节数',
    onChange: (value) => {
      commit(
        barsPerRowSelect,
        '修改排版',
        (current) => edit.updateSongMeta(current, { layout: { barsPerRow: Number(value) } }),
      );
    },
  });

  // 减三和弦后缀（SPEC §6.7.1）——只在级数行真的显示时才有意义。
  // 只勾「和弦名」时改它看不出任何效果，与其让用户改完困惑，
  // 不如置灰并说清什么时候生效（「不静默」的一贯做法）。
  const degreeLinesOn = currentLines.some((line) => DEGREE_LINE_IDS.includes(line));
  const dimUsable = degreeLinesOn && degreeSupport.ok;

  // 示例里**故意不写和弦名**：这个开关只作用于级数记法，和弦名永远写 `Bdim`。
  // 在示例里放一个 `B°` 会让人以为它也能改和弦名 —— 那是另一件事（§8.2 决策点 A）。
  const dimSuffixSelect = select({
    value: song.layout.dimSuffix ?? DEFAULT_DIM_SUFFIX,
    disabled: !dimUsable,
    ariaLabel: '减三和弦后缀的写法',
    options: [
      { value: 'dim', label: 'dim —— 7dim · viidim' },
      { value: '°', label: '° —— 7° · vii°' },
    ],
    onChange: (value) => {
      commit(dimSuffixSelect, '修改减三和弦后缀', (current) =>
        edit.updateSongMeta(current, { layout: { dimSuffix: value } }),
      );
    },
  });

  /* 下面四项是 2026-09-22 那一轮放开的记谱风格（SPEC §5.1.1 / §5.1.2 / §6.6 / §8.1.2）。
     它们和 dimSuffix 一样都是 layout 里的**可缺省**字段，缺省值等于各自引入之前的观感 ——
     所以老谱子打开后长相一个像素都不会变，不存在「升级之后我的谱子自己变了」。

     选项文案里**刻意不写 ⁷ / ₇ 这类上下标字符**：它们的 Unicode 覆盖面远不如
     Δ / ° / ♯，在中文优先的字体栈里有可能画成豆腐块，而选项文案画不出来时
     用户根本猜不到那一档是什么。宁可多写几个字说清楚。 */

  // 和弦性质符号体系（§5.1.1）——作用在**和弦名**上。
  // 和上面那个 dimSuffix 是两件事：那个管级数行的后缀，这个管和弦名的性质符号。
  const chordSymbolsSelect = select({
    value: song.layout.chordSymbols ?? DEFAULT_CHORD_SYMBOLS,
    ariaLabel: '和弦性质符号体系',
    options: [
      { value: 'common', label: '通用 —— Cmaj7 · Cm7 · Cm · Cdim · Caug' },
      { value: 'jazz', label: '爵士 —— CΔ7 · C-7 · C- · C° · C+' },
    ],
    onChange: (value) => {
      commit(chordSymbolsSelect, '修改和弦性质符号体系', (current) =>
        edit.updateSongMeta(current, { layout: { chordSymbols: value } }),
      );
    },
  });

  // 升降号字形（§5.1.2）——只作用于和弦名与音名。
  // 级数行里的 #4 / b7 是「级数限定符」，属于级数记法本身，不在这个开关的范围里。
  const accidentalSelect = select({
    value: song.layout.accidentalGlyphs ?? DEFAULT_ACCIDENTAL_GLYPHS,
    ariaLabel: '升降号字形',
    options: [
      { value: 'glyph', label: '♯ ♭ —— F♯m · B♭maj7' },
      { value: 'ascii', label: '# b —— F#m · Bbmaj7' },
    ],
    onChange: (value) => {
      commit(accidentalSelect, '修改升降号字形', (current) =>
        edit.updateSongMeta(current, { layout: { accidentalGlyphs: value } }),
      );
    },
  });

  // 属七后缀位置（§6.6）——和 dimSuffix 一样只在级数行生效，所以共用同一个置灰判据。
  const seventhSuffixSelect = select({
    value: song.layout.seventhSuffix ?? DEFAULT_SEVENTH_SUFFIX,
    disabled: !dimUsable,
    ariaLabel: '属七后缀的写法',
    options: [
      { value: 'subscript', label: '右下角小字（缺省）—— 5 旁边带一个小 7' },
      { value: 'plain', label: '直接连写 —— 57 · V7' },
      { value: 'superscript', label: '右上角小字 —— 5 上方带一个小 7' },
      { value: 'parens', label: '括号包起来 —— 5(7) · V(7)' },
    ],
    onChange: (value) => {
      commit(seventhSuffixSelect, '修改属七后缀写法', (current) =>
        edit.updateSongMeta(current, { layout: { seventhSuffix: value } }),
      );
    },
  });

  // 休止符写法（§8.1.2）。**刻意没有 `0` 这一档** ——
  // 那是空白小节的文本记号（§2.4），同一个字形不能有两个意思。
  const restTextSelect = select({
    value: song.layout.restText ?? DEFAULT_REST_TEXT,
    ariaLabel: '休止符的写法',
    options: [
      { value: 'cn', label: '休止（缺省）' },
      { value: 'dash', label: '—（长破折号）' },
      { value: 'R', label: 'R（与文本语法一致）' },
    ],
    onChange: (value) => {
      commit(restTextSelect, '修改休止符写法', (current) =>
        edit.updateSongMeta(current, { layout: { restText: value } }),
      );
    },
  });

  // 自由文字块的粒度（§8.10）——按小节写还是按和弦写。
  // 只影响「新建文字块时的默认锚点」，不动已有块。
  const textBlockModeSelect = select({
    value: song.layout.textBlockMode ?? DEFAULT_TEXT_BLOCK_MODE,
    ariaLabel: '文字块粒度',
    options: [
      { value: 'bar', label: '按小节写（缺省）—— 一个小节一个大框' },
      { value: 'chord', label: '按和弦写 —— 每个和弦下方单独一个小框' },
    ],
    onChange: (value) => {
      commit(textBlockModeSelect, '修改文字块粒度', (current) =>
        edit.updateSongMeta(current, { layout: { textBlockMode: value } }),
      );
    },
  });

  const fontScaleInput = input({
    value: String(song.layout.fontScale),
    type: 'range',
    min: LIMITS.fontScaleMin,
    max: LIMITS.fontScaleMax,
    step: 0.1,
    ariaLabel: '谱面字号',
  });  const fontScaleValue = el('span', { class: 'range__value', text: `${Math.round(song.layout.fontScale * 100)}%` });
  fontScaleInput.addEventListener('input', () => {
    fontScaleValue.textContent = `${Math.round(Number(fontScaleInput.value) * 100)}%`;
  });
  fontScaleInput.addEventListener('change', () => {
    commit(
      fontScaleInput,
      '修改谱面字号',
      (current) => edit.updateSongMeta(current, { layout: { fontScale: Number(fontScaleInput.value) } }),
      String(ctx.store.getSong().layout.fontScale),
    );
  });

  const timeSignatureHint = TIME_SIGNATURES[song.timeSignature]?.hint ?? '';
  const isCompound = song.timeSignature === '6/8';

  /* 主题与字体（SPEC §9.2）—— 全局外观偏好，**不跟歌走、不进工程文件**。
     这里用 ctx.getPrefs / ctx.setPrefs 读写，而不是像上面的字段那样走 store 的
     song 数据。改完立刻落 DOM（CSS 变量 + 字体栈），并影响 PNG / PDF 导出的颜色。 */
  const THEME_LABELS = { green: '护眼绿（默认）', mono: '黑白', pure: '纯白' };
  const prefs = ctx.getPrefs();
  const themeSelect = select({
    value: prefs.theme,
    ariaLabel: '界面配色',
    options: THEME_IDS.map((id) => ({ value: id, label: THEME_LABELS[id] ?? id })),
    onChange: (value) => {
      ctx.setPrefs({ theme: value });
      toast(`已切换配色：${THEME_LABELS[value] ?? value}。`, { type: 'success', duration: 2000 });
    },
  });
  const fontSelect = select({
    value: prefs.font,
    ariaLabel: '界面字体',
    options: FONT_IDS.map((id) => ({ value: id, label: FONT_STYLES[id].label + (id === 'sans' ? '（默认）' : '') })),
    onChange: (value) => {
      ctx.setPrefs({ font: value });
      toast(`已切换字体：${FONT_STYLES[value]?.label ?? value}。`, { type: 'success', duration: 2000 });
    },
  });

  return section('歌曲信息', [
    field({ label: '标题', control: titleInput }),
    field({ label: '艺人', control: artistInput }),
    field({ label: '备注', control: notesInput, hint: '会显示在谱头，例如「清音扫弦，Capo 2」。' }),
    el('div', { class: 'field-row' }, [
      field({ label: '调号', control: tonicSelect }),
      field({ label: '调式', control: modeSelect, hint: '本版只实现了大调。' }),
    ]),
    el('div', { class: 'field-row' }, [
      field({ label: 'BPM', control: bpmInput }),
      field({
        label: '拍号',
        control: timeSignatureSelect,
        hint: timeSignatureHint,
      }),
    ]),
    isCompound
      ? el('p', {
          class: 'notice notice--warn',
          text: `拍号是 6/8：这里的 1 拍 = 八分音符，每小节 6 拍。乐手口语里的「一大拍」通常是附点四分音符（= 3 拍），别混。`,
        })
      : null,
    field({ label: '风格 / 效果器预设', control: styleInput }),
    el('h3', { class: 'panel__subtitle', text: '谱面排版' }),
    field({
      label: '每行小节数',
      control: barsPerRowSelect,
      hint: '手机竖屏建议 2；4 适合平板与桌面；8 更适合打印。小节越少，每个和弦可点的区域越大。',
    }),
    field({
      label: '显示行',
      control: el('div', { class: 'check-group' }, lineControls),
      hint: degreeSupport.ok
        ? '可以同时显示多行，最多三行。只影响显示，不改数据 —— 导出的 JSON 里永远只有和弦。'
        : `数字级数 / 罗马数字需要调号是大调：${degreeSupport.message}`,
    }),
    field({
      label: '减三和弦后缀',
      control: dimSuffixSelect,
      hint: !degreeSupport.ok
        ? `需要调号是大调：${degreeSupport.message}`
        : !degreeLinesOn
          ? '勾上「数字级数」或「罗马数字」后生效 —— 只显示和弦名时，它没有能作用的地方。'
          : '只改级数行里减三和弦的后缀（数字行与罗马行同时变）。和弦名不受它影响 —— 那一项由下面的「和弦性质符号」单独管。',
    }),
    el('h3', { class: 'panel__subtitle', text: '记谱风格' }),
    field({
      label: '和弦性质符号',
      control: chordSymbolsSelect,
      hint: '管的是和弦名里的性质后缀。只影响显示和导出的文本，不改数据 —— 存的永远是「大三 / 小七」这些性质本身。',
    }),
    field({
      label: '升降号字形',
      control: accidentalSelect,
      hint: '只作用于和弦名和调号。级数行里的 #4 / b7 不跟着变 —— 那是级数的限定符，不是音名升降号。',
    }),
    field({
      label: '属七后缀位置',
      control: seventhSuffixSelect,
      hint: !degreeSupport.ok
        ? `需要调号是大调：${degreeSupport.message}`
        : !degreeLinesOn
          ? '勾上「数字级数」或「罗马数字」后生效 —— 它只作用于级数行。'
          : '属七在级数行里写作 57，两个数字挨在一起容易被读成「五十七」，所以默认把后缀画成右下角小字。四档都只改画法，不改调式判断。',
    }),
    field({
      label: '休止符',
      control: restTextSelect,
      hint: '休止在谱面上写什么字。没有「0」这一档是刻意的 —— 0 在本工具的文本里表示空白小节，两者不是一回事。',
    }),
    field({ label: '谱面字号', control: el('div', { class: 'range' }, [fontScaleInput, fontScaleValue]) }),
    field({
      label: '文字块粒度',
      control: textBlockModeSelect,
      hint: '决定「新增文字块」时默认怎么对齐：按小节写是整段一个大框，按和弦写是每个和弦下方单独一个框。切换不会动已经放好的文字块。',
    }),
    el('h3', { class: 'panel__subtitle', text: '外观' }),
    field({
      label: '界面配色',
      control: themeSelect,
      hint: '整个应用的观感，也会决定导出图片 / PDF 的颜色。存在这台设备上，不跟歌走、不会写进工程文件。',
    }),
    field({
      label: '界面字体',
      control: fontSelect,
      hint: '谱面与界面的字体，走系统字体，导出不会缺字。同样只跟设备走。',
    }),
  ]);
}

/* ------------------------------------------------------------------ *
 * 时值问题
 * ------------------------------------------------------------------ */

/**
 * 时值问题横幅。只有真的存在问题时才出现——常驻的「一切正常」提示是噪音。
 *
 * @param {{store: Object, selectBar: Function}} ctx
 * @returns {?HTMLElement}
 */
export function renderIssuesBanner(ctx) {
  const song = ctx.store.getSong();
  const issues = collectDurationIssues(song);
  if (issues.length === 0) return null;

  const items = issues.slice(0, 12).map((issue) => {
    const sectionId = song.sections[issue.sectionIndex]?.id ?? null;
    const where = [issue.sectionName ? `[${issue.sectionName}]` : null, `第 ${issue.barIndex + 1} 小节`]
      .filter(Boolean)
      .join(' · ');
    return button(
      `${where}：${issue.message}`,
      {
        class: 'issue',
        variant: 'quiet',
        disabled: !sectionId,
        onClick: () => ctx.selectBar(sectionId, issue.barIndex),
      },
    );
  });

  return el('div', { class: 'banner banner--warn', role: 'status' }, [
    el('p', { class: 'banner__title', text: `有 ${issues.length} 个小节的时值不合法，导出前需要先处理` }),
    el('p', {
      class: 'banner__text',
      text: '改拍号不会自动重算时值——那样等于替你把音乐改了。点下面的条目可以直接跳到那个小节。',
    }),
    el('div', { class: 'banner__list' }, items),
    issues.length > items.length
      ? el('p', { class: 'banner__text', text: `…另有 ${issues.length - items.length} 处。` })
      : null,
  ]);
}

/* ------------------------------------------------------------------ *
 * 曲库
 * ------------------------------------------------------------------ */

/**
 * 曲库列表：切换、新建、复制、删除，以及**真实的**保存状态。
 *
 * @param {{store: Object, report: Function, exportCurrent: Function}} ctx
 * @returns {HTMLElement}
 */
export function renderLibraryPanel(ctx) {
  const library = ctx.store.getLibrary();
  const activeId = library.activeSongId;
  const saveStatus = ctx.store.getSaveStatus();
  const saveError = ctx.store.getSaveError();

  const statusText = {
    saved: '已保存到本机浏览器',
    pending: '保存中…',
    error: '保存失败',
    unsupported: '当前环境无法保存到本机',
    blocked: '已暂停保存（本地数据损坏）',
  }[saveStatus];

  const statusClass = {
    saved: 'is-ok',
    pending: 'is-pending',
    error: 'is-error',
    unsupported: 'is-error',
    blocked: 'is-error',
  }[saveStatus];

  const items = library.songs.map((song) => {
    const isActive = song.id === activeId;
    const barCount = song.sections.reduce((sum, s) => sum + s.bars.length, 0);

    const switchButton = button('', {
      class: `song-item${isActive ? ' is-active' : ''}`,
      variant: 'quiet',
      ariaLabel: `打开歌曲 ${song.title}`,
      onClick: () => ctx.switchSong(song.id),
    });
    switchButton.append(
      el('span', { class: 'song-item__title', text: truncate(song.title, 40) }),
      el('span', { class: 'song-item__meta' }, [
        song.artist ? el('span', { text: truncate(song.artist, 20) }) : null,
        el('span', { text: `${song.sections.length} 段 / ${barCount} 小节` }),
        el('span', { text: formatRelativeTime(song.updatedAt) }),
      ]),
      isActive ? el('span', { class: 'song-item__flag', text: '当前' }) : null,
    );

    return el('li', { class: 'song-list__item' }, [
      switchButton,
      button('删除', {
        class: 'btn--small btn--danger-quiet',
        ariaLabel: `删除歌曲 ${song.title}`,
        disabled: library.songs.length <= 1,
        title: library.songs.length <= 1 ? '曲库里至少要保留一首歌' : null,
        onClick: async () => {
          const confirmed = await confirmDialog({
            title: '删除歌曲',
            message: `确定从本机曲库删除「${song.title}」吗？`,
            detail: '删除后无法用「撤销」恢复。如果还想留着，请先导出工程文件。',
            confirmText: '删除',
            danger: true,
          });
          if (!confirmed) return;
          const result = ctx.store.deleteSong(song.id);
          if (!result.ok) {
            toast(result.message, { type: 'error' });
            return;
          }
          toast(`已删除「${song.title}」`, { type: 'success' });
        },
      }),
    ]);
  });

  return section('曲库', [
    el('p', { class: `save-status ${statusClass}` }, [
      el('span', { class: 'save-status__dot' }),
      el('span', { text: statusText }),
      saveStatus === 'error'
        ? button('重试保存', { class: 'btn--small', onClick: () => ctx.store.flushSave() })
        : null,
    ]),
    saveError ? el('pre', { class: 'code', text: saveError.message }) : null,
    el('div', { class: 'action-grid' }, [
      button('新建空白歌曲', { variant: 'primary', onClick: () => ctx.newSong() }),
      button('复制当前歌曲', { onClick: () => ctx.copyCurrent() }),
    ]),
    el('ul', { class: 'song-list' }, items),
    el('p', {
      class: 'notice',
      text: '数据存在这台设备的浏览器里，换设备或清理浏览器数据就没了。它不是永久备份——重要的谱子请用下面的「导出工程」存一份文件。',
    }),
  ], { collapsed: true });
}

/* ------------------------------------------------------------------ *
 * 文本输入
 * ------------------------------------------------------------------ */

/**
 * 文本输入面板：批量写谱、错误定位、原始草稿保留。
 *
 * 这里的内容**不会跟着谱面自动更新**——它是「批量改」的入口，不是实时镜像。
 * 这样设计是为了避免「用户正在打字，谱面一改动就把他的文字冲掉」。
 *
 * @param {{store: Object, report: Function}} ctx
 * @returns {HTMLElement}
 */
export function renderTextPanel(ctx) {
  const song = ctx.store.getSong();
  const generated = songToText(song);
  const initialText = ctx.store.getTextDraft() ?? (generated.ok ? generated.value : '');

  const textarea = el('textarea', {
    class: 'input input--code',
    rows: '14',
    spellcheck: 'false',
    autocapitalize: 'off',
    autocomplete: 'off',
    'aria-label': '功能谱文本',
    dataset: { focusKey: 'text-input' },
  });
  textarea.value = initialText;
  textarea.addEventListener('input', () => ctx.store.setTextDraft(textarea.value));

  const issueList = el('div', { class: 'issue-list' });
  const summary = el('p', { class: 'notice' });

  function clearIssues() {
    issueList.replaceChildren();
    summary.textContent = '';
    summary.className = 'notice';
  }

  function showIssues(issues) {
    issueList.replaceChildren(
      ...issues.slice(0, 20).map((issue, index) =>
        button(formatParseIssue(issue), {
          class: 'issue',
          variant: 'quiet',
          // 点一下就跳到出错的那一行、选中那一列——错误提示必须能落到具体位置。
          onClick: () => {
            const lines = textarea.value.split('\n');
            const lineIndex = Math.max(0, Math.min((issue.line ?? 1) - 1, lines.length - 1));
            let offset = 0;
            for (let i = 0; i < lineIndex; i += 1) offset += lines[i].length + 1;
            const column = Math.max(0, (issue.column ?? 1) - 1);
            const start = offset + column;
            const end = offset + lines[lineIndex].length;
            textarea.focus();
            textarea.setSelectionRange(start, Math.max(start, end));
            const lineHeight = 22;
            textarea.scrollTop = Math.max(0, lineIndex * lineHeight - textarea.clientHeight / 3);
          },
        }),
      ),
    );
    if (issues.length > 20) {
      issueList.append(el('p', { class: 'notice', text: `…另有 ${issues.length - 20} 条错误。建议先修完上面这些再看。` }));
    }
    summary.textContent = `${issues.length} 条错误。上面的每一条都可以点，点一下会跳到对应的位置。你的原文没有被改动，也没有写进歌曲。`;
    summary.className = 'notice notice--warn';
    // 这一条是 §4.6 的落地点：解析失败时草稿必须留着。
    ctx.store.setTextDraft(textarea.value);
  }

  const applyButton = button('解析并应用', {
    variant: 'primary',
    onClick: async () => {
      const current = ctx.store.getSong();
      const result = parseSongTextInto(textarea.value, current);
      if (!result.ok) {
        showIssues(result.issues);
        toast('文本里有问题，没有应用到歌曲上。原歌曲完全没变。', { type: 'error' });
        return;
      }

      // 应用前先让用户知道影响面：段落数和小节数会变成多少。
      const nextSections = result.value.sections.length;
      const nextBars = result.value.sections.reduce((sum, s) => sum + s.bars.length, 0);
      const currentBars = current.sections.reduce((sum, s) => sum + s.bars.length, 0);
      // 歌词不进文本语法（SPEC §8.9）：这一步会重写全部段落和小节，歌词会被清空。
      // 必须在这里说清，不能让「录好的词没了」变成一次惊吓。
      const hasLyrics = current.sections.some((section) =>
        section.bars.some((bar) => Array.isArray(bar.lyrics) && bar.lyrics.some((f) => f && f.text.trim() !== '')),
      );
      const confirmed = await confirmDialog({
        title: '用文本替换全部段落',
        message: `歌曲会变成 ${nextSections} 个段落、${nextBars} 个小节（现在是 ${current.sections.length} 段、${currentBars} 小节）。`,
        detail: [
          '段落的重复次数和演奏提示会按同名段落继承；小节与事件的 ID 会全部重新生成。这一步可以用「撤销」恢复。',
          hasLyrics ? '⚠ 这首歌里有歌词，而歌词不在文本语法里——这一步会把已有的歌词全部清空。歌词只在谱面上点按编辑。' : null,
        ]
          .filter(Boolean)
          .join('\n'),
        confirmText: '替换',
      });
      if (!confirmed) return;

      const applied = ctx.store.run('按文本重写段落', (base) => ({
        ok: true,
        value: parseSongTextInto(textarea.value, base).value ?? base,
      }));
      if (!applied.ok) {
        ctx.report(applied);
        return;
      }
      clearIssues();
      toast(`已应用：${nextSections} 段 / ${nextBars} 小节。`, { type: 'success' });
    },
  });

  const regenerateButton = button('从当前歌曲重新生成', {
    onClick: async () => {
      const current = ctx.store.getSong();
      const text = songToText(current);
      if (!text.ok) {
        toast('当前歌曲里有小节写不成文本，先处理它们再重新生成。', {
          type: 'error',
          detail: formatDurationIssues(text.issues),
        });
        return;
      }
      if (textarea.value !== text.value) {
        const confirmed = await confirmDialog({
          title: '用歌曲内容覆盖文本框',
          message: '文本框里现在的内容会被当前歌曲的谱面覆盖。',
          detail: '这一步只动文本框，不会改动歌曲。',
          confirmText: '覆盖文本框',
        });
        if (!confirmed) return;
      }
      textarea.value = text.value;
      ctx.store.setTextDraft(text.value);
      clearIssues();
      toast('文本框已按当前歌曲重新生成。', { type: 'success' });
    },
  });

  return section('文本输入', [
    el('p', {
      class: 'notice',
      text: '文本框是「批量改」的入口，不会跟着谱面自动更新；点「从当前歌曲重新生成」才会同步。解析失败时歌曲一个字节都不会变。',
    }),
    details('语法速查', el('pre', {
      class: 'code code--syntax',
      text: [
        '[Verse]            段落名独占一行',
        'C:4 | Am:4         竖线分小节；换行也等于一个小节',
        'C                  省略时值 → 这一小节内平均分配',
        'G/B                斜杠低音',
        '0                  整小节留白（空白小节）',
        'R:2                休止 2 拍',
        '',
        `本次解析按 ${song.timeSignature} 计算每小节拍数：${TIME_SIGNATURES[song.timeSignature]?.hint ?? ''}`,
        '同一小节里不能既有写明的时值又有省略的时值（会直接报错，不猜）。',
      ].join('\n'),
    })),
    textarea,
    issueList,
    summary,
    el('div', { class: 'action-grid' }, [applyButton, regenerateButton]),
  ], { collapsed: true });
}

/* ------------------------------------------------------------------ *
 * 工程文件
 * ------------------------------------------------------------------ */

/**
 * 工程文件面板：导出、导入、打印、PNG。
 *
 * @param {{store: Object, report: Function, print: Function, exportPng: Function}} ctx
 * @returns {HTMLElement}
 */
export function renderProjectPanel(ctx) {
  const song = ctx.store.getSong();

  const exportProjectButton = button('导出工程（.json）', {
    onClick: () => {
      const issues = collectDurationIssues(song);
      if (issues.length > 0) {
        // 导出的是工程文件，允许时值有问题（还要接着编辑）；但要说清楚。
        toast(`注意：这首歌有 ${issues.length} 个小节的时值还不合法，工程文件会照原样导出。`, {
          type: 'warn',
          detail: formatDurationIssues(issues),
          duration: 8000,
        });
      }
      downloadText(suggestProjectFileName(song), serializeProject(song));
      toast('工程文件已开始下载。', { type: 'success' });
    },
  });

  const importProjectButton = button('导入工程…', {
    onClick: async () => {
      // 导入前先把没应用的文本草稿处理掉，否则用户敲的东西会无声消失（§7.3）。
      if (ctx.store.hasPendingTextDraft()) {
        const confirmed = await confirmDialog({
          title: '文本框里还有没应用的改动',
          message: '导入工程会切换当前歌曲，文本框里的内容会跟着清空。',
          detail: '想保留的话，请先回「文本输入」点一次「解析并应用」。',
          confirmText: '仍然导入',
          danger: true,
        });
        if (!confirmed) return;
      }

      const files = await pickFiles({ accept: '.json,application/json' });
      if (files.length === 0) return;

      const file = files[0];
      let text;
      try {
        text = await file.text();
      } catch (error) {
        toast(`读不到这个文件：${error?.message ?? error}`, { type: 'error' });
        return;
      }

      const result = parseProject(text, {
        existingSongIds: ctx.store.getLibrary().songs.map((item) => item.id),
      });
      if (!result.ok) {
        toast(`导入失败：${result.message}`, {
          type: 'error',
          detail: result.errors.length ? result.errors.map((e) => (e.path ? `${e.path}：${e.message}` : e.message)).join('\n') : null,
          duration: 0,
        });
        return;
      }

      const imported = result.value;
      const barCount = imported.sections.reduce((sum, s) => sum + s.bars.length, 0);
      const confirmed = await confirmDialog({
        title: '导入这首歌',
        message: `「${imported.title}」 · ${imported.sections.length} 段 / ${barCount} 小节`,
        detail: [
          song.title ? `当前打开的是「${song.title}」，它不会被覆盖，两首歌都会留在曲库里。` : null,
          result.meta.exportedAt ? `文件导出于 ${formatRelativeTime(result.meta.exportedAt)}。` : null,
          result.warnings.length ? result.warnings.join('\n') : null,
        ]
          .filter(Boolean)
          .join('\n'),
        confirmText: '导入并打开',
      });
      if (!confirmed) return;

      ctx.store.importSong(imported);
      toast(
        result.meta.idRegenerated
          ? '导入完成。文件里的歌曲 ID 与曲库中已有歌曲重复，已为它生成新 ID。'
          : '导入完成。',
        { type: 'success' },
      );
    },
  });

  const exportPrintButton = button('导出与打印…', {
    variant: 'primary',
    // 统一出口（SPEC §8.4）：一个面板里选 PDF / PNG / 打印，能选页的都能勾选页。
    onClick: () => ctx.exportPng(),
  });

  return section('数据', [
    el('p', { class: 'notice', text: '工程文件是这台设备之外的备份，可以在换设备或清浏览器数据之后导入回来。' }),
    el('h3', { class: 'panel__subtitle', text: '工程文件' }),
    el('div', { class: 'action-grid' }, [exportProjectButton, importProjectButton]),
    el('h3', { class: 'panel__subtitle', text: '成品' }),
    el('div', { class: 'action-grid' }, [exportPrintButton]),
    el('details', { class: 'details' }, [
      el('summary', { class: 'details__summary', text: '查看当前歌曲的 JSON' }),
      el('pre', { class: 'code', text: JSON.stringify(song, null, 2) }),
    ]),
  ], { collapsed: true });
}

/* ------------------------------------------------------------------ *
 * 存储损坏
 * ------------------------------------------------------------------ */

/**
 * 本地数据损坏时的横幅。
 *
 * 这里**必须**把「不会自动覆盖」说出来，并且给两个真实可用的出口：
 * 导出原始数据、或者明确确认后清空。最不该做的就是自动清理——
 * 用户可能正靠那段原文救回几个月的谱子。
 *
 * @param {{store: Object, report: Function}} ctx
 * @returns {?HTMLElement}
 */
export function renderStorageBanner(ctx) {
  const problem = ctx.store.getStorageProblem();
  if (!problem) return null;

  const exportRaw = button('导出原始数据备份', {
    onClick: () => {
      const raw = ctx.store.readRawStorage();
      if (!raw.ok) {
        toast(raw.message, { type: 'error' });
        return;
      }
      if (raw.raw === null) {
        toast('本地存储里现在是空的，没有可导出的内容。', { type: 'warn' });
        return;
      }
      downloadText(`localStorage-备份-${new Date().toISOString().slice(0, 10)}.txt`, raw.raw, 'text/plain');
      toast('原始数据已开始下载（是本地存储里的原样文本，没有做过任何处理）。', { type: 'success' });
    },
  });

  const clearButton = button('清空本地数据并重新开始', {
    variant: 'danger',
    onClick: async () => {
      const confirmed = await confirmByTyping({
        title: '清空本地数据',
        message: '这会删掉本机浏览器里那份读不动的数据，然后用示例歌曲重新开始。',
        detail: '这一步不可撤销。如果还可能想救回里面的内容，请先点「导出原始数据备份」。',
        keyword: '清空',
        confirmText: '清空并重新开始',
      });
      if (!confirmed) return;
      const result = ctx.store.clearStorageAndRestart();
      if (!result.ok) {
        toast(result.message, { type: 'error' });
        return;
      }
      toast('本地数据已清空，可以用新的曲库继续了。', { type: 'success' });
    },
  });

  return el('div', { class: 'banner banner--danger', role: 'alert' }, [
    el('p', { class: 'banner__title', text: '本地曲库读不出来，已暂停保存' }),
    el('p', { class: 'banner__text', text: problem.message }),
    el('p', {
      class: 'banner__text',
      text: '在你处理之前，这个页面不会再往本地存储写任何东西，原始内容还在原处。现在页面上显示的是一首示例歌曲，你可以先导出它，或者导出那份原始数据看看还能不能救回来。',
    }),
    details(
      `错误码 ${problem.code}`,
      el('pre', { class: 'code', text: problem.raw ? truncate(problem.raw, 4000) : '(本地存储里没有内容)' }),
    ),
    el('div', { class: 'action-grid' }, [exportRaw, clearButton]),
  ]);
}

/**
 * 曲库整体「需要修复」时的提醒（有歌曲被隔离，但其它歌能正常打开）。
 *
 * @param {{store: Object}} ctx
 * @returns {?HTMLElement}
 */
export function renderRepairBanner(ctx) {
  const warning = ctx.store.getRepairWarning();
  if (!warning) return null;

  return el('div', { class: 'banner banner--warn' }, [
    el('p', { class: 'banner__title', text: '曲库里有歌曲数据不合法，已暂时隔离' }),
    el('pre', { class: 'code', text: warning }),
    el('p', {
      class: 'banner__text',
      text: '被隔离的歌曲没有被删除，原始内容仍在本地存储里。这里的自动保存会覆盖整个曲库键，所以在处理之前请不要依赖它保留那份坏数据——需要的话先导出一份工程文件。',
    }),
  ]);
}

/**
 * 顶部状态条里的保存状态。
 *
 * @param {{store: Object}} ctx
 * @returns {HTMLElement}
 */
export function renderSaveStatus(ctx) {
  const status = ctx.store.getSaveStatus();
  const map = {
    saved: { text: '已保存', className: 'is-ok' },
    pending: { text: '保存中…', className: 'is-pending' },
    error: { text: '保存失败', className: 'is-error' },
    unsupported: { text: '无法保存到本机', className: 'is-error' },
    blocked: { text: '保存已暂停', className: 'is-error' },
  };
  const entry = map[status] ?? map.saved;
  return el('span', { class: `status-chip ${entry.className}`, title: '本地保存状态' }, [
    el('span', { class: 'status-chip__dot' }),
    el('span', { text: entry.text }),
  ]);
}

/** 供 app 层复用：把当前歌曲的文本重新生成一遍。 */
export function currentSongText(song) {
  return songToText(song);
}

/** 供 app 层复用：把工程对象序列化（导出前可能还要用）。 */
export function currentProject(song) {
  return JSON.stringify(buildProject(song), null, 2);
}
