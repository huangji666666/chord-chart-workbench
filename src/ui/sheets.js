/**
 * 点按之后弹出的编辑面板（段落 / 小节 / 事件）。
 *
 * ## 为什么是「面板」而不是「表单堆在页面上」
 *
 * 手机上 390px 宽、每行 2 个小节时，一个小节格只有一百多像素。把「改根音、
 * 改性质、改时值、删事件」的控件全塞进格子里，必然要么塞不下、要么把格子的
 * 宽度撑开（直接违反 §9 不出现横向滚动）。所以编辑走**点按 → 底部面板**这条路，
 * 视口之间只有一套编辑路径，不会出现「桌面能改、手机上改不了」。
 *
 * ## 两个刻意的设计
 *
 * 1. **事件面板是「草稿式」的**：改根音、改性质、改时值都只动面板里的草稿，
 *    点「完成」才提交一次。这样一次编辑 = 一步撤销（§7.2 的粒度要求），
 *    也避免每点一个按钮就往历史栈里塞一条。
 * 2. **小节面板是「一次性」的**：每个按钮点下去就执行并关面板，
 *    因为它列的都是「插入 / 复制 / 删除」这类没有中间状态的动作。
 *
 * ## 唯一的例外要显式确认
 *
 * `setBarEmpty` 会清空小节里的事件，所以对一个有内容的小节，这里**先弹确认**
 * 再带 `discardEvents: true` 调用。逻辑层的这道保护如果没有界面配合，
 * 等于形同虚设。
 *
 * @module ui/sheets
 */

import { CHORD_QUALITIES, LIMITS, TIME_SIGNATURES, getBeatsPerBar } from '../core/constants.js';
import { createChord, formatChordSymbol, parsePitchName } from '../core/chord.js';
import { canShowDegrees, chordToDegree } from '../core/degrees.js';
import { beatsEqual, checkBeatsValue, sumEventBeats } from '../core/duration.js';
import * as edit from '../core/edit.js';
import { askText, confirmDialog, openSheet, toast } from './dialogs.js';
import { button, el, formatBeatsLabel } from './dom.js';

const PITCH_LETTERS = ['C', 'D', 'E', 'F', 'G', 'A', 'B'];

/** 升降号选项。内部存 ASCII，显示用 ♯ / ♭。 */
const ACCIDENTAL_OPTIONS = [
  { value: -2, label: '♭♭', title: '两个降号' },
  { value: -1, label: '♭', title: '一个降号' },
  { value: 0, label: '♮', title: '本位（无升降号）' },
  { value: 1, label: '♯', title: '一个升号' },
  { value: 2, label: '♯♯', title: '两个升号' },
];

