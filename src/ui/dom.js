/**
 * 极小的 DOM 构造工具。
 *
 * ## 一条硬规矩：用户内容永远走 textContent
 *
 * 这个模块**故意不提供任何写 innerHTML 的入口**。工程文件、歌曲标题、段落名、
 * 和弦符号全都有可能来自外部（导入的 JSON），拼接 HTML 字符串等于给自己开一个
 * 注入口子（docs/SPEC.md §6.4、§7.4 第 8 条）。所以这里只有 `textContent` 一条路，
 * `html` 这个 key 被显式拦下并抛错——写错了会立刻炸，不会安静地留下漏洞。
 *
 * @module ui/dom
 */

/**
 * 创建元素。
 *
 * @param {string} tag
 * @param {Record<string, unknown>} [props]
 *   - `class`：className
 *   - `text`：textContent（**唯一的文本写入方式**）
 *   - `dataset`：展开成 data-*
 *   - `on*`：事件监听（例如 `onClick`）
 *   - `html`：**被禁止**，传入会抛错
 *   - 其余：setAttribute；值为 `true` 时写成空属性，`false`/`null`/`undefined` 跳过
 * @param {Array<Node|string|null|undefined|false>} [children] 字符串会变成文本节点；
 *   `null` / `undefined` / `false` 表示「这个条件不成立」，显式跳过
 *   （`append(null)` 会插进一个字面量 "null"，这个坑踩过一次）。
 * @returns {HTMLElement}
 */
export function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);

  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;

    if (key === 'html' || key === 'innerHTML' || key === 'outerHTML') {
      throw new Error('ui/dom: 禁止拼接 HTML，请用 text 走 textContent（SPEC §6.4）');
    }
    if (key === 'class') {
      node.className = String(value);
    } else if (key === 'text') {
      node.textContent = String(value);
    } else if (key === 'dataset') {
      for (const [dataKey, dataValue] of Object.entries(value)) {
        if (dataValue === undefined || dataValue === null) continue;
        node.dataset[dataKey] = String(dataValue);
      }
    } else if (key === 'style') {
      node.setAttribute('style', String(value));
    } else if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (value === true) {
      node.setAttribute(key, '');
    } else {
      node.setAttribute(key, String(value));
    }
  }

  // Range controls sanitize as min/max/step are assigned. Restore the requested
  // value after those attributes so opening settings cannot display a false minimum.
  if(tag==='input' && props.value!==undefined && props.value!==null)node.value=String(props.value);

  appendChildren(node, children);
  return node;
}

