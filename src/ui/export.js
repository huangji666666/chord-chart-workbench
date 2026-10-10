/**
 * 导出与打印的统一入口（SPEC §8.4）。
 *
 * 一个面板、三种出口：
 *
 * - **保存为 PDF**：应用自己合成多页 PDF（`core/pdf.js`），内嵌 JPEG、能选页。
 * - **保存为图片**：每页一个 PNG，能选页。
 * - **浏览器打印**：`window.print()`，矢量文字，但**不能选页**。
 *
 * 「能选页」的两个出口共用同一套分页计算（`png.js` 的 `buildPngPages`），
 * 缩略图看到的第 N 页就是文件里的第 N 页（§8.4 第 1 条）。
 *
 * @module ui/export
 */

import { buildPdf } from '../core/pdf.js';
import { collectDurationIssues, formatDurationIssues } from '../core/duration.js';
import { loadPrefs } from '../core/theme.js';
import { canvasToBlob, safeBaseName, buildPngPages, PAGE } from './png.js';
import { button, downloadBlob, el } from './dom.js';
import { confirmDialog, openSheet, toast } from './dialogs.js';

/** 三种出口。 */
const EXPORTS = Object.freeze([
  { id: 'pdf', label: '保存为 PDF', desc: '一个多页 PDF，可勾选页，手机上也能一键下载。文字是图片、不可搜索。' },
  { id: 'png', label: '保存为图片', desc: '每页一张 PNG，可勾选页。' },
  { id: 'print', label: '浏览器打印', desc: '可送打印机，或在其对话框里另存 PDF；文字可搜索，但不能选页。' },
]);

/**
 * 打开「导出与打印」面板。
 *
 * @param {{store: Object, print: Function}} ctx
 */
