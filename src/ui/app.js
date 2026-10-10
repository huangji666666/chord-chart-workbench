/**
 * 应用装配：布局、模式切换、撤销重做、自动保存、打印、快捷键。
 *
 * ## 重画策略：整块重建 + 状态还原
 *
 * 面板一律**整块重建**，而不是细粒度地改某几个节点。理由是细粒度更新很容易
 * 出现「数据改了但界面没跟上」这种最讨厌的问题——它会让人开始怀疑屏幕上的
 * 东西是不是真的。代价是重建会换掉正在输入的控件，所以重建前后要做两件事：
 *
 * 1. **搬回焦点与光标**（`captureFocus` / `restoreFocus`，靠 `data-focus-key`）。
 * 2. **搬回 `<details>` 的展开状态**（`dom.js` 里按 summary 文字记着）。
 *
 * 另外表单提交时机是 `change` 而不是 `input`，所以打字过程中根本不会触发重建，
 * 这两件事只是兜底。
 *
 * ## 视口只影响「控件放在哪」，不影响「能做什么」
 *
 * 宽屏：四个面板在左栏常驻。窄屏：同样的面板内容放进底部面板（sheet），
 * 由底部工具条打开。两边调用的是**同一批渲染函数**，不存在
 * 「桌面能改、手机改不了」的功能差异。
 *
 * @module ui/app
 */

import { collectDurationIssues } from '../core/duration.js';
import * as edit from '../core/edit.js';
import { loadPrefs, savePrefs, getThemeColors, getFontStack } from '../core/theme.js';
import { buildWarnBarSet, renderChart } from './chart.js';
import { button, captureFocus, el, replaceChildren, restoreFocus } from './dom.js';
import { openSheet, toast, confirmDialog } from './dialogs.js';
import {
  renderIssuesBanner,
  renderLibraryPanel,
  renderProjectPanel,
  renderRepairBanner,
  renderSaveStatus,
  renderSongForm,
  renderStorageBanner,
  renderTextPanel,
} from './panels.js';
import { buildPngPages } from './png.js';
import { openExportPanel } from './export.js';
import { addSectionFlow, openBarSheet, openEventSheet, openSectionSheet } from './sheets.js';
import { MODES, createStore } from './store.js';

const MODE_LABELS = { edit: '编辑', preview: '预览', present: '演出' };

/** 宽屏断点：与 styles.css 里的 `--wide` 保持一致。 */
const WIDE_QUERY = '(min-width: 1024px)';

/**
 * 把当前歌曲数成一堆便于核对的数字。给浏览器验证和排查用。
 * @param {import('../core/song.js').Song} song
 */
function summarize(song) {
  let bars = 0;
  let chords = 0;
  let rests = 0;
  let empties = 0;
  for (const section of song.sections) {
    for (const bar of section.bars) {
      bars += 1;
      if (bar.type === 'empty') {
        empties += 1;
        continue;
      }
      for (const event of bar.events) {
        if (event.kind === 'chord') chords += 1;
        else rests += 1;
      }
    }
  }
  return {
    songId: song.id,
    title: song.title,
    sections: song.sections.length,
    bars,
    chords,
    rests,
    empties,
    timeSignature: song.timeSignature,
    displayLines: (song.layout.displayLines ?? []).join(','),
    // 可缺省字段：缺失就是缺省写法（SPEC §7.4）。这里如实报 `null` 而不是补成缺省值，
    // 因为「数据里到底有没有这个字段」正是验证脚本要看的。
    chordSymbols: song.layout.chordSymbols ?? null,
    accidentalGlyphs: song.layout.accidentalGlyphs ?? null,
    seventhSuffix: song.layout.seventhSuffix ?? null,
    restText: song.layout.restText ?? null,
    dimSuffix: song.layout.dimSuffix ?? null,
    barsPerRow: song.layout.barsPerRow,
    fontScale: song.layout.fontScale,
  };
}

