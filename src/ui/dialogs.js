/**
 * 提示、确认、输入与底部编辑面板（sheet）。
 *
 * 这一层只做「弹出点东西、拿回一个结果」，不碰歌曲数据。所有 Promise 化的对话框
 * 都在用户取消时返回 `null` / `false`，调用方必须处理这两种结果——
 * 不处理就会变成「点了取消却把空值写进歌里」。
 *
 * 三件必须做对的事：
 *
 * 1. **Esc 与点遮罩都能关**（§9 不依赖鼠标悬停、焦点状态清楚）。
 * 2. **焦点圈定**：打开时把焦点移进对话框，Tab 只在框内循环，关闭后还给原来的元素。
 *    手机上键盘用户不会被「Tab 跑到背后看不见的按钮上」困住。
 * 3. **操作按钮固定在底部**，不随内容滚走——软键盘弹起时提交按钮仍然够得着。
 *
 * @module ui/dialogs
 */

import { appendChildren, button, el } from './dom.js';

const OVERLAY_ID = 'ui-overlay-root';
const TOAST_ID = 'ui-toast-root';

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(', ');

function overlayRoot() {
  let root = document.getElementById(OVERLAY_ID);
  if (!root) {
    root = el('div', { id: OVERLAY_ID, class: 'overlay-root' });
    document.body.append(root);
  }
  return root;
}

function toastRoot() {
  let root = document.getElementById(TOAST_ID);
  if (!root) {
    root = el('div', { id: TOAST_ID, class: 'toast-root', role: 'status', 'aria-live': 'polite' });
    document.body.append(root);
  }
  return root;
}

/* ------------------------------------------------------------------ *
 * 提示条
 * ------------------------------------------------------------------ */

/**
 * 弹一条提示。
 *
 * 错误提示默认**不自动消失**：用户得有机会读完它，尤其是「保存失败」这种
 * 需要立刻处理的。成功 / 信息类 4 秒后自己走。
 *
 * @param {string} message
 * @param {{type?: 'info'|'success'|'error'|'warn', detail?: string|null,
 *   duration?: number, action?: {label: string, onClick: Function}}} [options]
 * @returns {() => void} 手动关闭
 */
export function toast(message, options = {}) {
  const type = options.type ?? 'info';
  const duration = options.duration ?? (type === 'error' ? 0 : 4000);

  let timer = null;
  const node = el('div', { class: `toast toast--${type}`, role: type === 'error' ? 'alert' : null }, [
    el('div', { class: 'toast__body' }, [
      el('p', { class: 'toast__message', text: message }),
      options.detail ? el('pre', { class: 'toast__detail', text: options.detail }) : null,
    ]),
    el('div', { class: 'toast__actions' }, [
      options.action
        ? button(options.action.label, {
            class: 'btn--small',
            onClick: () => {
              dismiss();
              options.action.onClick();
            },
          })
        : null,
      button('关闭', { class: 'btn--small btn--quiet', ariaLabel: '关闭提示', onClick: () => dismiss() }),
    ]),
  ]);

  function dismiss() {
    if (timer) clearTimeout(timer);
    timer = null;
    node.remove();
  }

  toastRoot().append(node);
  if (duration > 0) timer = setTimeout(dismiss, duration);
  return dismiss;
}

/* ------------------------------------------------------------------ *
 * 对话框骨架
 * ------------------------------------------------------------------ */

/**
 * 打开一个模态对话框。
 *
 * @param {{title: string, subtitle?: string|null, body: Node, actions?: Node[],
 *   variant?: 'sheet'|'dialog', onClose?: Function}} config
 * @returns {{element: HTMLElement, close: (value?: unknown) => void}}
 */
