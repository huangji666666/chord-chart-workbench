/**
 * 唯一 ID 生成。
 *
 * 约束（见 docs/SPEC.md §2.3）：ID 不能依赖数组下标，复制 / 移动 / 删除元素后
 * 必须依然稳定唯一。因此这里生成的是带类型前缀的随机 ID，而不是序号。
 *
 * 浏览器与 Node 都能运行：优先用 Web Crypto，取不到时退回 Math.random。
 *
 * @module core/ids
 */

import { ID_PREFIXES } from './constants.js';

const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';
const RANDOM_LENGTH = 10;

/** 取一个加密安全的随机字节数组；环境不支持时返回 null。 */
function randomBytes(length) {
  const cryptoObj = globalThis.crypto;
  if (cryptoObj && typeof cryptoObj.getRandomValues === 'function') {
    const bytes = new Uint8Array(length);
    cryptoObj.getRandomValues(bytes);
    return bytes;
  }
  return null;
}

/**
 * 生成唯一 ID。
 *
 * @param {'song'|'section'|'bar'|'event'|'textBlock'} entity 实体类型，决定前缀。
 * @returns {string} 形如 `sec_k3f9a2x10p` 的 ID。
 */
export function createId(entity) {
  const prefix = ID_PREFIXES[entity];
  if (!prefix) {
    throw new Error(`createId: 未知实体类型 "${entity}"，可用类型：${Object.keys(ID_PREFIXES).join(', ')}`);
  }

  const bytes = randomBytes(RANDOM_LENGTH);
  let suffix = '';
  if (bytes) {
    for (let i = 0; i < RANDOM_LENGTH; i += 1) {
      suffix += ALPHABET[bytes[i] % ALPHABET.length];
    }
  } else {
    for (let i = 0; i < RANDOM_LENGTH; i += 1) {
      suffix += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
    }
  }
  return `${prefix}_${suffix}`;
}

/**
 * 判断字符串是否像本模块生成的 ID（用于导入工程文件时的基本检查）。
 * 只做宽松检查：类型前缀正确、总长度合理即可，不校验随机源。
 *
 * @param {unknown} value
 * @param {'song'|'section'|'bar'|'event'|'textBlock'} [entity] 传入时同时校验前缀。
 * @returns {boolean}
 */
export function isIdLike(value, entity) {
  if (typeof value !== 'string' || value.length < 4 || value.length > 64) return false;
  if (!entity) return true;
  const prefix = ID_PREFIXES[entity];
  return prefix ? value.startsWith(`${prefix}_`) : false;
}

/**
 * 收集一棵对象树里出现的所有 ID 字符串（用于查重）。
 * 只认 `id` 字段，不递归进数组下标。
 *
 * @param {object} root
 * @returns {string[]}
 */
export function collectIds(root) {
  const found = [];
  const walk = (node) => {
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (node && typeof node === 'object') {
      if (typeof node.id === 'string') found.push(node.id);
      for (const [key, value] of Object.entries(node)) {
        if (key === 'id') continue;
        walk(value);
      }
    }
  };
  walk(root);
  return found;
}