export async function openExportPanel(ctx) {
  const song = ctx.store.getSong();

  // 时值问题：任一出口启动前都要提醒（§8.4 第 4 条），但只需提醒一次。
  const issues = collectDurationIssues(song);
  if (issues.length > 0) {
    const confirmed = await confirmDialog({
      title: '这首歌还有时值问题',
      message: `有 ${issues.length} 个小节的时值不合法。导出的谱面会照现在的数据画，问题不会自己变正确。`,
      detail: formatDurationIssues(issues),
      confirmText: '仍然导出',
      danger: true,
    });
    if (!confirmed) return;
  }

  // 先把能选页的两个出口要用的页算出来。失败则整体降级，不给用户一个
  // 「面板能开、一导出就报错」的半成品。
  let pages = null;
  try {
    // 导出颜色随主题走（SPEC §9.2）。读全局偏好，认不出退缺省。
    const prefs = loadPrefs();
    pages = buildPngPages(song, { theme: prefs.theme }).pages;
  } catch (error) {
    toast(`生成谱面失败：${error?.message ?? error}`, {
      type: 'error',
      detail: '如果浏览器处于隐私模式或禁用了 canvas，图片 / PDF 导出会失败。可以改用「浏览器打印」。',
      duration: 0,
    });
    return;
  }

  const pageCount = pages.length;
  /** 勾选状态，默认全选。 */
  const selected = new Set(pages.map((page) => page.index));
  const checkboxes = [];
  let currentExport = 'pdf';

  /* ---------------- 页选择 UI ---------------- */

  const pageRows = pages.map((page) => {
    const checkbox = el('input', {
      type: 'checkbox',
      class: 'checkbox',
      checked: true,
      'aria-label': `选择第 ${page.index + 1} 页`,
    });
    checkbox.checked = true;
    checkbox.addEventListener('change', () => {
      if (checkbox.checked) selected.add(page.index);
      else selected.delete(page.index);
      updateActions();
    });
    checkboxes.push(checkbox);

    return el('label', { class: 'page-row' }, [
      checkbox,
      el('span', { class: 'page-row__thumb' }, [
        el('canvas', { class: 'page-row__preview', width: '90', height: '127' }),
      ]),
      el('span', { class: 'page-row__text' }, [
        el('span', { class: 'page-row__title', text: `第 ${page.index + 1} 页` }),
        el('span', { class: 'page-row__meta', text: `${page.canvas.width} × ${page.canvas.height}` }),
      ]),
    ]);
  });

  pageRows.forEach((row, index) => {
    const preview = row.querySelector('canvas');
    const context = preview.getContext('2d');
    if (!context) return;
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, preview.width, preview.height);
    context.drawImage(pages[index].canvas, 0, 0, preview.width, preview.height);
    context.strokeStyle = '#e0ded7';
    context.strokeRect(0.5, 0.5, preview.width - 1, preview.height - 1);
  });

  // 页选择区：打印出口用不到（浏览器决定分页），所以要能整块隐藏。
  const pagePicker = el('div', { class: 'export__pages' }, [
    el('p', { class: 'notice', text: '长歌会按 A4 比例分页，一个小节不会被截断到两页。勾选要导出的页。' }),
    el('div', { class: 'page-list' }, pageRows),
    el('div', { class: 'action-grid' }, [
      button('全选', { onClick: () => setAll(true) }),
      button('全不选', { onClick: () => setAll(false) }),
    ]),
  ]);

  function setAll(checked) {
    pages.forEach((page, index) => {
      if (checked) selected.add(page.index);
      else selected.delete(page.index);
      if (checkboxes[index]) checkboxes[index].checked = checked;
    });
    updateActions();
  }

  // 打印说明：只有打印出口才显示，讲清「不能选页」这个限制。
  const printNote = el('p', {
    class: 'notice',
    text: '浏览器打印会打开系统打印对话框，在里面选打印机或「另存为 PDF」。分页由浏览器决定，这里无法只打印某一页。',
  });

  /* ---------------- 出口选择 ---------------- */

  const exportChoices = EXPORTS.map((item) =>
    el('label', { class: 'export-choice' }, [
      el('input', {
        type: 'radio',
        name: 'export-kind',
        value: item.id,
        checked: item.id === 'pdf',
      }),
      el('span', { class: 'export-choice__body' }, [
        el('span', { class: 'export-choice__label', text: item.label }),
        el('span', { class: 'export-choice__desc', text: item.desc }),
      ]),
    ]),
  );

  exportChoices.forEach((node) => {
    const radio = node.querySelector('input');
    radio.addEventListener('change', () => {
      if (radio.checked) switchExport(radio.value);
    });
  });

  function switchExport(kind) {
    currentExport = kind;
    const isPrint = kind === 'print';
    pagePicker.hidden = isPrint;
    printNote.hidden = !isPrint;
    // 打印出口下「导出」按钮改成「打印」；选页出口下提示当前选了多少页。
    runButton.textContent = isPrint ? '打开打印…' : `导出${selected.size === pageCount ? `全部 ${pageCount}` : `选中 ${selected.size}`} 页`;
    runButton.disabled = !isPrint && selected.size === 0;
    updateActions();
  }

  function updateActions() {
    if (currentExport === 'print') return;
    runButton.textContent = selected.size === pageCount
      ? `导出全部 ${pageCount} 页`
      : `导出选中 ${selected.size} 页`;
    runButton.disabled = selected.size === 0;
  }

  /* ---------------- 执行 ---------------- */

  let handle;
  const runButton = button('导出全部页', {
    variant: 'primary',
    onClick: () => runExport(currentExport),
  });

  async function runExport(kind) {
    if (kind === 'print') {
      handle.close(null);
      ctx.print();
      return;
    }

    if (selected.size === 0) {
      toast('一页都没选中。', { type: 'warn' });
      return;
    }

    const base = safeBaseName(song);
    const chosen = pages.filter((page) => selected.has(page.index));

    if (kind === 'png') {
      let done = 0;
      const failures = [];
      for (const page of chosen) {
        try {
          const blob = await canvasToBlob(page.canvas, 'image/png');
          const suffix = pageCount > 1 ? `-p${page.index + 1}` : '';
          downloadBlob(`${base}${suffix}.png`, blob);
          done += 1;
        } catch (error) {
          failures.push(`第 ${page.index + 1} 页：${error?.message ?? error}`);
        }
      }
      handle.close(null);
      if (failures.length === 0) {
        toast(`已导出 ${done} 张 PNG。`, { type: 'success' });
      } else {
        toast(`导出了 ${done} 张，有 ${failures.length} 张失败。`, {
          type: 'error',
          detail: failures.join('\n'),
          duration: 0,
        });
      }
      return;
    }

    if (kind === 'pdf') {
      try {
        // 每页先转成 JPEG（PDF 内嵌 JPEG，见 core/pdf.js 头注）。
        const jpegPages = [];
        for (const page of chosen) {
          const blob = await canvasToBlob(page.canvas, 'image/jpeg', 0.93);
          jpegPages.push({
            jpeg: new Uint8Array(await blob.arrayBuffer()),
            width: PAGE.width,
            height: PAGE.height,
          });
        }
        const pdfBytes = buildPdf(jpegPages);
        downloadBlob(`${base}.pdf`, new Blob([pdfBytes], { type: 'application/pdf' }));
        handle.close(null);
        toast(`已导出 PDF，共 ${jpegPages.length} 页。`, { type: 'success' });
      } catch (error) {
        toast(`生成 PDF 失败：${error?.message ?? error}`, { type: 'error', duration: 0 });
      }
      return;
    }
  }

  handle = openSheet({
    title: '导出与打印',
    subtitle: `共 ${pageCount} 页`,
    body: el('div', {}, [
      el('div', { class: 'export-choice-list', role: 'radiogroup', 'aria-label': '选择导出方式' }, exportChoices),
      printNote,
      pagePicker,
    ]),
    actions: [button('取消', { onClick: () => handle.close(null) }), runButton],
  });

  // 初始态：PDF 出口，页选择可见，打印说明隐藏。
  switchExport('pdf');
}