function openModal(config) {
  const variant = config.variant ?? 'sheet';
  let closed = false;
  const previouslyFocused = document.activeElement;

  const bodyNode = el('div', { class: 'modal__body' }, [config.body]);
  const actionsNode = config.actions?.length
    ? el('div', { class: 'modal__actions' }, config.actions)
    : null;

  const panel = el(
    'div',
    {
      class: `modal modal--${variant}`,
      role: 'dialog',
      'aria-modal': 'true',
      'aria-label': config.title,
    },
    [
      el('div', { class: 'modal__head' }, [
        el('div', { class: 'modal__headings' }, [
          el('h2', { class: 'modal__title', text: config.title }),
          config.subtitle ? el('p', { class: 'modal__subtitle', text: config.subtitle }) : null,
        ]),
        button('✕', { class: 'btn--icon btn--quiet', ariaLabel: '关闭', onClick: () => handle.close(null) }),
      ]),
      bodyNode,
      actionsNode,
    ],
  );

  const backdrop = el('div', { class: 'modal-backdrop' }, [panel]);

  function onBackdropClick(event) {
    if (event.target === backdrop) handle.close(null);
  }

  function onKeydown(event) {
    if (event.key === 'Escape') {
      event.preventDefault();
      handle.close(null);
      return;
    }
    if (event.key !== 'Tab') return;

    // 焦点圈定：Tab 在对话框内循环，不会跑到背后页面上。
    const focusable = [...panel.querySelectorAll(FOCUSABLE_SELECTOR)].filter(
      (node) => node.offsetParent !== null || node === document.activeElement,
    );
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  const handle = {
    element: panel,
    close(value = null) {
      if (closed) return;
      closed = true;
      backdrop.removeEventListener('click', onBackdropClick);
      document.removeEventListener('keydown', onKeydown);
      backdrop.remove();
      if (config.onClose) config.onClose(value);
      if (previouslyFocused && typeof previouslyFocused.focus === 'function') previouslyFocused.focus();
    },
  };

  backdrop.addEventListener('click', onBackdropClick);
  document.addEventListener('keydown', onKeydown);
  overlayRoot().append(backdrop);

  // 焦点落到第一个能用的控件上。刻意跳过「✕」——否则回车会直接关掉对话框。
  const firstFocusable = [...panel.querySelectorAll(FOCUSABLE_SELECTOR)].find(
    (node) => !node.classList.contains('btn--icon'),
  );
  (firstFocusable ?? panel).focus?.();

  return handle;
}

/* ------------------------------------------------------------------ *
 * 底部编辑面板（sheet）
 * ------------------------------------------------------------------ */

/**
 * 打开底部编辑面板（桌面上居中显示成对话框，由 CSS 决定）。
 *
 * 页面上的点按操作（点和弦、点小节、点段落）都走这里，好处是视口之间只有一套
 * 编辑路径，不会出现「桌面能改、手机改不了」或两套逻辑慢慢漂移的问题。
 *
 * @param {{title: string, subtitle?: string|null, body: Node, actions?: Node[],
 *   variant?: 'sheet'|'dialog', onClose?: Function}} config
 * @returns {{element: HTMLElement, close: Function, setSubtitle: (text: string) => void}}
 */
export function openSheet(config) {
  return openModal(config);
}

/* ------------------------------------------------------------------ *
 * 确认
 * ------------------------------------------------------------------ */

/**
 * 确认框。
 *
 * @param {{title: string, message: string, detail?: string|null,
 *   confirmText?: string, cancelText?: string, danger?: boolean}} config
 * @returns {Promise<boolean>}
 */
export function confirmDialog(config) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    const modal = openModal({
      title: config.title,
      variant: 'dialog',
      body: el('div', {}, [
        el('p', { class: 'modal__message', text: config.message }),
        config.detail ? el('pre', { class: 'modal__detail', text: config.detail }) : null,
      ]),
      actions: [
        button(config.cancelText ?? '取消', { onClick: () => modal.close(false) }),
        button(config.confirmText ?? '确定', {
          variant: config.danger ? 'danger' : 'primary',
          onClick: () => modal.close(true),
        }),
      ],
      onClose: (value) => finish(value === true),
    });
  });
}

/* ------------------------------------------------------------------ *
 * 文本输入
 * ------------------------------------------------------------------ */

/**
 * 要一段文本（重命名段落、改演奏提示、新歌标题都走它）。
 *
 * @param {{title: string, label: string, value?: string, maxLength?: number,
 *   required?: boolean, hint?: string|null, placeholder?: string,
 *   confirmText?: string, multiline?: boolean, rows?: number}} config
 * @returns {Promise<string|null>} 取消时返回 null
 */
export function askText(config) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    const errorNode = el('p', { class: 'field__error', role: 'alert' });

    const control = config.multiline
      ? el('textarea', {
          class: 'input input--textarea',
          rows: String(config.rows ?? 3),
          maxlength: config.maxLength ? String(config.maxLength) : null,
          placeholder: config.placeholder ?? null,
          'aria-label': config.label,
          dataset: { focusKey: 'ask-text' },
        })
      : el('input', {
          class: 'input',
          type: 'text',
          value: config.value ?? '',
          maxlength: config.maxLength ? String(config.maxLength) : null,
          placeholder: config.placeholder ?? null,
          'aria-label': config.label,
          dataset: { focusKey: 'ask-text' },
        });
    if (config.multiline) control.value = config.value ?? '';

    function readValue() {
      return control.value;
    }

    function submit() {
      const value = readValue();
      if (config.required && value.trim() === '') {
        errorNode.textContent = `${config.label}不能为空`;
        control.focus();
        return;
      }
      if (config.maxLength && value.length > config.maxLength) {
        errorNode.textContent = `${config.label}最多 ${config.maxLength} 个字符（当前 ${value.length}）`;
        control.focus();
        return;
      }
      finish(value);
      modal.close(value);
    }

    control.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !config.multiline) {
        event.preventDefault();
        submit();
      }
    });

    const modal = openModal({
      title: config.title,
      variant: 'dialog',
      body: el('div', { class: 'field' }, [
        el('label', { class: 'field__label', text: config.label }),
        control,
        config.hint ? el('p', { class: 'field__hint', text: config.hint }) : null,
        el('p', { class: 'field__hint' }, [
          el('span', {
            text: config.maxLength ? `0 / ${config.maxLength}` : '',
          }),
        ]),
        errorNode,
      ]),
      actions: [
        button('取消', { onClick: () => modal.close(null) }),
        button(config.confirmText ?? '确定', { variant: 'primary', onClick: submit }),
      ],
      onClose: (value) => finish(typeof value === 'string' ? value : null),
    });

    // 字数实时提示：让用户在超限之前就看到还剩多少。
    const counter = modal.element.querySelector('.field__hint span');
    if (counter && config.maxLength) {
      const update = () => {
        const length = readValue().length;
        counter.textContent = `${length} / ${config.maxLength}`;
        counter.classList.toggle('is-over', length > config.maxLength);
      };
      control.addEventListener('input', update);
      update();
    } else if (counter) {
      counter.parentElement.remove();
    }

    control.focus();
    if (typeof control.setSelectionRange === 'function') {
      const length = readValue().length;
      control.setSelectionRange(length, length);
    }
  });
}