/** 把一批子节点挂到父节点上，按上面的规则跳过空值。 */
export function appendChildren(parent, children) {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    parent.append(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return parent;
}

/** 生成一个文档片段，便于批量塞入。 */
export function frag(children = []) {
  const fragment = document.createDocumentFragment();
  appendChildren(fragment, children);
  return fragment;
}

/** 清空一个节点（replaceChildren 的原生实现，语义更直白）。 */
export function clear(node) {
  node.replaceChildren();
  return node;
}

/**
 * 替换子节点，顺手跳过空值。
 *
 * **不要**直接写 `node.replaceChildren(a, maybeNull)`。
 * 原生的 `replaceChildren` 不像 `appendChild` 那样拒绝非节点参数——
 * 它会老老实实把 `null` 字符串化成一个 Text 节点，于是页面上
 * 就真的印出一个「null」。这个坑很安静：不报错、不抛异常，
 * 而且如果检查的是子元素的 `textContent`，还查不到它（那是兄弟节点）。
 *
 * @param {Node} parent
 * @param {...(Node|string|null|undefined|false)} children
 * @returns {Node}
 */
export function replaceChildren(parent, ...children) {
  parent.replaceChildren(
    ...children.filter((child) => child !== null && child !== undefined && child !== false),
  );
  return parent;
}

/* ------------------------------------------------------------------ *
 * 常用控件
 * ------------------------------------------------------------------ */

/**
 * 一个按钮。
 *
 * 所有按钮的默认最小尺寸由 CSS 保证（≥ 44px，docs/SPEC.md §9），
 * 这里只负责语义和事件。
 *
 * @param {string} label 按钮文字
 * @param {{onClick?: (event: Event) => void, class?: string, title?: string,
 *   disabled?: boolean, variant?: 'primary'|'danger'|'ghost'|'quiet',
 *   data?: Record<string, string|number>, type?: string, ariaLabel?: string}} [options]
 * @returns {HTMLButtonElement}
 */
export function button(label, options = {}) {
  const classes = ['btn'];
  if (options.variant) classes.push(`btn--${options.variant}`);
  if (options.class) classes.push(options.class);

  return el('button', {
    type: options.type ?? 'button',
    class: classes.join(' '),
    text: label,
    title: options.title ?? null,
    disabled: options.disabled === true,
    'aria-label': options.ariaLabel ?? null,
    dataset: options.data ?? null,
    onClick: options.onClick ?? null,
  });
}

/** 一行小标签，用于计数、状态这类次要信息。 */
export function badge(text, className = '') {
  return el('span', { class: `badge ${className}`.trim(), text });
}

/**
 * 带标签的表单字段。返回整块（label + 控件 + 提示 / 错误位）。
 *
 * @param {{label: string, control: HTMLElement, hint?: string, id?: string}} options
 * @returns {HTMLElement}
 */
export function field(options) {
  const { label, control, hint, id } = options;
  const labelNode = el('label', { class: 'field__label', for: id ?? null, text: label });
  return el('div', { class: 'field' }, [
    labelNode,
    control,
    hint ? el('p', { class: 'field__hint', text: hint }) : null,
  ]);
}

/**
 * 一个下拉选择框。
 *
 * @param {{value: string|number, options: Array<{value: string|number, label: string,
 *   disabled?: boolean}>, onChange?: (value: string) => void, id?: string,
 *   ariaLabel?: string, disabled?: boolean}} config
 * @returns {HTMLSelectElement}
 */
export function select(config) {
  const node = el('select', {
    class: 'input input--select',
    id: config.id ?? null,
    'aria-label': config.ariaLabel ?? null,
    disabled: config.disabled === true,
    onChange: config.onChange ? (event) => config.onChange(event.target.value) : null,
  });
  for (const option of config.options) {
    node.append(
      el('option', {
        value: String(option.value),
        text: option.label,
        selected: String(option.value) === String(config.value),
        disabled: option.disabled === true,
      }),
    );
  }
  return node;
}

/**
 * 输入框。
 *
 * @param {{value: string|number, type?: string, id?: string, onInput?: Function,
 *   onChange?: Function, placeholder?: string, min?: number, max?: number, step?: number,
 *   maxLength?: number, ariaLabel?: string, disabled?: boolean, inputMode?: string,
 *   focusKey?: string}} config
 * @returns {HTMLInputElement}
 */
export function input(config) {
  return el('input', {
    class: 'input',
    type: config.type ?? 'text',
    id: config.id ?? null,
    value: config.value ?? '',
    placeholder: config.placeholder ?? null,
    min: config.min ?? null,
    max: config.max ?? null,
    step: config.step ?? null,
    maxlength: config.maxLength ?? null,
    'aria-label': config.ariaLabel ?? null,
    inputmode: config.inputMode ?? null,
    disabled: config.disabled === true,
    dataset: config.focusKey ? { focusKey: config.focusKey } : null,
    onInput: config.onInput ?? null,
    onChange: config.onChange ?? null,
  });
}

/* ------------------------------------------------------------------ *
 * 焦点保持
 *
 * 面板采用「整块重建」的方式渲染，这样不用担心状态不同步；代价是重建会把
 * 正在输入的输入框换掉。下面两个函数负责在重建前后把焦点和光标位置搬回去。
 * ------------------------------------------------------------------ */

/**
 * 记录当前焦点位置。只认带 `data-focus-key` 的元素——没打标记的元素（按钮等）
 * 不值得恢复焦点，恢复了反而会让用户觉得「点了别处却还被拽回去」。
 *
 * @param {HTMLElement} root
 * @returns {{key: string, start: ?number, end: ?number}|null}
 */
export function captureFocus(root) {
  const active = document.activeElement;
  if (!active || !root.contains(active)) return null;
  const key = active.dataset?.focusKey;
  if (!key) return null;

  let start = null;
  let end = null;
  try {
    start = active.selectionStart ?? null;
    end = active.selectionEnd ?? null;
  } catch {
    // number / select 之类没有 selectionStart，忽略即可。
  }
  return { key, start, end };
}

/**
 * 恢复焦点。
 *
 * @param {HTMLElement} root
 * @param {{key: string, start: ?number, end: ?number}|null} snapshot
 */
export function restoreFocus(root, snapshot) {
  if (!snapshot) return;
  const escaped = typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(snapshot.key) : snapshot.key;
  const node = root.querySelector(`[data-focus-key="${escaped}"]`);
  if (!node || typeof node.focus !== 'function') return;
  node.focus();
  if (snapshot.start !== null && typeof node.setSelectionRange === 'function') {
    try {
      node.setSelectionRange(snapshot.start, snapshot.end ?? snapshot.start);
    } catch {
      // 类型不支持光标位置时忽略。
    }
  }
}

/* ------------------------------------------------------------------ *
 * 小工具
 * ------------------------------------------------------------------ */

/** 截断过长的文本用于列表显示（不改数据，纯粹是显示层的省略）。 */
export function truncate(text, maxLength = 60) {
  const value = String(text ?? '');
  return value.length > maxLength ? `${value.slice(0, maxLength)}…` : value;
}

/**
 * 会记住「展开还是收起」的 `<details>`。
 *
 * 侧栏是整块重建的，如果不管这件事，用户展开「查看歌曲 JSON」之后
 * 随便改一个和弦，面板就自己收起来了——小事，但每次都要重新点一遍很烦人。
 * 用 summary 文字当键记住状态，重建时还原。
 *
 * @param {string} summaryText
 * @param {Node} content
 * @returns {HTMLElement}
 */
const openDetailsKeys = new Set();

export function details(summaryText, content, { className = '' } = {}) {
  const key = summaryText;
  const node = el('details', { class: `details ${className}`.trim(), open: openDetailsKeys.has(key) }, [
    el('summary', { class: 'details__summary', text: summaryText }),
    content,
  ]);
  node.addEventListener('toggle', () => {
    if (node.open) openDetailsKeys.add(key);
    else openDetailsKeys.delete(key);
  });
  return node;
}

/** 把 ISO 时间格式化成「今天 14:05 / 昨天 09:30 / 2026-09-20」。 */
export function formatRelativeTime(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '未知时间';

  const pad = (value) => String(value).padStart(2, '0');
  const clock = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  const now = new Date();

  if (date.toDateString() === now.toDateString()) return `今天 ${clock}`;

  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) return `昨天 ${clock}`;

  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** 数字 → 「1 拍」「1.5 拍」「0.25 拍」，避免浮点尾巴。 */
export function formatBeatsLabel(beats) {
  const rounded = Math.round(Number(beats) * 16) / 16;
  return `${Number.isInteger(rounded) ? rounded : rounded.toFixed(2).replace(/0$/, '')} 拍`;
}

/* ------------------------------------------------------------------ *
 * 文件下载
 * ------------------------------------------------------------------ */

/**
 * 触发一次浏览器下载。
 *
 * 用 `URL.createObjectURL` + 一个临时 `<a download>`，不依赖任何第三方库，
 * 也不需要服务器。用完立刻回收 object URL，否则这一页开着就会一直占着那份内存。
 *
 * @param {string} filename
 * @param {Blob} blob
 */
export function downloadBlob(filename, blob) {
  const url = URL.createObjectURL(blob);
  const link = el('a', { href: url, download: filename, class: 'visually-hidden' });
  document.body.append(link);
  link.click();
  link.remove();
  // 立刻 revoke 会让部分浏览器来不及取数据，延后一拍再回收。
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** 下载一段文本。 */
export function downloadText(filename, text, mime = 'application/json') {
  downloadBlob(filename, new Blob([text], { type: `${mime};charset=utf-8` }));
}
