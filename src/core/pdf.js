/**
 * 多页 PDF 生成（纯函数，不碰 DOM，可在 Node 里单测）。
 *
 * ## 为什么不引依赖
 *
 * 导出内容只有文字、线条和矩形（见 docs/SPEC.md §11-7 为 PNG 立过的同一条理由）。
 * 一个「把若干张 JPEG 字节 + 页尺寸拼成 PDF 字节流」的最小实现不到 200 行，
 * 引一个 PDF 库要带几百 KB 而且大部分用不上。
 *
 * ## 代价（SPEC §8.5）：位图化
 *
 * 每页内嵌一张 JPEG（PDF 的 `DCTDecode`），所以导出的 PDF 里**文字不可选中、
 * 不可搜索**。这是刻意接受的取舍，换取「手机上一键下载 + 能按页选」。
 * 界面上必须把这个代价说清楚，不能让人拿到一份搜不到字的 PDF 还不知道为什么。
 *
 * ## 为什么用 JPEG 而不是 PNG
 *
 * 内嵌 PNG 要走 PDF 的 FlateDecode，并且要为「浏览器 canvas.toBlob 到底输出
 * RGB 还是 RGBA」写两套分支（RGBA 得先补一个 SMask 或者手动去 alpha）。JPEG 天然
 * 没有 alpha，一条 DCTDecode 就够，风险小得多。谱面是深灰字 + 白底 + 细线，
 * 0.92 以上的 JPEG 质量在视觉上和 PNG 无差别。
 *
 * ## 页尺寸与 PNG 共用一份版面
 *
 * 这里不写死 A4 数字，而是把「点密度（pt 数）」交给调用方传进来 —— 但默认值
 * 必须和 `src/ui/png.js` 的 `PAGE` 保持一致（900 × 1273 逻辑像素 = 等宽等高的 pt），
 * 否则「面板缩略图看到的第 3 页」和「PDF 里的第 3 页」会对不上（§8.4 第 1 条）。
 *
 * @module core/pdf
 */

const encoder = new TextEncoder();

/** 把 ASCII 文本编码成字节（本模块只产生 ASCII，多字节一律不允许进入）。 */
function ascii(text) {
  return encoder.encode(text);
}

/** 把一段字节追加到目标字节数组（手动增长，避免反复 new 大数组）。 */
function append(target, bytes) {
  const need = target.length + bytes.length;
  if (need > target.capacity) {
    let cap = target.capacity || 1024;
    while (cap < need) cap *= 2;
    const next = new Uint8Array(cap);
    next.set(target.data.subarray(0, target.length));
    target.data = next;
    target.capacity = cap;
  }
  target.data.set(bytes, target.length);
  target.length = need;
}

/**
 * 把若干个「页」拼成一份多页 PDF 的字节。
 *
 * @param {Array<{jpeg: Uint8Array, width: number, height: number}>} pages
 *   每页一张已经编码好的 JPEG 及其尺寸（单位 pt）。
 * @returns {Uint8Array} 完整的 PDF 字节流（以 `%PDF-` 开头、`%%EOF` 结尾）。
 */
export function buildPdf(pages) {
  if (!Array.isArray(pages) || pages.length === 0) {
    throw new Error('至少需要一页才能生成 PDF');
  }

  // 对象编号分配：
  //   1 = Catalog，2 = Pages，
  //   每个页面占 3 个对象：Page、Contents、Image（XObject）。
  const count = pages.length;
  const pageOf = (i) => 3 + i * 3; // Page
  const contentOf = (i) => 4 + i * 3; // Contents
  const imageOf = (i) => 5 + i * 3; // Image

  // 先把每个对象的「字节内容」准备好，并记录它们应该在文件里的顺序。
  // 顺序 = 对象编号顺序（PDF 允许乱序，但顺序写最容易验证）。
  /** @type {Array<Uint8Array>} */
  const bodies = [];
  /** 对象编号 -> bodies 下标（编号从 1 起） */
  bodies[0] = null; // 占位，让下标对齐编号

  const catalog = `<< /Type /Catalog /Pages 2 0 R >>`;
  bodies[1] = ascii(catalog);

  const kids = pages.map((_, i) => `${pageOf(i)} 0 R`).join(' ');
  bodies[2] = ascii(`<< /Type /Pages /Kids [${kids}] /Count ${count} >>`);

  for (let i = 0; i < count; i++) {
    const { jpeg, width, height } = pages[i];

    bodies[pageOf(i)] = ascii(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width} ${height}] ` +
        `/Resources << /XObject << /Im0 ${imageOf(i)} 0 R >> >> /Contents ${contentOf(i)} 0 R >>`,
    );

    const stream = `q ${width} 0 0 ${height} 0 0 cm /Im0 Do Q`;
    bodies[contentOf(i)] = ascii(
      `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    );

    // 图片对象 = 文本头 + JPEG 字节 + 文本尾，拼成一段连续字节。
    const imgHead = ascii(
      `<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} ` +
        `/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode ` +
        `/Length ${jpeg.length} >>\nstream\n`,
    );
    const imgTail = ascii(`\nendstream`);
    const imgObj = new Uint8Array(imgHead.length + jpeg.length + imgTail.length);
    imgObj.set(imgHead, 0);
    imgObj.set(jpeg, imgHead.length);
    imgObj.set(imgTail, imgHead.length + jpeg.length);
    bodies[imageOf(i)] = imgObj;
  }

  // 组装：header + 每个「N 0 obj … endobj」+ xref + trailer。
  // 边写边记每个对象的字节偏移（xref 需要）。
  const out = { data: new Uint8Array(1024), length: 0, capacity: 1024 };
  const offsets = new Array(bodies.length).fill(0); // 下标 = 对象编号

  append(out, ascii('%PDF-1.4\n'));

  for (let id = 1; id < bodies.length; id++) {
    offsets[id] = out.length;
    append(out, ascii(`${id} 0 obj\n`));
    append(out, bodies[id]);
    append(out, ascii(`\nendobj\n`));
  }

  const xrefOffset = out.length;

  let xref = `xref\n0 ${bodies.length}\n`;
  xref += `0000000000 65535 f \n`;
  for (let id = 1; id < bodies.length; id++) {
    xref += `${String(offsets[id]).padStart(10, '0')} 00000 n \n`;
  }

  const trailer =
    `trailer\n` +
    `<< /Size ${bodies.length} /Root 1 0 R >>\n` +
    `startxref\n${xrefOffset}\n` +
    `%%EOF\n`;

  append(out, ascii(xref + trailer));

  return out.data.subarray(0, out.length);
}