/**
 * 创建应用。
 *
 * @param {{root: HTMLElement, store?: Object}} options
 */
export function createApp(options) {
  const root = options.root;
  const store = options.store ?? createStore();

  /** @type {any} */
  let ctx;

  /* ---------------------------------------------------------------- *
   * DOM 骨架
   * ---------------------------------------------------------------- */

  const barEl = el('header', { class: 'app__bar' });
  const bannersEl = el('div', { class: 'app__banners' });
  const sideEl = el('aside', { class: 'app__side', 'aria-label': '歌曲信息与工具' });
  const paperEl = el('div', { class: 'app__paper' });
  const bottomEl = el('nav', { class: 'app__bottom', 'aria-label': '常用操作' });
  const shell = el('div', { class: 'app' }, [
    barEl,
    bannersEl,
    el('div', { class: 'app__main' }, [sideEl, paperEl]),
    bottomEl,
  ]);
  root.replaceChildren(shell);

  const wideQuery = window.matchMedia(WIDE_QUERY);
  const isWide = () => wideQuery.matches;

  /** 窄屏下打开的面板（宽屏常驻左栏，不需要它）。 */
  let openPanel = null;
  /** 需要在重画之后滚到某个元素上（例如从时值问题跳到某个小节）。 */
  let pendingScrollKey = null;
  /** 演出模式的屏幕常亮句柄；浏览器不支持时保持 null，不影响使用。 */
  let wakeLock = null;

  /** 当前主题偏好（配色 + 字体）。设备级，与歌曲无关（SPEC §9.2）。 */
  let prefs = loadPrefs();

  /**
   * 把当前偏好落到 DOM 上：色表写进 `:root` 的 CSS 变量，字体栈写进
   * `--font-sans`。屏幕、打印都吃这一份；PNG / PDF 导出在 `png.js` 里
   * 读同一份色表（`getThemeColors`），三者共用颜色真相。
   */
  function applyTheme() {
    const root = document.documentElement;
    const colors = getThemeColors(prefs.theme);
    for (const [key, value] of Object.entries(colors)) {
      // paperAlt → --paper-alt，accentInk → --accent-ink ……
      const cssVar = `--${key.replace(/[A-Z]/g, (ch) => `-${ch.toLowerCase()}`)}`;
      root.style.setProperty(cssVar, value);
    }
    root.style.setProperty('--font-sans', getFontStack(prefs.font));
  }

  /** 切换主题：写偏好、落 DOM、重画。 */
  function setPrefs(next) {
    prefs = { theme: next.theme ?? prefs.theme, font: next.font ?? prefs.font };
    savePrefs(prefs);
    applyTheme();
  }

  /* ---------------------------------------------------------------- *
   * 渲染
   * ---------------------------------------------------------------- */

  function renderTopBar() {
    const song = store.getSong();
    const mode = store.getMode();
    const history = store.getHistoryInfo();

    // 演出模式顶栏（SPEC §8.7）：歌名 + 模式切换，**不摆撤销重做和保存状态**——
    // 台上没有注意力分给那些。但模式切换的三个入口必须留着，否则进了演出就
    // 找不到路回编辑/预览（谱面下方另有一个「返回编辑」兜底，两处都能走）。
    if (mode === 'present') {
      barEl.replaceChildren(
        el('div', { class: 'app__brand' }, [
          el('span', { class: 'app__brand-name', text: song.title }),
          el('span', { class: 'app__brand-sub', text: '演出模式' }),
        ]),
        el(
          'div',
          { class: 'segmented', role: 'group', 'aria-label': '界面模式' },
          MODES.map((item) =>
            button(MODE_LABELS[item], {
              class: `segmented__item${item === mode ? ' is-active' : ''}`,
              ariaLabel: `${MODE_LABELS[item]}模式`,
              title:
                item === 'present'
                  ? '演出：大字号、屏幕常亮、适合台上看谱'
                  : item === 'preview'
                    ? '预览：只看谱面，点按不会触发编辑'
                    : '编辑模式',
              onClick: () => setMode(item),
            }),
          ),
        ),
      );
      return;
    }

    barEl.replaceChildren(
      el('div', { class: 'app__brand' }, [
        el('span', { class: 'app__brand-name', text: '功能谱制谱工作台' }),
        el('span', { class: 'app__brand-sub', text: song.title }),
      ]),
      el(
        'div',
        { class: 'segmented', role: 'group', 'aria-label': '界面模式' },
        MODES.map((item) =>
          button(MODE_LABELS[item], {
            class: `segmented__item${item === mode ? ' is-active' : ''}`,
            ariaLabel: `${MODE_LABELS[item]}模式`,
            title:
              item === 'present'
                ? '隐藏所有编辑控件，适合演出时看谱'
                : item === 'preview'
                  ? '只看谱面，点按不会触发编辑'
                  : '编辑模式',
            onClick: () => setMode(item),
          }),
        ),
      ),
      el('div', { class: 'app__tools' }, [
        button(history.canUndo ? `撤销${history.undoLabel ? `：${history.undoLabel}` : ''}` : '撤销', {
          class: 'btn--small app__undo',
          disabled: !history.canUndo,
          title: history.canUndo ? `撤销「${history.undoLabel}」` : '没有可撤销的操作',
          onClick: () => runUndo(),
        }),
        button('重做', {
          class: 'btn--small app__redo',
          disabled: !history.canRedo,
          title: history.canRedo ? `重做「${history.redoLabel}」` : '没有可重做的操作',
          onClick: () => runRedo(),
        }),
        renderSaveStatus(ctx),
      ]),
    );
  }

  function renderBanners() {
    const storage = renderStorageBanner(ctx);
    const repair = renderRepairBanner(ctx);
    const issues = renderIssuesBanner(ctx);
    bannersEl.replaceChildren(...[storage, repair, issues].filter(Boolean));
  }

  function renderPaper() {
    const song = store.getSong();
    const mode = store.getMode();
    const issues = collectDurationIssues(song);
    const warnBars = buildWarnBarSet(issues);

    const build = (availableWidth) =>
      renderChart(song, {
        mode,
        selection: store.getSelection(),
        warnBars,
        availableWidth,
        onSection: (sectionId) => openSectionSheet(ctx, sectionId),
        onBar: (sectionId, barIndex) => selectBar(sectionId, barIndex),
        onEvent: (sectionId, barIndex, eventIndex) =>
          openEventSheet(ctx, { sectionId, barIndex, eventIndex }),
        onTextBlockMove: (sectionId, barIndex, textBlockId, position) =>
          moveTextBlock(sectionId, barIndex, textBlockId, position),
      });

    const exitHint =
      mode === 'edit'
        ? null
        : el('div', { class: 'paper-exit' }, [
            button('返回编辑', { variant: 'primary', onClick: () => setMode('edit') }),
          ]);

    // 谱面需要知道「屏幕实际有多少宽度」，才能在窄屏上把每行小节数降下来，
    // 让和弦块不至于缩到点不中（§9）。
    //
    // 宽度靠量上一次的 `.sec__grid` 来得到，而不是量容器再减去 padding：
    // 栅格的宽度只由容器决定，**跟每行排几列无关**，所以「量上一次 → 画这一次」
    // 不会自我循环。首次渲染没有上一次可量，就画完再量一次、按真实宽度补画。
    // 用 dom.js 的 `replaceChildren`（会跳过空值），不要用原生那个：
    // 编辑模式下 `exitHint` 是 null，原生方法会把 null 变成页面上一个
    // 字面的「null」文本节点——不报错、不抛异常，只有截图能发现。
    const assumed = paperEl.querySelector('.sec__grid')?.clientWidth;
    let chart = build(assumed);
    replaceChildren(paperEl, chart, exitHint);

    const actual = chart.querySelector('.sec__grid')?.clientWidth;
    if (actual && actual !== assumed) {
      chart = build(actual);
      replaceChildren(paperEl, chart, exitHint);
    }

    if (pendingScrollKey) {
      const key = pendingScrollKey;
      pendingScrollKey = null;
      const target = paperEl.querySelector(`[data-focus-key="${CSS.escape(key)}"]`);
      if (target) {
        try {
          target.scrollIntoView({ block: 'center', behavior: 'smooth' });
        } catch {
          target.scrollIntoView();
        }
      }
    }
  }

  function renderSide() {
    if (!isWide()) {
      sideEl.replaceChildren();
      return;
    }
    const snapshot = captureFocus(sideEl);
    sideEl.replaceChildren(
      renderSongForm(ctx),
      renderLibraryPanel(ctx),
      renderTextPanel(ctx),
      renderProjectPanel(ctx),
    );
    restoreFocus(sideEl, snapshot);
  }

  function renderBottom() {
    const history = store.getHistoryInfo();
    const mode = store.getMode();
    bottomEl.replaceChildren(
      button('撤销', {
        class: 'bottom__item',
        disabled: !history.canUndo,
        ariaLabel: '撤销',
        onClick: () => runUndo(),
      }),
      button('重做', {
        class: 'bottom__item',
        disabled: !history.canRedo,
        ariaLabel: '重做',
        onClick: () => runRedo(),
      }),
      button('＋段落', {
        class: 'bottom__item',
        ariaLabel: '新增段落',
        onClick: () => addSectionFlow(ctx, null),
      }),
      button('面板', {
        class: 'bottom__item',
        ariaLabel: '打开面板',
        onClick: openPanelMenu,
      }),
      button(mode === 'edit' ? '演出' : '编辑', {
        class: 'bottom__item',
        variant: mode === 'edit' ? null : 'primary',
        ariaLabel: mode === 'edit' ? '进入演出模式' : '返回编辑模式',
        onClick: () => setMode(mode === 'edit' ? 'present' : 'edit'),
      }),
    );
  }

  /**
   * 重画。
   *
   * `reason` 为 `'text'` 时直接返回：那是用户在文本框里打字触发的，
   * 重画会把文本框换掉——打字时被换掉输入框是最让人恼火的一种卡顿。
   *
   * @param {string} reason
   */
  function render(reason) {
    if (reason === 'text') return;

    const song = store.getSong();
    shell.dataset.mode = store.getMode();

    if (!song) {
      barEl.replaceChildren();
      bottomEl.replaceChildren();
      sideEl.replaceChildren();
      bannersEl.replaceChildren();
      paperEl.replaceChildren(el('p', { class: 'empty-state', text: '曲库里没有歌曲。' }));
      return;
    }

    renderTopBar();
    renderBanners();
    renderPaper();
    renderBottom();
    renderSide();
    refreshOpenPanel();
  }

  /* ---------------------------------------------------------------- *
   * 动作
   * ---------------------------------------------------------------- */

  function runUndo() {
    if (!store.undo()) return;
    const history = store.getHistoryInfo();
    toast(`已撤销。当前状态：${history.currentLabel}`, { type: 'info', duration: 2500 });
  }

  function runRedo() {
    if (!store.redo()) return;
    const history = store.getHistoryInfo();
    toast(`已重做：${history.currentLabel}`, { type: 'info', duration: 2500 });
  }

  function setMode(mode) {
    store.setMode(mode);
    applyWakeLock();
  }

  function selectBar(sectionId, barIndex) {
    store.setSelection({ sectionId, barIndex, eventIndex: null });
    pendingScrollKey = `bar-${sectionId}-${barIndex}`;
    openBarSheet(ctx, { sectionId, barIndex });
    render('selection');
  }

  /** 拖拽文字块松手时写回位置（SPEC §8.10）。一次拖拽 = 一步撤销。 */
  function moveTextBlock(sectionId, barIndex, textBlockId, position) {
    const result = store.run('移动文字块', (current) =>
      edit.moveTextBlock(current, sectionId, barIndex, textBlockId, position),
    );
    if (!result.ok) {
      toast(result.message, { type: 'error', detail: result.code });
    }
  }

  function switchSong(songId) {
    if (songId === store.getLibrary().activeSongId) return;
    if (store.hasPendingTextDraft()) {
      const draftWarning = confirmDialog({
        title: '文本框里还有没应用的改动',
        message: '切换歌曲会清空文本框里还没应用的内容。',
        detail: '想保留的话，先回「文本输入」点一次「解析并应用」。',
        confirmText: '仍然切换',
        danger: true,
      });
      draftWarning.then((confirmed) => {
        if (confirmed) store.switchSong(songId);
      });
      return;
    }
    store.switchSong(songId);
  }

  function newSong() {
    const song = store.createSong();
    toast(`已新建「${song.title}」。`, { type: 'success' });
  }

  function copyCurrent() {
    const song = store.duplicateSong();
    toast(`已复制为「${song.title}」。新歌曲的所有 ID 都是新的。`, { type: 'success' });
  }

  function openPanelMenu() {
    let handle;
    const items = [
      { label: '歌曲信息', open: () => openPanelSheet('歌曲信息', () => renderSongForm(ctx)) },
      { label: '曲库与保存', open: () => openPanelSheet('曲库', () => renderLibraryPanel(ctx)) },
      { label: '文本输入', open: () => openPanelSheet('文本输入', () => renderTextPanel(ctx)) },
      { label: '数据（导入导出 / 打印）', open: () => openPanelSheet('数据', () => renderProjectPanel(ctx)) },
    ];
    handle = openSheet({
      title: '打开面板',
      body: el(
        'div',
        { class: 'choice-list' },
        items.map((item) =>
          button(item.label, {
            class: 'choice',
            variant: 'quiet',
            onClick: () => {
              handle.close(null);
              item.open();
            },
          }),
        ),
      ),
      actions: [button('关闭', { onClick: () => handle.close(null) })],
    });
  }

  function openPanelSheet(title, build) {
    if (openPanel) {
      openPanel.handle.close(null);
      openPanel = null;
    }
    const container = el('div', { class: 'sheet-panel' });
    container.append(build());

    let handle;
    handle = openSheet({
      title,
      body: container,
      actions: [button('关闭', { onClick: () => handle.close(null) })],
      onClose: () => {
        if (openPanel && openPanel.handle === handle) openPanel = null;
      },
    });
    openPanel = { handle, build, container };
  }

  function refreshOpenPanel() {
    if (!openPanel) return;
    const snapshot = captureFocus(openPanel.container);
    openPanel.container.replaceChildren(openPanel.build());
    restoreFocus(openPanel.container, snapshot);
  }

  function printSong() {
    // 打印样式在 @media print 里：只留谱纸，去掉按钮与编辑控件（§8.4）。
    window.print();
  }

  function exportPng() {
    // 统一导出入口（SPEC §8.4）：一个面板里选 PDF / PNG / 打印 + 选页。
    return openExportPanel(ctx);
  }

  /* ---------------------------------------------------------------- *
   * 演出模式：屏幕常亮（可选增强，失败不影响使用）
   * ---------------------------------------------------------------- */

  async function applyWakeLock() {
    const want = store.getMode() === 'present';
    try {
      if (want && !wakeLock && 'wakeLock' in navigator) {
        wakeLock = await navigator.wakeLock.request('screen');
        wakeLock.addEventListener('release', () => {
          wakeLock = null;
        });
      } else if (!want && wakeLock) {
        const handle = wakeLock;
        wakeLock = null;
        await handle.release();
      }
    } catch {
      // 浏览器不支持或被策略拦下：静默降级，演出照样能用，只是屏幕会自己熄。
      wakeLock = null;
    }
  }

  /* ---------------------------------------------------------------- *
   * 全局事件
   * ---------------------------------------------------------------- */

  function onKeydown(event) {
    const target = event.target;
    const inField =
      target instanceof HTMLElement &&
      (target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA' ||
        target.tagName === 'SELECT' ||
        target.isContentEditable);

    const modifier = event.metaKey || event.ctrlKey;
    if (!modifier) return;
    const key = event.key.toLowerCase();

    // 在输入框里按 Cmd/Ctrl+Z 应该撤销「打字」，不是撤销整个谱面操作。
    if (inField) return;
    if (key === 'z' && !event.shiftKey) {
      event.preventDefault();
      runUndo();
    } else if ((key === 'z' && event.shiftKey) || key === 'y') {
      event.preventDefault();
      runRedo();
    }
  }

  /**
   * 软键盘避让（§9）。
   *
   * 真机上的软键盘行为没法在桌面浏览器里复现，所以这里是一个稳妥的近似：
   * 聚焦后把控件滚到视口中间。底部面板的操作按钮是 sticky 的，键盘弹起来
   * 也不会被顶出屏幕。**真机行为属于未验证项**。
   */
  function onFocusIn(event) {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    if (!['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return;
    setTimeout(() => {
      try {
        target.scrollIntoView({ block: 'center', behavior: 'smooth' });
      } catch {
        // 老浏览器不支持 options，忽略。
      }
    }, 300);
  }

  let resizeTimer = null;
  function onResize() {
    if (resizeTimer) return;
    resizeTimer = setTimeout(() => {
      resizeTimer = null;
      // 从窄屏转成宽屏时，浮动的面板不该继续挂在上面。
      if (isWide() && openPanel) {
        openPanel.handle.close(null);
        openPanel = null;
      }
      render('resize');
    }, 160);
  }

  function onVisibilityChange() {
    // 标签页切回来时屏幕常亮会被浏览器解除，需要重新申请。
    if (store.getMode() === 'present' && document.visibilityState === 'visible' && !wakeLock) {
      applyWakeLock();
    }
  }

  function onBeforeUnload() {
    // 关页面前把还没落盘的改动写完，否则那 200ms 合并窗口里的改动会丢。
    store.flushSave();
  }

  /* ---------------------------------------------------------------- *
   * 启动
   * ---------------------------------------------------------------- */

  ctx = {
    store,
    report(result) {
      toast(result.message, { type: 'error', detail: result.code });
    },
    switchSong,
    newSong,
    copyCurrent,
    selectBar,
    print: printSong,
    exportPng,
    // 主题偏好（SPEC §9.2）：设置面板读写，改完即落 DOM + 存 localStorage。
    getPrefs: () => ({ ...prefs }),
    setPrefs,
  };

  document.addEventListener('keydown', onKeydown);
  document.addEventListener('focusin', onFocusIn);
  window.addEventListener('resize', onResize);
  window.addEventListener('beforeunload', onBeforeUnload);
  document.addEventListener('visibilitychange', onVisibilityChange);
  wideQuery.addEventListener('change', onResize);

  // 启动即应用主题：读偏好 → 落 CSS 变量与字体栈。
  applyTheme();

  store.subscribe((reason) => render(reason));
  render('init');

  /**
   * 浏览器验证用的句柄。
   *
   * 这个应用没有服务器、不联网，暴露它没有任何安全上的变化；但它让「三档视口
   * 验证」可以**读真实数据**（段落数、小节数、PNG 页数），而不是靠看截图猜。
   * 验证脚本 `.verify/cdp-verify.mjs` 用它。
   */
  window.__chordChart = {
    store,
    getSong: () => store.getSong(),
    summarize: () => summarize(store.getSong()),
    collectDurationIssues: () => collectDurationIssues(store.getSong()),
    buildPngPages: (opts) => buildPngPages(store.getSong(), opts),
    version: 1,
  };

  return { store, render, summarize };
}