/** 斜杠低音的可选音名。常用拼写都列出来，免得手机上要手打。 */
const BASS_OPTIONS = [
  { value: '', label: '无（不用斜杠低音）' },
  ...['C', 'C#', 'Db', 'D', 'D#', 'Eb', 'E', 'F', 'F#', 'Gb', 'G', 'G#', 'Ab', 'A', 'A#', 'Bb', 'B'].map(
    (value) => ({ value, label: value.replace(/#/g, '♯').replace(/b/g, '♭') }),
  ),
];

/* ------------------------------------------------------------------ *
 * 小工具
 * ------------------------------------------------------------------ */

/** 把 `{letter, accidental}` 拼成数据里的根音写法（ASCII 升降号）。 */
function pitchToText(pitch) {
  const symbol = pitch.accidental > 0 ? '#' : 'b';
  return pitch.letter + symbol.repeat(Math.abs(pitch.accidental));
}

/** 把数据里的根音写法拆成 `{letter, accidental}`；非法时回退到 C 本位。 */
function textToPitch(text, fallback = { letter: 'C', accidental: 0 }) {
  const parsed = parsePitchName(String(text ?? ''));
  return parsed.ok ? parsed.value : fallback;
}

/** 渲染时把 ASCII 升降号换成显示字形。 */
function glyph(text) {
  return String(text ?? '').replace(/#/g, '♯').replace(/b/g, '♭');
}

/** 一段标题 + 内容的小分组。 */
function group(label, children, hint) {
  return el('div', { class: 'group' }, [
    el('span', { class: 'group__label', text: label }),
    el('div', { class: 'group__body' }, children),
    hint ? el('p', { class: 'group__hint', text: hint }) : null,
  ]);
}

/** 一组互斥的按钮（单选）。`isActive(value)` 决定哪个高亮。 */
function toggleRow(items, isActive, onPick, { className = '' } = {}) {
  return el(
    'div',
    { class: `toggles ${className}`.trim() },
    items.map((item) =>
      button(item.label, {
        class: `toggle${isActive(item.value) ? ' is-active' : ''}`,
        title: item.title ?? null,
        ariaLabel: item.title ?? item.label,
        onClick: () => onPick(item.value),
      }),
    ),
  );
}

/**
 * 统一的「执行一次编辑」入口：成功不吭声（界面自己会重画），失败弹提示。
 *
 * @returns {boolean} 是否成功
 */
function apply(ctx, label, mutator) {
  const result = ctx.store.run(label, mutator);
  if (!result.ok) {
    toast(result.message, { type: 'error', detail: result.code });
    return false;
  }
  return true;
}

/* ------------------------------------------------------------------ *
 * 事件面板
 * ------------------------------------------------------------------ */

/**
 * 打开事件编辑面板。
 *
 * @param {{store: Object}} ctx
 * @param {{sectionId: string, barIndex: number, eventIndex: ?number}} target
 *   `eventIndex` 为 null 表示新增。
 * @param {{kind?: 'chord'|'rest'}} [preset] 新增时的初始类型。
 */
export function openEventSheet(ctx, target, preset = {}) {
  const song = ctx.store.getSong();
  const section = song.sections.find((item) => item.id === target.sectionId);
  if (!section) {
    toast('找不到这个段落，它可能刚被删除了。', { type: 'error' });
    return;
  }
  const bar = section.bars[target.barIndex];
  if (!bar) {
    toast('找不到这个小节，它可能刚被删除了。', { type: 'error' });
    return;
  }

  const isNew = target.eventIndex === null || target.eventIndex === undefined;
  const existing =
    !isNew && bar.type === 'chords' ? bar.events[target.eventIndex] : undefined;
  const beatsPerBar = getBeatsPerBar(song.timeSignature);
  const degreeSupport = canShowDegrees(song.key);

  /** 面板内的草稿。所有改动先落在这里，点「完成」才提交。 */
  const draft = {
    kind: existing?.kind ?? preset.kind ?? 'chord',
    pitch: textToPitch(existing?.chord?.root ?? 'C'),
    quality: existing?.chord?.quality ?? 'maj',
    bass: existing?.chord?.bass ?? '',
    beats: existing?.beats ?? (beatsPerBar >= 4 ? 4 : beatsPerBar),
    // 歌词对齐到事件（SPEC §8.9）：编辑这个事件下方的歌词。
    lyric: !isNew ? (bar.lyrics?.[target.eventIndex]?.text ?? '') : '',
  };

  /* —— 各块控件 —— */

  const letterButtons = [];
  const accidentalButtons = [];
  const qualityButtons = [];
  /** 和弦 / 休止 两个切换按钮，建在下面，但 sync() 里要按草稿高亮它们。 */
  let kindButtons = [];

  const lettersRow = el(
    'div',
    { class: 'toggles toggles--letters' },
    PITCH_LETTERS.map((letter, index) => {
      const node = button(letter, {
        class: 'toggle',
        onClick: () => {
          draft.pitch = { ...draft.pitch, letter };
          sync();
        },
      });
      letterButtons[index] = node;
      return node;
    }),
  );

  const accidentalsRow = el(
    'div',
    { class: 'toggles toggles--accidentals' },
    ACCIDENTAL_OPTIONS.map((option, index) => {
      const node = button(option.label, {
        class: 'toggle',
        title: option.title,
        ariaLabel: option.title,
        onClick: () => {
          draft.pitch = { ...draft.pitch, accidental: option.value };
          sync();
        },
      });
      accidentalButtons[index] = node;
      return node;
    }),
  );

  const qualityRow = el(
    'div',
    { class: 'toggles toggles--qualities' },
    CHORD_QUALITIES.map((quality, index) => {
      const node = button(quality.symbol === '' ? '（无后缀）' : quality.symbol, {
        class: 'toggle',
        title: `${quality.label}（${quality.id}）`,
        ariaLabel: quality.label,
        onClick: () => {
          draft.quality = quality.id;
          sync();
        },
      });
      qualityButtons[index] = node;
      return node;
    }),
  );

  const bassSelect = el('select', { class: 'input input--select', 'aria-label': '斜杠低音' });
  for (const option of BASS_OPTIONS) {
    bassSelect.append(el('option', { value: option.value, text: option.label }));
  }
  bassSelect.addEventListener('change', () => {
    draft.bass = bassSelect.value;
    sync();
  });

  /** 时值快捷值：不超过一小节的拍数，外加上常用的 0.5 / 1 拍。 */
  const quickBeats = [...new Set([0.5, 1, 1.5, 2, 2.5, 3, beatsPerBar])]
    .filter((value) => value > 0 && value <= Math.max(beatsPerBar, 1))
    .sort((a, b) => a - b);

  const beatsInput = el('input', {
    class: 'input input--beats',
    type: 'number',
    min: '0.0625',
    max: String(LIMITS.beatsMax),
    step: '0.0625',
    inputmode: 'decimal',
    'aria-label': '时值（拍）',
    value: String(draft.beats),
    dataset: { focusKey: 'sheet-beats' },
  });
  beatsInput.addEventListener('change', () => {
    const value = Number(beatsInput.value);
    draft.beats = Number.isFinite(value) ? value : draft.beats;
    sync();
  });

  const beatsQuickRow = toggleRow(
    quickBeats.map((value) => ({ value, label: `${value}`, title: `${formatBeatsLabel(value)}` })),
    (value) => beatsEqual(value, draft.beats),
    (value) => {
      draft.beats = value;
      beatsInput.value = String(value);
      sync();
    },
    { className: 'toggles--beats' },
  );

  // 歌词（SPEC §8.9）：这个事件下方的一段词，逐字对齐。留空表示这里没有歌词。
  const lyricInput = el('input', {
    class: 'input',
    type: 'text',
    value: draft.lyric,
    maxlength: String(LIMITS.lyricMaxLength),
    placeholder: '例如「候鸟」或「飞向南方」',
    'aria-label': '这个和弦下方的歌词',
    dataset: { focusKey: 'sheet-lyric' },
  });
  lyricInput.addEventListener('change', () => {
    draft.lyric = lyricInput.value;
    sync();
  });

  const chordBlock = el('div', { class: 'group-stack' }, [
    group('根音', [lettersRow, accidentalsRow]),
    group(
      '和弦性质',
      [qualityRow],
      qualityButtons.length
        ? '后缀区分大小写：大七写 maj7，大三和弦不写后缀。本版只支持这九种。'
        : null,
    ),
    group('斜杠低音', [bassSelect], '斜杠低音表示和弦下方的另一个音，例如 C/G（C 和弦配 G 低音）。'),
  ]);

  const restNote = el('p', {
    class: 'group__hint',
    text: '休止表示这几拍明确不发声。它与「空白小节」不是一回事：空白小节是整小节留白、不写任何内容。',
  });

  /* —— 实时预览 —— */

  const previewNode = el('p', { class: 'preview__main' });
  const previewNote = el('p', { class: 'preview__note' });
  const totalNode = el('p', { class: 'preview__total' });

  function currentChord() {
    const result = createChord({
      root: pitchToText(draft.pitch),
      quality: draft.quality,
      bass: draft.bass === '' ? null : draft.bass,
    });
    return result.ok ? result.value : null;
  }

  /** 把草稿的变化同步到界面上（只动文字与高亮，不重建控件，免得焦点被夺走）。 */
  function sync() {
    const isChord = draft.kind === 'chord';

    chordBlock.hidden = !isChord;
    restNote.hidden = isChord;

    letterButtons.forEach((node, index) => {
      node.classList.toggle('is-active', PITCH_LETTERS[index] === draft.pitch.letter);
    });
    accidentalButtons.forEach((node, index) => {
      node.classList.toggle('is-active', ACCIDENTAL_OPTIONS[index].value === draft.pitch.accidental);
    });
    qualityButtons.forEach((node, index) => {
      node.classList.toggle('is-active', CHORD_QUALITIES[index].id === draft.quality);
    });
    bassSelect.value = draft.bass;
    beatsInput.value = String(draft.beats);
    for (const node of beatsQuickRow.children) {
      const value = Number(node.dataset.value);
      node.classList.toggle('is-active', Number.isFinite(value) && beatsEqual(value, draft.beats));
    }

    const beatsText = formatBeatsLabel(draft.beats);
    const beatsCheck = checkBeatsValue(draft.beats);
    if (!beatsCheck.ok) {
      previewNode.textContent = `时值不合法：${beatsCheck.message}`;
      previewNode.classList.add('is-error');
      previewNote.textContent = '';
    } else if (!isChord) {
      previewNode.textContent = `将写入：休止 · ${beatsText}`;
      previewNode.classList.remove('is-error');
      previewNote.textContent = '只占时值，不发声。';
    } else {
      const chord = currentChord();
      if (!chord) {
        previewNode.textContent = '和弦写法不合法，请检查根音与性质。';
        previewNode.classList.add('is-error');
        previewNote.textContent = '';
      } else {
        const symbol = formatChordSymbol(chord);
        previewNode.textContent = `将写入：${symbol} · ${beatsText}`;
        previewNode.classList.remove('is-error');
        if (degreeSupport.ok) {
          const degree = chordToDegree(chord, song.key);
          previewNote.textContent = degree.ok
            ? `数字级数显示为 ${degree.value}（按 ${glyph(song.key.tonic)} 大调）`
            : `级数换算不可用：${degree.message}`;
        } else {
          previewNote.textContent = `级数换算不可用：${degreeSupport.message}`;
        }
      }
    }

    // 小节合计：把「其它事件」和草稿加在一起，让用户当场看到拍数对不对。
    // 编辑已有事件时要把它自己排除掉，否则会重复计一遍它原来的时值。
    const others = (bar.type === 'chords' ? bar.events : []).filter(
      (_, index) => isNew || index !== target.eventIndex,
    );
    const othersTotal = sumEventBeats(others.map((event) => ({ beats: event.beats })));
    const total = othersTotal + (Number.isFinite(draft.beats) ? draft.beats : 0);
    const delta = total - beatsPerBar;
    const state = beatsEqual(delta, 0) ? 'ok' : delta > 0 ? 'over' : 'under';
    totalNode.textContent =
      state === 'ok'
        ? `本小节合计 ${total} / ${beatsPerBar} 拍，正好。`
        : state === 'over'
          ? `本小节合计 ${total} / ${beatsPerBar} 拍，超出 ${Math.round((total - beatsPerBar) * 1000) / 1000} 拍。`
          : `本小节合计 ${total} / ${beatsPerBar} 拍，还差 ${Math.round((beatsPerBar - total) * 1000) / 1000} 拍。`;
    totalNode.className = `preview__total is-${state}`;
  }

  /* —— 组装 —— */

  const kindRow = el('div', { class: 'toggles toggles--kind' }, [
    button('和弦', {
      class: 'toggle',
      onClick: () => {
        draft.kind = 'chord';
        sync();
      },
    }),
    button('休止', {
      class: 'toggle',
      onClick: () => {
        draft.kind = 'rest';
        sync();
      },
    }),
  ]);
  kindButtons = [...kindRow.children];

  const beatsHint =
    song.timeSignature === '6/8'
      ? TIME_SIGNATURES['6/8'].hint
      : `单位是拍（${TIME_SIGNATURES[song.timeSignature]?.hint ?? ''}）`;

  const body = el('div', { class: 'sheet-form' }, [
    group('类型', [kindRow]),
    chordBlock,
    restNote,
    group('时值', [beatsQuickRow, beatsInput], beatsHint),
    group('歌词', [lyricInput], '这个和弦下方要显示的一小段词，逐字对齐到和弦。留空表示这里没有歌词。'),
    el('div', { class: 'preview' }, [previewNode, previewNote, totalNode]),
  ]);

  let handle;
  const actions = [
    button('取消', { onClick: () => handle.close(null) }),
    !isNew
      ? button('删除事件', {
          variant: 'danger',
          onClick: () => {
            const done = apply(ctx, '删除事件', (current) =>
              edit.removeEvent(current, target.sectionId, target.barIndex, target.eventIndex),
            );
            if (done) handle.close(null);
          },
        })
      : null,
    button('完成', {
      variant: 'primary',
      onClick: () => {
        const input = {
          kind: draft.kind,
          beats: draft.beats,
          chord:
            draft.kind === 'chord'
              ? { root: pitchToText(draft.pitch), quality: draft.quality, bass: draft.bass === '' ? null : draft.bass }
              : undefined,
        };
        // 事件和歌词合并成**一步**撤销：先写事件，再在其结果上写这个事件下方的歌词。
        // 两步拆成两次 run 会让「改和弦 + 填词」变成两次撤销，违背 §7.2 的粒度。
        const done = apply(ctx, isNew ? '添加事件' : '修改事件', (current) => {
          const afterEvent = isNew
            ? edit.addEvent(current, target.sectionId, target.barIndex, input)
            : edit.updateEvent(current, target.sectionId, target.barIndex, target.eventIndex, input);
          if (!afterEvent.ok) return afterEvent;
          const lyricText = draft.lyric ?? '';
          // 新增时事件追加到末尾，歌词也对齐到那个新下标；编辑时对当前下标。
          const lyricIndex = isNew ? afterEvent.value.sections
            .find((sec) => sec.id === target.sectionId)?.bars[target.barIndex]?.events.length - 1
            : target.eventIndex;
          if (lyricIndex === undefined) return afterEvent;
          return edit.setEventLyric(afterEvent.value, target.sectionId, target.barIndex, lyricIndex, lyricText);
        });
        if (done) handle.close(true);
      },
    }),
  ].filter(Boolean);

  handle = openSheet({
    title: isNew ? '新增事件' : '编辑事件',
    subtitle: `${section.name} · 第 ${target.barIndex + 1} 小节${isNew ? '' : ` · 第 ${target.eventIndex + 1} 个`}`,
    body,
    actions,
  });

  sync();
}

/* ------------------------------------------------------------------ *
 * 小节面板
 * ------------------------------------------------------------------ */

/**
 * 打开小节操作面板。
 *
 * @param {{store: Object}} ctx
 * @param {{sectionId: string, barIndex: number}} target
 */
export function openBarSheet(ctx, target) {
  const song = ctx.store.getSong();
  const section = song.sections.find((item) => item.id === target.sectionId);
  const bar = section?.bars[target.barIndex];
  if (!section || !bar) {
    toast('找不到这个小节，它可能刚被删除了。', { type: 'error' });
    return;
  }

  const beatsPerBar = getBeatsPerBar(song.timeSignature);
  const eventCount = bar.events.length;
  const total = sumEventBeats(bar.events.map((event) => ({ beats: event.beats })));
  const isOnlyBar = section.bars.length <= 1;

  let handle;

  /** 一次性动作：执行完就关面板。 */
  function act(label, mutator) {
    const done = apply(ctx, label, mutator);
    if (done) handle.close(true);
  }

  const statusNode = el('div', { class: 'sheet-status' }, [
    el('p', {
      class: 'sheet-status__line',
      text:
        bar.type === 'empty'
          ? '这是一个空白小节：整小节留白，没有和弦，也没有休止。'
          : `含 ${eventCount} 个事件，合计 ${Math.round(total * 1000) / 1000} 拍（每小节 ${beatsPerBar} 拍）。`,
    }),
    bar.type !== 'empty' && !beatsEqual(total, beatsPerBar)
      ? el('p', {
          class: 'sheet-status__line sheet-status__line--warn',
          text:
            total > beatsPerBar
              ? `比一小节多出 ${Math.round((total - beatsPerBar) * 1000) / 1000} 拍，导出前需要先处理。`
              : `还差 ${Math.round((beatsPerBar - total) * 1000) / 1000} 拍才满一小节，导出前需要先处理。`,
        })
      : null,
  ]);

  const addRow = el('div', { class: 'action-grid' }, [
    button('＋ 和弦', {
      variant: 'primary',
      onClick: () => {
        handle.close(null);
        openEventSheet(ctx, { ...target, eventIndex: null }, { kind: 'chord' });
      },
    }),
    button('＋ 休止', {
      onClick: () => {
        handle.close(null);
        openEventSheet(ctx, { ...target, eventIndex: null }, { kind: 'rest' });
      },
    }),
  ]);

  const moveRow = el('div', { class: 'action-grid' }, [
    button('前面插一小节', {
      onClick: () => act('插入小节', (current) => edit.insertBar(current, target.sectionId, target.barIndex)),
    }),
    button('后面插一小节', {
      onClick: () => act('插入小节', (current) => edit.insertBar(current, target.sectionId, target.barIndex + 1)),
    }),
    button('复制这一小节', {
      onClick: () => act('复制小节', (current) => edit.duplicateBar(current, target.sectionId, target.barIndex)),
    }),
    button('上移', {
      onClick: () => act('上移小节', (current) => edit.moveBar(current, target.sectionId, target.barIndex, 'up')),
    }),
    button('下移', {
      onClick: () => act('下移小节', (current) => edit.moveBar(current, target.sectionId, target.barIndex, 'down')),
    }),
  ]);

  const emptyRow = el('div', { class: 'action-grid' }, [
    bar.type === 'empty'
      ? button('取消空白（填入整小节休止）', {
          onClick: () =>
            act('取消空白', (current) => edit.setBarEmpty(current, target.sectionId, target.barIndex, false)),
        })
      : button('设为空白小节', {
          onClick: async () => {
            if (eventCount > 0) {
              const confirmed = await confirmDialog({
                title: '设为空白小节会清空内容',
                message: `第 ${target.barIndex + 1} 小节里有 ${eventCount} 个事件，设为空白会把它们全部删掉，而且从谱面上看不出原来的内容。`,
                detail: '「空白小节」和「休止」是两种不同的音乐含义：空白是整小节不写内容，休止是明确要求这几拍不发声。',
                confirmText: '确认清空并设为空白',
                danger: true,
              });
              if (!confirmed) return;
            }
            act('设为空白小节', (current) =>
              edit.setBarEmpty(current, target.sectionId, target.barIndex, true, { discardEvents: true }),
            );
          },
        }),
  ]);

  const dangerRow = el('div', { class: 'action-grid' }, [
    button('删除这一小节', {
      variant: 'danger',
      disabled: isOnlyBar,
      title: isOnlyBar ? '这一段只剩一个小节了，至少要保留一个' : null,
      onClick: async () => {
        const confirmed = await confirmDialog({
          title: '删除小节',
          message: `确定删除 ${section.name} 的第 ${target.barIndex + 1} 小节吗？删掉之后后面的小节会往前挪。`,
          detail: '这一步可以用「撤销」恢复。',
          confirmText: '删除',
          danger: true,
        });
        if (!confirmed) return;
        act('删除小节', (current) => edit.removeBar(current, target.sectionId, target.barIndex));
      },
    }),
  ]);

  // 自由文字块（SPEC §8.10）：列出已有块（可编辑文字 / 删除），加一个「新增文字块」。
  const textBlocks = Array.isArray(bar.textBlocks) ? bar.textBlocks : [];
  const textBlockRows = textBlocks.map((block) =>
    el('div', { class: 'textblock-row' }, [
      el('span', { class: 'textblock-row__text', text: block.text || '（空）' }),
      button('改文字', {
        class: 'btn--small',
        onClick: async () => {
          handle.close(null);
          const value = await askText({
            title: '编辑文字块',
            label: '文字（可换行）',
            value: block.text,
            maxLength: LIMITS.textBlockMaxLength,
            multiline: true,
            placeholder: '例如「副歌第一遍」',
            hint: '可以按回车换行，逐行写。',
          });
          if (value === null) return;
          apply(ctx, '编辑文字块', (current) =>
            edit.setTextBlockText(current, target.sectionId, target.barIndex, block.id, value),
          );
        },
      }),
      button('删除', {
        class: 'btn--small',
        variant: 'danger',
        onClick: () => act('删除文字块', (current) =>
          edit.removeTextBlock(current, target.sectionId, target.barIndex, block.id),
        ),
      }),
    ]),
  );

  const addTextBlockRow = el('div', { class: 'action-grid' }, [
    button('＋ 新增文字块', {
      onClick: async () => {
        handle.close(null);
        const value = await askText({
          title: '新增文字块',
          label: '文字（可换行）',
          value: '',
          maxLength: LIMITS.textBlockMaxLength,
          multiline: true,
          placeholder: '例如「副歌第一遍」',
          hint: '可以按回车换行。新增后可以在谱面上拖动它到任意位置。',
        });
        if (value === null || value.trim() === '') return;
        // 按粒度决定默认锚点（§8.10）：按和弦写时默认绑到第一个和弦，否则小节级。
        const mode = song.layout.textBlockMode ?? 'bar';
        const defaultAnchor = mode === 'chord' && bar.type !== 'empty' && bar.events.length > 0 ? 0 : -1;
        apply(ctx, '新增文字块', (current) =>
          edit.addTextBlock(current, target.sectionId, target.barIndex, {
            text: value,
            // 默认落在小节下方的「文字栏」，不是框正中间（§8.10）。
            // x=0.5 水平居中，y=0.8 落到和弦下方那一行，字往下、往右延伸。
            x: 0.5,
            y: 0.8,
            anchor: defaultAnchor,
          }),
        );
      },
    }),
  ]);

  handle = openSheet({
    title: `第 ${target.barIndex + 1} 小节`,
    subtitle: `${section.name}（${target.barIndex + 1} / ${section.bars.length}）`,
    body: el('div', { class: 'sheet-form' }, [
      statusNode,
      group('添加事件', [addRow]),
      group('小节操作', [moveRow]),
      group('文字块', [addTextBlockRow, ...textBlockRows], '文字块可自由拖到小节任意位置（编辑模式下）。留空删除。'),
      group('空白 / 休止', [emptyRow], '两者含义不同：空白是留白，休止是明确不发声。'),
      group('危险操作', [dangerRow]),
    ]),
    actions: [button('关闭', { onClick: () => handle.close(null) })],
  });
}

/* ------------------------------------------------------------------ *
 * 段落面板
 * ------------------------------------------------------------------ */

/**
 * 打开段落操作面板。
 *
 * @param {{store: Object}} ctx
 * @param {string} sectionId
 */
export function openSectionSheet(ctx, sectionId) {
  const song = ctx.store.getSong();
  const section = song.sections.find((item) => item.id === sectionId);
  if (!section) {
    toast('找不到这个段落，它可能刚被删除了。', { type: 'error' });
    return;
  }

  const index = song.sections.indexOf(section);
  const isOnlySection = song.sections.length <= 1;
  const beatsPerBar = getBeatsPerBar(song.timeSignature);

  let handle;

  function act(label, mutator) {
    const done = apply(ctx, label, mutator);
    if (done) handle.close(true);
  }

  /** 需要弹出输入框的动作：先关面板再弹，避免两层对话框叠在一起。 */
  async function actWithInput(label, prompt, mutator) {
    handle.close(null);
    const value = await askText(prompt);
    if (value === null) return;
    apply(ctx, label, (current) => mutator(current, value));
  }

  const repeatRow = el(
    'div',
    { class: 'toggles toggles--repeat' },
    [1, 2, 3, 4, 6, 8].map((value) =>
      button(`${value}×`, {
        class: `toggle${section.repeat === value ? ' is-active' : ''}`,
        title: `重复 ${value} 次`,
        onClick: () =>
          act('修改重复次数', (current) => edit.setSectionRepeat(current, sectionId, value)),
      }),
    ),
  );

  const barsSummary = section.bars.map((bar, barIndex) => {
    const total = sumEventBeats(bar.events.map((event) => ({ beats: event.beats })));
    const ok = bar.type === 'empty' || beatsEqual(total, beatsPerBar);
    return {
      barIndex,
      text:
        bar.type === 'empty'
          ? `${barIndex + 1}：空白`
          : `${barIndex + 1}：${bar.events.length} 事件 · ${Math.round(total * 1000) / 1000} 拍${ok ? '' : ' ⚠'}`,
      ok,
    };
  });
  const badBars = barsSummary.filter((item) => !item.ok);

  handle = openSheet({
    title: `段落 ${section.name}`,
    subtitle: `第 ${index + 1} / ${song.sections.length} 段 · ${section.bars.length} 小节`,
    body: el('div', { class: 'sheet-form' }, [
      group('重命名与提示', [
        el('div', { class: 'action-grid' }, [
          button('重命名段落', {
            onClick: () =>
              actWithInput(
                '重命名段落',
                {
                  title: '重命名段落',
                  label: '段落名',
                  value: section.name,
                  maxLength: LIMITS.sectionNameMaxLength,
                  required: true,
                  hint: '允许与其它段落同名（同名段落是合法的，也常见）。',
                },
                (current, value) => edit.renameSection(current, sectionId, value),
              ),
          }),
          button(section.cue ? '修改演奏提示' : '添加演奏提示', {
            onClick: () =>
              actWithInput(
                '修改演奏提示',
                {
                  title: '演奏提示',
                  label: '提示内容',
                  value: section.cue,
                  maxLength: LIMITS.sectionCueMaxLength,
                  multiline: true,
                  hint: '例如「清音扫弦，弱起」「这段鼓进来」。留空表示不要提示。',
                },
                (current, value) => edit.setSectionCue(current, sectionId, value),
              ),
          }),
        ]),
      ]),
      group('重复次数', [repeatRow], '只是演奏标注，不会复制实际小节。'),
      group('小节', [
        el('div', { class: 'action-grid' }, [
          button('末尾加一小节', {
            onClick: () =>
              act('插入小节', (current) => edit.insertBar(current, sectionId, section.bars.length)),
          }),
          button('复制这个段落', {
            onClick: () => act('复制段落', (current) => edit.duplicateSection(current, sectionId)),
          }),
          button('上移', {
            onClick: () => act('上移段落', (current) => edit.moveSection(current, sectionId, 'up')),
          }),
          button('下移', {
            onClick: () => act('下移段落', (current) => edit.moveSection(current, sectionId, 'down')),
          }),
        ]),
        badBars.length > 0
          ? el('p', {
              class: 'group__hint group__hint--warn',
              text: `有 ${badBars.length} 个小节的时值不合法：${badBars.map((item) => item.barIndex + 1).join('、')} 小节。点谱面上的小节序号可以单独处理。`,
            })
          : null,
      ]),
      group('危险操作', [
        el('div', { class: 'action-grid' }, [
          button('删除这个段落', {
            variant: 'danger',
            disabled: isOnlySection,
            title: isOnlySection ? '歌曲至少要保留一个段落' : null,
            onClick: async () => {
              const confirmed = await confirmDialog({
                title: '删除段落',
                message: `确定删除段落「${section.name}」吗？它下面的 ${section.bars.length} 个小节会一起删掉。`,
                detail: '这一步可以用「撤销」恢复。',
                confirmText: '删除',
                danger: true,
              });
              if (!confirmed) return;
              act('删除段落', (current) => edit.removeSection(current, sectionId));
            },
          }),
        ]),
      ]),
    ]),
    actions: [button('关闭', { onClick: () => handle.close(null) })],
  });
}

/**
 * 新增段落：问名字 → 插在当前段落之后。
 *
 * @param {{store: Object}} ctx
 * @param {?string} afterSectionId 传 null 表示加到末尾
 */
export async function addSectionFlow(ctx, afterSectionId = null) {
  const song = ctx.store.getSong();
  const atIndex = afterSectionId
    ? song.sections.findIndex((section) => section.id === afterSectionId) + 1
    : song.sections.length;

  const name = await askText({
    title: '新增段落',
    label: '段落名',
    value: '',
    maxLength: LIMITS.sectionNameMaxLength,
    required: true,
    placeholder: '例如 Verse / 副歌',
    hint: '新段落会带一个空白小节，方便直接往里写和弦。',
    confirmText: '添加',
  });
  if (name === null) return;

  const done = apply(ctx, '新增段落', (current) => edit.addSection(current, { name, atIndex }));
  if (done) toast(`已添加段落「${name.trim()}」`, { type: 'success' });
}