/* ------------------------------------------------------------------ *
 * 选择
 * ------------------------------------------------------------------ */

/**
 * 让用户从若干选项里挑一个（每项可以带一行说明）。
 *
 * @param {{title: string, message?: string, options: Array<{value: string, label: string,
 *   description?: string}>, cancelText?: string}} config
 * @returns {Promise<string|null>}
 */
export function askChoice(config) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    const modal = openModal({
      title: config.title,
      variant: 'dialog',
      body: el('div', { class: 'choice-list' }, [
        config.message ? el('p', { class: 'modal__message', text: config.message }) : null,
        ...config.options.map((option) =>
          button(option.label, {
            class: 'choice',
            variant: 'quiet',
            onClick: () => modal.close(option.value),
          }),
        ),
      ]),
      actions: [button(config.cancelText ?? '取消', { onClick: () => modal.close(null) })],
      onClose: (value) => finish(typeof value === 'string' ? value : null),
    });

    // 选项说明是次要文字，单独挂上去（按钮的 text 只能放一行）。
    const buttons = modal.element.querySelectorAll('.choice');
    config.options.forEach((option, index) => {
      if (!option.description || !buttons[index]) return;
      buttons[index].append(el('span', { class: 'choice__desc', text: option.description }));
    });
  });
}

/* ------------------------------------------------------------------ *
 * 危险操作确认（带「必须输入才能继续」的那一种）
 * ------------------------------------------------------------------ */

/**
 * 危险操作的最后一道闸。要求用户输入指定的词才能继续，
 * 用在「清空本地数据」这种不可撤销的操作上。
 *
 * @param {{title: string, message: string, detail?: string|null, keyword: string,
 *   confirmText?: string}} config
 * @returns {Promise<boolean>}
 */
export function confirmByTyping(config) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    const errorNode = el('p', { class: 'field__error', role: 'alert' });
    const control = el('input', {
      class: 'input',
      type: 'text',
      'aria-label': '确认词',
      placeholder: config.keyword,
      dataset: { focusKey: 'confirm-typing' },
    });
    control.addEventListener('input', () => {
      errorNode.textContent = '';
    });

    const modal = openModal({
      title: config.title,
      variant: 'dialog',
      body: el('div', {}, [
        el('p', { class: 'modal__message', text: config.message }),
        config.detail ? el('pre', { class: 'modal__detail', text: config.detail }) : null,
        el('div', { class: 'field' }, [
          el('label', { class: 'field__label', text: `请原样输入「${config.keyword}」以确认` }),
          control,
          errorNode,
        ]),
      ]),
      actions: [
        button('取消', { onClick: () => modal.close(false) }),
        button(config.confirmText ?? '确认执行', {
          variant: 'danger',
          onClick: () => {
            if (control.value.trim() !== config.keyword) {
              errorNode.textContent = '输入的内容与确认词不一致，没有执行任何操作。';
              control.focus();
              return;
            }
            modal.close(true);
          },
        }),
      ],
      onClose: (value) => finish(value === true),
    });

    control.focus();
  });
}

/**
 * 生成一个 Promise 化的「文件选择」。
 *
 * @param {{accept: string, multiple?: boolean}} config
 * @returns {Promise<File[]>} 用户取消时返回空数组
 */
export function pickFiles(config) {
  return new Promise((resolve) => {
    const node = el('input', {
      type: 'file',
      accept: config.accept,
      multiple: config.multiple === true,
      class: 'visually-hidden',
    });

    let settled = false;
    const finish = (files) => {
      if (settled) return;
      settled = true;
      node.remove();
      resolve(files);
    };

    node.addEventListener('change', () => finish([...(node.files ?? [])]));
    // 用户点「取消」不会触发 change，只留下一个孤零零的 input；
    // 这里靠窗口重新获得焦点后延时兜底清理，避免堆一堆隐藏节点。
    window.addEventListener(
      'focus',
      () => setTimeout(() => finish([]), 1500),
      { once: true },
    );

    document.body.append(node);
    node.click();
  });
}

export { appendChildren };
