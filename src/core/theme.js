/**
 * 主题与字体 —— 全局外观偏好（SPEC §9.2）。
 *
 * 主题是整个应用的外观，不是某首歌的音乐事实，所以它**不进 `song.layout`、
 * 不进工程文件、不跟歌走**，而是存在一份独立的全局偏好里（localStorage 单独键，
 * 与曲库隔离）。
 *
 * 本模块是纯函数 + 纯数据：不碰 DOM、不抛异常。色表是**唯一的颜色真相**，
 * CSS 变量和 Canvas 的 COLORS 都从这里派生 —— 渲染代码里不允许再写死十六进制值。
 */

/* ------------------------------------------------------------------ *
 * 配色方案
 * ------------------------------------------------------------------ */

/**
 * 三套配色方案。键名与 `styles.css` 的 CSS 变量一一对应（`paperAlt` ↔ `--paper-alt`，
 * `accentInk` ↔ `--accent-ink`，以此类推）。每个键都是 CSS 十六进制颜色。
 *
 * @type {Readonly<Record<string, Readonly<Record<string, string>>>>}
 */
export const THEMES = Object.freeze({
  /** 护眼绿（默认）：米白工作区 + 低饱和绿强调，引入主题之前的观感。 */
  green: Object.freeze({
    bg: '#f5f4f0',
    paper: '#ffffff',
    paperAlt: '#faf9f6',
    ink: '#2f3336',
    inkSoft: '#6b7280',
    line: '#e0ded7',
    lineStrong: '#c9c6bd',
    accent: '#4a7c59',
    accentInk: '#3c6647',
    accentSoft: '#eef3ee',
    danger: '#a4553f',
    dangerSoft: '#fbeeea',
    warn: '#8a6d2f',
    warnSoft: '#fdf6e3',
    warnLine: '#e8d9a8',
  }),
  /** 纸黄：更像真正的排练纸，长时间阅读时对比更柔和。 */
  paper: Object.freeze({
    bg: '#f3eee4',
    paper: '#fffdf7',
    paperAlt: '#f7f0e2',
    ink: '#3a3832',
    inkSoft: '#7b7568',
    line: '#e6ddcc',
    lineStrong: '#cdbfaa',
    accent: '#9a7045',
    accentInk: '#765330',
    accentSoft: '#f3e9d9',
    danger: '#a65b45',
    dangerSoft: '#faece6',
    warn: '#896c32',
    warnSoft: '#fbf2dc',
    warnLine: '#e8d6a7',
  }),
  /** 白蓝：适合偏冷的室内灯光和舞台后台。 */
  blue: Object.freeze({
    bg: '#f2f6f8',
    paper: '#ffffff',
    paperAlt: '#f5f8fa',
    ink: '#28343a',
    inkSoft: '#6b7a83',
    line: '#dce6eb',
    lineStrong: '#bdcfd8',
    accent: '#41758a',
    accentInk: '#315e70',
    accentSoft: '#e8f1f4',
    danger: '#a4554f',
    dangerSoft: '#f9eceb',
    warn: '#8a6c35',
    warnSoft: '#fbf3df',
    warnLine: '#ead9aa',
  }),
  /** 黑白：白底黑字，无彩色，最常规的打印观感。 */
  mono: Object.freeze({
    bg: '#ffffff',
    paper: '#ffffff',
    paperAlt: '#f7f7f7',
    ink: '#111111',
    inkSoft: '#555555',
    line: '#d0d0d0',
    lineStrong: '#999999',
    accent: '#111111',
    accentInk: '#000000',
    accentSoft: '#f0f0f0',
    danger: '#8a1f1f',
    dangerSoft: '#f5ecec',
    warn: '#5c5c5c',
    warnSoft: '#f2f2f2',
    warnLine: '#c9c9c9',
  }),
  /** 纯白：全白背景、极简对比，接近「白纸」。 */
  pure: Object.freeze({
    bg: '#ffffff',
    paper: '#ffffff',
    paperAlt: '#ffffff',
    ink: '#1a1a1a',
    inkSoft: '#777777',
    line: '#e8e8e8',
    lineStrong: '#bbbbbb',
    accent: '#4a4a4a',
    accentInk: '#333333',
    accentSoft: '#fafafa',
    danger: '#9a3b3b',
    dangerSoft: '#fbf5f5',
    warn: '#7a6a3b',
    warnSoft: '#fbfaf5',
    warnLine: '#e6e0c8',
  }),
});

export const THEME_IDS = Object.freeze(Object.keys(THEMES));
export const DEFAULT_THEME = 'green';

/** 每套方案必须覆盖的键（用来在测试里保证三套色表都齐全，不缺某套缺某个键）。 */
export const THEME_COLOR_KEYS = Object.freeze(Object.keys(THEMES.green));

/* ------------------------------------------------------------------ *
 * 字体
 * ------------------------------------------------------------------ */

/**
 * 三档字体。`stack` 是 CSS `font-family` 值，全部走系统字体、不引外部文件（SPEC §9.2，
 * 避免导出缺字）。
 *
 * @type {Readonly<Record<string, Readonly<{label: string, stack: string}>>>}
 */
