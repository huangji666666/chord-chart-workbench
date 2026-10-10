/**
 * 主题与字体（src/core/theme.js）的自动测试。
 *
 * 重点：
 * 1. 三套配色都齐全（不缺键），且彼此确实不同。
 * 2. 读容错：认不出的主题 / 字体 id 退回缺省。
 * 3. 写严格：isThemeValid / isFontValid 只认表里的值。
 * 4. 偏好读写：loadPrefs / savePrefs 用独立键，与曲库隔离；坏数据退回缺省。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  THEMES,
  THEME_IDS,
  THEME_COLOR_KEYS,
  DEFAULT_THEME,
  FONT_STYLES,
  FONT_IDS,
  DEFAULT_FONT,
  normalizeTheme,
  normalizeFont,
  isThemeValid,
  isFontValid,
  getThemeColors,
  getFontStack,
  normalizePrefs,
  defaultPrefs,
  loadPrefs,
  savePrefs,
  PREFS_STORAGE_KEY,
} from '../src/core/theme.js';

/** 造一个内存版 storage，模仿 library.js 的测试约定。 */
function memStorage(seed = {}) {
  const map = new Map(Object.entries(seed));
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => {
      map.set(k, String(v));
    },
    removeItem: (k) => {
      map.delete(k);
    },
    _map: map,
  };
}

test('三套配色齐全且彼此确实不同', () => {
  assert.equal(THEME_IDS.join(','), 'green,paper,blue,mono,pure');

  for (const id of THEME_IDS) {
    const colors = THEMES[id];
    // 每套都必须覆盖同一组键 —— 缺一个键，CSS 变量或 Canvas 就会漏一个颜色。
    for (const key of THEME_COLOR_KEYS) {
      assert.ok(colors[key], `主题 ${id} 缺少颜色键 ${key}`);
    }
    // 十六进制颜色格式（3/6/8 位均可，这里约定 6 位）。
    for (const key of THEME_COLOR_KEYS) {
      assert.match(colors[key], /^#[0-9a-fA-F]{6}$/, `主题 ${id} 的 ${key} 不是合法十六进制`);
    }
  }

  // 三套的「纸张」「强调色」不能全一样 —— 否则切主题等于没切。
  const papers = new Set(THEME_IDS.map((id) => THEMES[id].paper));
  const accents = new Set(THEME_IDS.map((id) => THEMES[id].accent));
  assert.ok(papers.size >= 1, '纸张色可以一致（都是白），但强调色必须能区分主题');
  assert.ok(accents.size === THEME_IDS.length, '三套强调色应彼此不同');
});

test('默认主题是护眼绿、默认字体是无衬线', () => {
  assert.equal(DEFAULT_THEME, 'green');
  assert.equal(DEFAULT_FONT, 'sans');
  assert.equal(FONT_IDS.join(','), 'sans,serif,mono');
  assert.ok(FONT_STYLES.sans.label === '无衬线');
  assert.ok(FONT_STYLES.serif.label === '衬线');
  assert.ok(FONT_STYLES.mono.label === '等宽');
});

test('读容错：认不出的主题/字体退回缺省，不抛异常', () => {
  assert.equal(normalizeTheme('green'), 'green');
  assert.equal(normalizeTheme('mono'), 'mono');
  assert.equal(normalizeTheme('pure'), 'pure');
  assert.equal(normalizeTheme('blue'), 'blue');
  assert.equal(normalizeTheme('unknown'), 'green');
  assert.equal(normalizeTheme(undefined), 'green');
  assert.equal(normalizeTheme(null), 'green');
  assert.equal(normalizeTheme(123), 'green');

  assert.equal(normalizeFont('serif'), 'serif');
  assert.equal(normalizeFont('comic-sans'), 'sans'); // 认不出
  assert.equal(normalizeFont(undefined), 'sans');
});

test('写严格：isThemeValid / isFontValid 只认表里的值', () => {
  assert.equal(isThemeValid('green'), true);
  assert.equal(isThemeValid('pure'), true);
  assert.equal(isThemeValid('blue'), true);
  assert.equal(isThemeValid('unknown'), false);
  assert.equal(isThemeValid(undefined), false);
  assert.equal(isThemeValid('GREEN'), false); // 大小写敏感

  assert.equal(isFontValid('mono'), true);
  assert.equal(isFontValid('serif'), true);
  assert.equal(isFontValid('wingdings'), false);
  assert.equal(isFontValid(null), false);
});

test('getThemeColors / getFontStack 返回的是稳定引用', () => {
  assert.equal(getThemeColors('green'), THEMES.green);
  assert.equal(getThemeColors('bogus'), THEMES.green); // 退化
  assert.equal(getFontStack('mono'), FONT_STYLES.mono.stack);
  assert.ok(getFontStack('sans').includes('sans-serif'));
  assert.ok(getFontStack('serif').includes('serif'));
});

test('normalizePrefs 对半个对象容错', () => {
  assert.deepEqual(normalizePrefs(null), { theme: 'green', font: 'sans' });
  assert.deepEqual(normalizePrefs(undefined), { theme: 'green', font: 'sans' });
  assert.deepEqual(normalizePrefs({}), { theme: 'green', font: 'sans' });
  assert.deepEqual(normalizePrefs({ theme: 'mono' }), { theme: 'mono', font: 'sans' });
  assert.deepEqual(normalizePrefs({ theme: 'blue', font: 'mono' }), { theme: 'blue', font: 'mono' });
  assert.deepEqual(normalizePrefs({ theme: 'pure', font: 'serif' }), { theme: 'pure', font: 'serif' });
});

test('偏好读写用独立键，与曲库隔离', () => {
  const storage = memStorage();
  // 存一份曲库（用曲库键），再存偏好，两者互不干扰。
  storage.setItem('chord-chart-workbench/v1/library', '{"songs":[]}');

  assert.equal(loadPrefs(storage).theme, 'green'); // 无偏好 → 缺省
  assert.equal(savePrefs({ theme: 'mono', font: 'serif' }, storage), true);

  const loaded = loadPrefs(storage);
  assert.equal(loaded.theme, 'mono');
  assert.equal(loaded.font, 'serif');

  // 偏好键和曲库键是分开的。
  assert.notEqual(PREFS_STORAGE_KEY, 'chord-chart-workbench/v1/library');
  assert.equal(storage.getItem('chord-chart-workbench/v1/library'), '{"songs":[]}');
});

test('坏数据 / 无 storage 都退回缺省，不抛异常', () => {
  const storage = memStorage({ [PREFS_STORAGE_KEY]: '{not json' });
  assert.deepEqual(loadPrefs(storage), defaultPrefs());

  // 无 storage（无痕模式）→ 缺省，且 savePrefs 返回 false。
  assert.deepEqual(loadPrefs(null), defaultPrefs());
  assert.equal(savePrefs({ theme: 'pure' }, null), false);
});
