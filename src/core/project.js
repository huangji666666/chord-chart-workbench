/**
 * 工程文件的导入与导出（docs/SPEC.md §7.4）。
 *
 * 导出格式（固定，不带任何界面状态）：
 *
 * ```json
 * {
 *   "schemaVersion": 1,
 *   "exportedAt": "2026-09-21T12:00:00.000Z",
 *   "song": { ...完整的 Song 对象... }
 * }
 * ```
 *
 * 为什么要包一层，而不是直接导出 Song？因为文件需要带上「这是本应用的工程文件、
 * 版本是几、什么时候导出的」。导入时才有依据给出「版本不匹配」这类准确提示，
 * 而不是拿一个别处的 JSON 一通乱校验、报出一堆看不懂的字段错误。
 *
 * ## 导入的八步流程（SPEC §7.4）
 *
 * 1. 检查体积（4 MB），超限直接拒绝 —— 在解析之前，避免一个超大文件把页面卡死。
 * 2. 解析 JSON，失败给出**语法**错误。
 * 3. 检查顶层结构与 `schemaVersion`（`1` 是可迁移的旧版本，不是不支持 —— 见 §7.4）。
 * 4. v1 → v2 迁移（`migrateSong`），再逐字段校验类型、范围、长度（`validateSongShape`）。
 * 5. 查重 ID（歌内重复由第 4 步覆盖）。
 * 6. 任一检查失败 → **当前数据完全不变**，只返回错误列表。
 * 7. 歌曲 ID 与库中已有歌曲冲突 → 生成新 ID，不覆盖已有歌曲。
 * 8. 渲染用户数据时一律走文本方式（本模块只管数据，这条由界面层遵守）。
 *
 * 本模块是纯函数：不碰 DOM、不碰 localStorage、不抛异常。
 *
 * @module core/project
 */

import { LIMITS, SCHEMA_VERSION } from './constants.js';
import { createId } from './ids.js';
import { nowIso, migrateSong, validateSongShape } from './song.js';

/**
 * 工程导入的错误码。
 * @type {Readonly<Record<string, string>>}
 */
export const PROJECT_CODES = Object.freeze({
  INPUT_TYPE: 'E_PROJECT_INPUT_TYPE',
  TOO_LARGE: 'E_PROJECT_TOO_LARGE',
  BAD_JSON: 'E_PROJECT_BAD_JSON',
  NOT_OBJECT: 'E_PROJECT_NOT_OBJECT',
  MISSING_SONG: 'E_PROJECT_MISSING_SONG',
  SONG_NOT_OBJECT: 'E_PROJECT_SONG_NOT_OBJECT',
  VERSION_UNSUPPORTED: 'E_PROJECT_VERSION_UNSUPPORTED',
  SONG_INVALID: 'E_PROJECT_SONG_INVALID',
});

/**
 * 导入结果。失败时 `errors` 是可以直接展示的结构化问题列表。
 *
 * @typedef {{ok: true, value: import('./song.js').Song, meta: ProjectMeta, warnings: string[]}
 *   | {ok: false, value: null, code: string, message: string,
 *      errors: import('./song.js').ValidationIssue[]}} ProjectParseResult
 */

/**
 * @typedef {Object} ProjectMeta
 * @property {number} schemaVersion 工程文件里记录的版本。
 * @property {string|null} exportedAt 导出时间（可能缺失）。
 * @property {boolean} idRegenerated 是否因为 ID 冲突而重新生成了歌曲 ID。
 * @property {string} originalSongId 文件里的原始歌曲 ID。
 */

/**
 * 判断一个值看起来是不是「一首歌」——用于给出比「缺少 song 字段」更有用的提示。
 * @param {unknown} value
 * @returns {boolean}
 */
function looksLikeSong(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value) && Array.isArray(value.sections);
}

/* ------------------------------------------------------------------ *
 * 导出
 * ------------------------------------------------------------------ */