export const FONT_STYLES = Object.freeze({
  sans: Object.freeze({
    label: '无衬线',
    stack: "system-ui, -apple-system, 'Segoe UI', 'Microsoft YaHei', 'PingFang SC', sans-serif",
  }),
  serif: Object.freeze({
    label: '衬线',
    stack: "'Songti SC', 'STSong', 'SimSun', 'Noto Serif CJK SC', Georgia, 'Times New Roman', serif",
  }),
  mono: Object.freeze({
    label: '等宽',
    stack: "ui-monospace, 'Cascadia Mono', 'SF Mono', Consolas, 'Microsoft YaHei', monospace",
  }),
});

export const FONT_IDS = Object.freeze(Object.keys(FONT_STYLES));
export const DEFAULT_FONT = 'sans';

/* ------------------------------------------------------------------ *
 * 读容错 / 写严格
 * ------------------------------------------------------------------ */

/**
 * 读容错：认不出的主题 id 退化成缺省，不报错。
 * @param {unknown} input
 * @returns {string} 合法主题 id，认不出则返回 `DEFAULT_THEME`
 */
export function normalizeTheme(input) {
  return THEMES[input] ? String(input) : DEFAULT_THEME;
}

/**
 * 读容错：认不出的字体 id 退化成缺省。
 * @param {unknown} input
 * @returns {string}
 */
export function normalizeFont(input) {
  return FONT_STYLES[input] ? String(input) : DEFAULT_FONT;
}

/** 写严格：只认表里的主题 id。 */
export function isThemeValid(input) {
  return typeof input === 'string' && Object.hasOwn(THEMES, input);
}

/** 写严格：只认表里的字体 id。 */
export function isFontValid(input) {
  return typeof input === 'string' && Object.hasOwn(FONT_STYLES, input);
}

/* ------------------------------------------------------------------ *
 * 色表 / 字体栈取值
 * ------------------------------------------------------------------ */

/**
 * 取某套主题的完整色表（CSS 变量键名 → 十六进制值）。
 * @param {unknown} theme
 * @returns {Readonly<Record<string, string>>}
 */
export function getThemeColors(theme) {
  return THEMES[normalizeTheme(theme)];
}

/**
 * 取某档字体的 `font-family` 栈。
 * @param {unknown} font
 * @returns {string}
 */
export function getFontStack(font) {
  return FONT_STYLES[normalizeFont(font)].stack;
}

/* ------------------------------------------------------------------ *
 * 全局偏好读写（localStorage 单独键，与曲库隔离）
 * ------------------------------------------------------------------ */

/** localStorage 键名，与 SPEC §9.2 一致。 */
export const PREFS_STORAGE_KEY = 'chord-chart-workbench/v1/prefs';

/**
 * 一份完整、规整过的偏好。缺省值等于引入主题之前的观感。
 * @typedef {{theme: string, font: string}} Prefs
 */

/**
 * 从原始值规整出一份偏好（读容错：缺失或认不出的字段退回缺省）。
 * @param {unknown} raw 可能是 null / undefined / 半个对象
 * @returns {Prefs}
 */
export function normalizePrefs(raw) {
  const obj = raw && typeof raw === 'object' ? raw : {};
  return {
    theme: normalizeTheme(obj.theme),
    font: normalizeFont(obj.font),
  };
}

/** 缺省偏好。 */
export function defaultPrefs() {
  return { theme: DEFAULT_THEME, font: DEFAULT_FONT };
}

/**
 * 从 storage 读偏好。读不到 / 解析失败 / 形状不对都退回缺省，不抛异常。
 * @param {{getItem: Function}|null} [storage] 省略时用浏览器 localStorage
 * @returns {Prefs}
 */
export function loadPrefs(storage) {
  const s = storage ?? getDefaultStorage();
  if (!s) return defaultPrefs();
  try {
    const raw = s.getItem(PREFS_STORAGE_KEY);
    if (raw == null) return defaultPrefs();
    return normalizePrefs(JSON.parse(raw));
  } catch {
    return defaultPrefs();
  }
}

/**
 * 把偏好写进 storage。返回是否成功（失败不抛，交给调用方提示）。
 * @param {Prefs} prefs
 * @param {{setItem: Function}|null} [storage]
 * @returns {boolean}
 */
export function savePrefs(prefs, storage) {
  const s = storage ?? getDefaultStorage();
  if (!s) return false;
  try {
    s.setItem(PREFS_STORAGE_KEY, JSON.stringify(normalizePrefs(prefs)));
    return true;
  } catch {
    return false;
  }
}

/**
 * 取浏览器默认的 localStorage（复用 library 的探测逻辑，避免各写一份）。
 */
function getDefaultStorage() {
  try {
    const storage = globalThis.localStorage;
    if (!storage) return null;
    const probe = '__chord_chart_prefs_probe__';
    storage.setItem(probe, '1');
    storage.removeItem(probe);
    return storage;
  } catch {
    return null;
  }
}
