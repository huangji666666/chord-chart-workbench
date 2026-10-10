/**
 * PDF 生成（src/core/pdf.js）的自动测试。
 *
 * 重点：
 * 1. 结构正确 —— 头、xref、trailer、startxref 都指向真实字节偏移。
 * 2. 多页对象编号正确，页树 Kids 和 Count 对齐。
 * 3. JPEG 字节原样内嵌，一个字节都不丢（DCTDecode 不进文本通道）。
 * 4. 空输入拒绝。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { buildPdf } from '../src/core/pdf.js';

/** 造一段「看起来像 JPEG」的字节（真实 JPEG 以 FFD8 开头、FFD9 结尾）。 */
function fakeJpeg(seed = 0) {
  const bytes = new Uint8Array(64);
  bytes[0] = 0xff;
  bytes[1] = 0xd8; // SOI
  for (let i = 2; i < bytes.length - 2; i++) bytes[i] = (i * 7 + seed * 13) % 256;
  bytes[bytes.length - 2] = 0xff;
  bytes[bytes.length - 1] = 0xd9; // EOI
  return bytes;
}

function latin1(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return s;
}

function extractObject(bytes, id) {
  const text = latin1(bytes);
  const marker = `${id} 0 obj`;
  const start = text.indexOf(marker);
  assert.notEqual(start, -1, `应存在对象 ${id}`);
  const bodyStart = start + marker.length;
  const end = text.indexOf('endobj', bodyStart);
  assert.notEqual(end, -1, `对象 ${id} 应有 endobj`);
  return text.slice(bodyStart, end);
}

test('空输入被拒绝', () => {
  assert.throws(() => buildPdf([]), /至少需要一页/);
});

test('单页 PDF：头、结尾、对象数量、xref 偏移都正确', () => {
  const jpeg = fakeJpeg(1);
  const pdf = buildPdf([{ jpeg, width: 900, height: 1273 }]);
  const text = latin1(pdf);

  assert.ok(text.startsWith('%PDF-1.4\n'), '以 PDF 头开头');
  assert.ok(text.trimEnd().endsWith('%%EOF'), '以 %%EOF 结尾');

  // 单页 = 1 Catalog + 1 Pages + 3 页对象 = 5 个对象
  assert.match(text, /\/Type \/Catalog/);
  assert.match(text, /\/Type \/Pages/);
  assert.match(text, /\/Type \/Page/);
  assert.match(text, /\/Subtype \/Image/);
  assert.match(text, /\/Count 1\b/);
  assert.match(text, /xref\n0 6\n/, 'xref 条目数 = 对象数 + 1');

  // startxref 指向的偏移，往回推应该是 xref 关键字
  const startxref = Number(/startxref\n(\d+)/.exec(text)[1]);
  assert.ok(text.startsWith('xref', startxref), 'startxref 指向 xref 表');
});

test('多页：Kids 列出所有页面，Count 正确', () => {
  const pages = [1, 2, 3].map((n) => ({ jpeg: fakeJpeg(n), width: 900, height: 1273 }));
  const pdf = buildPdf(pages);
  const text = latin1(pdf);

  assert.match(text, /\/Count 3\b/);
  // 三页 → Page 对象编号 3、6、9；Image 对象编号 5、8、11
  assert.match(text, /\/Kids \[3 0 R 6 0 R 9 0 R\]/);
  assert.match(text, /\/Type \/Page/g) && assert.equal((text.match(/\/Type \/Page\b/g) || []).length, 3);
});

test('JPEG 字节原样内嵌，长度声明与字节数一致', () => {
  const jpeg = fakeJpeg(7);
  const pdf = buildPdf([{ jpeg, width: 900, height: 1273 }]);
  const text = latin1(pdf);

  // Image 对象声明的 /Length 必须等于真实字节数
  assert.match(text, new RegExp(`/Length ${jpeg.length}\\b`));

  // 对象 5（单页时的 Image）里应能找到 JPEG 的 SOI…EOI 完整字节
  const imgObj = extractObject(pdf, 5);
  const soi = imgObj.indexOf('\u00ff\u00d8');
  assert.notEqual(soi, -1, 'Image 对象内嵌 JPEG SOI');
  const eoi = imgObj.indexOf('\u00ff\u00d9');
  assert.notEqual(eoi, -1, 'Image 对象内嵌 JPEG EOI');
  // 中间字节抽查几个，确认不是丢字节
  const slice = imgObj.slice(soi, eoi + 2);
  const expected = latin1(jpeg);
  assert.equal(slice, expected, '内嵌的 JPEG 与输入完全一致');
});

test('每页独立对象，不共享图片流', () => {
  const a = fakeJpeg(3);
  const b = fakeJpeg(9);
  const pdf = buildPdf([
    { jpeg: a, width: 900, height: 1273 },
    { jpeg: b, width: 800, height: 1100 },
  ]);
  const text = latin1(pdf);

  // 两页 MediaBox 不同
  assert.match(text, /\/MediaBox \[0 0 900 1273\]/);
  assert.match(text, /\/MediaBox \[0 0 800 1100\]/);

  // 两个 Image 对象各自内嵌自己的 JPEG
  const img1 = extractObject(pdf, 5);
  const img2 = extractObject(pdf, 8);
  assert.ok(img1.includes(latin1(a)));
  assert.ok(img2.includes(latin1(b)));
});

test('xref 每个对象偏移都指向正确的 "N 0 obj"', () => {
  const pages = [1, 2].map((n) => ({ jpeg: fakeJpeg(n), width: 900, height: 1273 }));
  const pdf = buildPdf(pages);
  const text = latin1(pdf);

  // 两页 = 1 Catalog + 1 Pages + 2页 × 3对象 = 8 个对象；xref 的 Size = 对象数 + 1 = 9
  const xrefMatch = /xref\n0 (\d+)\n/.exec(text);
  const size = Number(xrefMatch[1]);
  assert.equal(size, 9);

  // 逐个核对：偏移处必须是 "N 0 obj"
  const entries = text.match(/0000000000 65535 f \n([\s\S]*?)(?=trailer)/)[1];
  const lines = entries.trim().split('\n');
  assert.equal(lines.length, size - 1);
  for (const line of lines) {
    const m = /^(\d{10}) 00000 n/.exec(line);
    assert.ok(m, `xref 条目格式合法：${line}`);
    const offset = Number(m[1]);
    const expect = text.slice(offset, offset + 12);
    // 偏移处应形如 "N 0 obj"
    assert.match(expect, /^\d+ 0 obj/, `偏移 ${offset} 处应是对象头`);
  }
});