/**
 * 把一首歌包装成工程对象（不序列化）。
 *
 * @param {import('./song.js').Song} song
 * @returns {{schemaVersion: number, exportedAt: string, song: import('./song.js').Song}}
 */
export function buildProject(song) {
  const validation = validateSongShape(song);
  if (!validation.ok) {
    const first = validation.errors[0];
    throw new Error(
      `buildProject: 歌曲数据不合法（${validation.errors.length} 处问题），首条：${first.path || '(根)'} ${first.message}。请先修正再导出。`,
    );
  }
  return { schemaVersion: SCHEMA_VERSION, exportedAt: nowIso(), song };
}

/**
 * 序列化成工程文件文本。
 *
 * 注意：写出的 `song` 里**只会有和弦数据**，不会出现任何级数字符串——
 * 显示模式是渲染时的偏好，不进数据（§6.4）。
 *
 * @param {import('./song.js').Song} song
 * @param {{pretty?: boolean}} [options] 默认带 2 空格缩进，方便人工查看与版本对比。
 * @returns {string}
 */
export function serializeProject(song, options = {}) {
  const pretty = options.pretty !== false;
  return JSON.stringify(buildProject(song), null, pretty ? 2 : 0);
}

/**
 * 建议的工程文件名。会过滤掉文件系统不接受的字符。
 *
 * @param {import('./song.js').Song} song
 * @param {string} [ext] 默认 `.json`。
 * @returns {string}
 */
export function suggestProjectFileName(song, ext = '.json') {
  const raw = [song?.title, song?.artist].filter(Boolean).join('-') || '功能谱';
  // Windows / macOS 都不接受这些字符，统一换成下划线；顺带去掉控制字符。
  const safe = raw
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
  return `${safe || '功能谱'}${ext}`;
}

/* ------------------------------------------------------------------ *
 * 导入
 * ------------------------------------------------------------------ */

/**
 * 解析一段工程文件文本。
 *
 * @param {string} text 文件内容。
 * @param {{existingSongIds?: Iterable<string>, regenerateOnConflict?: boolean}} [options]
 *   `existingSongIds` 传当前曲库里已经用掉的歌曲 ID；命中时按 SPEC §7.4 第 7 条生成新 ID。
 * @returns {ProjectParseResult}
 */
export function parseProject(text, options = {}) {
  const { existingSongIds = [], regenerateOnConflict = true } = options;

  // 第 1 步：输入类型与体积（在 parse 之前，避免卡住页面）。
  if (typeof text !== 'string') {
    return {
      ok: false,
      value: null,
      code: PROJECT_CODES.INPUT_TYPE,
      message: `导入内容必须是文本，收到 ${text === null ? 'null' : typeof text}。`,
      errors: [],
    };
  }
  const bytes = new TextEncoder().encode(text).length;
  if (bytes > LIMITS.maxSongJsonBytes) {
    return {
      ok: false,
      value: null,
      code: PROJECT_CODES.TOO_LARGE,
      message: `文件体积 ${(bytes / 1024 / 1024).toFixed(2)} MB，超过上限 ${(LIMITS.maxSongJsonBytes / 1024 / 1024).toFixed(0)} MB，已拒绝导入。`,
      errors: [],
    };
  }

  // 第 2 步：JSON 语法。
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return {
      ok: false,
      value: null,
      code: PROJECT_CODES.BAD_JSON,
      message: `文件不是合法的 JSON：${error?.message ?? error}`,
      errors: [],
    };
  }

  // 第 3 步：顶层结构。
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {
      ok: false,
      value: null,
      code: PROJECT_CODES.NOT_OBJECT,
      message: `工程文件的顶层必须是对象，实际为 ${Array.isArray(parsed) ? 'array' : parsed === null ? 'null' : typeof parsed}。`,
      errors: [],
    };
  }

  if (!Object.prototype.hasOwnProperty.call(parsed, 'song')) {
    const hint = looksLikeSong(parsed)
      ? '这看起来是一首 Song 对象本身，而不是工程文件。请使用本应用「导出工程」生成的文件。'
      : '工程文件里必须有一个 song 字段。';
    return { ok: false, value: null, code: PROJECT_CODES.MISSING_SONG, message: hint, errors: [] };
  }

  if (!parsed.song || typeof parsed.song !== 'object' || Array.isArray(parsed.song)) {
    return {
      ok: false,
      value: null,
      code: PROJECT_CODES.SONG_NOT_OBJECT,
      message: `工程文件的 song 字段必须是对象，实际为 ${parsed.song === null ? 'null' : Array.isArray(parsed.song) ? 'array' : typeof parsed.song}。`,
      errors: [],
    };
  }

  // v1 是**可迁移**的旧版本（SPEC §7.4），不是「不支持」。所以这里只拦真正
  // 认不出的版本号，v1 放行到第 4 步由 migrateSong 升级。
  const isLegacy = parsed.schemaVersion === 1 || parsed.schemaVersion === 2;
  if (!isLegacy && parsed.schemaVersion !== SCHEMA_VERSION) {
    return {
      ok: false,
      value: null,
      code: PROJECT_CODES.VERSION_UNSUPPORTED,
      message: `工程文件版本为 ${JSON.stringify(parsed.schemaVersion)}，支持 ${SCHEMA_VERSION} 和可升级的 1 / 2。`,
      errors: [],
    };
  }

  // 第 4 步：逐字段校验（含歌内 ID 查重，见 validateSongShape 末尾）。
  // v1 → v2 迁移必须发生在**校验之前**，否则显示偏好会被当成「数据不合法」拒掉。
  const song = isLegacy ? migrateSong(parsed.song) : parsed.song;
  const validation = validateSongShape(song);
  if (!validation.ok) {
    return {
      ok: false,
      value: null,
      code: PROJECT_CODES.SONG_INVALID,
      message: `歌曲数据有 ${validation.errors.length} 处问题，已拒绝导入（当前数据未做任何改动）。首条：${validation.errors[0].path || '(根)'} ${validation.errors[0].message}`,
      errors: validation.errors,
    };
  }

  // 第 5、7 步：与曲库里已有的歌曲 ID 冲突时换一个新 ID，绝不覆盖已有歌曲。
  const warnings = [];
  const taken = new Set(existingSongIds);
  const originalSongId = song.id;
  let finalSong = song;
  let idRegenerated = false;

  if (regenerateOnConflict && taken.has(song.id)) {
    let candidate = createId('song');
    while (taken.has(candidate)) candidate = createId('song');
    finalSong = { ...song, id: candidate };
    idRegenerated = true;
    warnings.push('文件里的歌曲 ID 与曲库中已有的歌曲重复，已为导入的歌曲生成新的 ID（原有歌曲不受影响）。');
  }

  return {
    ok: true,
    value: finalSong,
    meta: {
      // 这里报的是**源文件**的版本号，不是升级后的 —— 界面上可以据此提示
      // 「这份文件已从 v1 升级」，而 `value` 里的歌曲已经是当前版本。
      schemaVersion: parsed.schemaVersion,
      exportedAt: typeof parsed.exportedAt === 'string' ? parsed.exportedAt : null,
      idRegenerated,
      originalSongId,
    },
    warnings,
  };
}

/**
 * 把工程解析结果整理成一段可读文本（界面上直接展示用）。
 *
 * @param {import('./song.js').ValidationIssue[]} errors
 * @param {number} [maxLines]
 * @returns {string}
 */
export function formatProjectErrors(errors, maxLines = 8) {
  const shown = errors.slice(0, maxLines).map((issue) => (issue.path ? `${issue.path}：${issue.message}` : issue.message));
  if (errors.length > shown.length) shown.push(`…另有 ${errors.length - shown.length} 处问题`);
  return shown.join('\n');
}
