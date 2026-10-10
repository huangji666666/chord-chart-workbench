/**
 * 数字级数换算（src/core/degrees.js）的自动测试。
 *
 * 这里是 SPEC §6.2 / §6.3 的**逐行抄写**：表格里写的是什么，测试就断言什么。
 * 之所以要这么死板，是因为级数换算错了之后结果依然「看起来像个级数」，
 * 光靠肉眼扫一遍根本发现不了。
 *
 * 最关键的一条是「同一个音在不同调里的级数不同」：`F#dim` 在 C 大调是 `#4dim`、
 * 在 G 大调是 `7dim`。按半音距离算会得到同一个答案，其中必有一个是错的。
 *
 * @see docs/SPEC.md §6
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { formatChordSymbol } from '../src/core/chord.js';
import { DEGREE_CODES, canShowDegrees, chordToDegree, formatChordForDisplay, pitchToDegreeToken } from '../src/core/degrees.js';

const C_MAJOR = { tonic: 'C', mode: 'major' };
const G_MAJOR = { tonic: 'G', mode: 'major' };
const F_MAJOR = { tonic: 'F', mode: 'major' };

function chord(root, quality = 'maj', bass = null) {
  return { root, quality, bass };
}

/**
 * 断言一组「和弦 → 期望级数」。
 * 用例写成 [root, quality, bass, 期望级数]，不做任何从字符串反推性质的猜测——
 * 那种写法遇到 `F#dim` 这种「音名带升降号」的情况就会算错。
 */
function expectDegrees(cases, key, label) {
  for (const [root, quality, bass, expected] of cases) {
    const symbol = `${root}${quality === 'maj' ? '' : quality}${bass ? `/${bass}` : ''}`;
    const result = chordToDegree(chord(root, quality, bass), key);
    assert.equal(result.ok, true, `${label} 中 ${symbol} 应当换算成功，实际：${result.message ?? ''}`);
    assert.equal(result.value, expected, `${label} 中 ${symbol}`);
  }
}

/* ------------------------------------------------------------------ *
 * SPEC §6.2 的三张表
 * ------------------------------------------------------------------ */

test('C 大调：SPEC §6.2 表格逐行一致', () => {
  expectDegrees(
    [
      ['C', 'maj', null, '1'],
      ['D', 'm', null, '2m'],
      ['E', 'm', null, '3m'],
      ['F', 'maj', null, '4'],
      ['G', 'maj', null, '5'],
      ['A', 'm', null, '6m'],
      ['B', 'dim', null, '7dim'],
      ['C', 'maj7', null, '1maj7'],
      ['A', 'm7', null, '6m7'],
      ['G', '7', null, '57'],
      ['F#', 'dim', null, '#4dim'],
      ['Bb', 'maj', null, 'b7'],
      ['Eb', 'maj', null, 'b3'],
      ['C', 'maj', 'G', '1/5'],
    ],
    C_MAJOR,
    'C 大调',
  );
});

test('G 大调：SPEC §6.2 表格逐行一致', () => {
  expectDegrees(
    [
      ['G', 'maj', null, '1'],
      ['F#', 'dim', null, '7dim'],
      ['F', 'maj', null, 'b7'],
      ['C', 'maj7', null, '4maj7'],
      ['D', 'maj', null, '5'],
    ],
    G_MAJOR,
    'G 大调',
  );
});

test('F 大调：SPEC §6.2 表格逐行一致', () => {
  expectDegrees(
    [
      ['Bb', 'maj', null, '4'],
      ['B', 'maj', null, '#4'],
      ['B', 'dim', null, '#4dim'],
    ],
    F_MAJOR,
    'F 大调',
  );
});

test('九种和弦性质在级数里原样保留后缀', () => {
  expectDegrees(
    [
      ['C', 'maj', null, '1'],
      ['C', 'm', null, '1m'],
      ['C', '7', null, '17'],
      ['C', 'maj7', null, '1maj7'],
      ['C', 'm7', null, '1m7'],
      ['C', 'sus2', null, '1sus2'],
      ['C', 'sus4', null, '1sus4'],
      ['C', 'dim', null, '1dim'],
      ['C', 'aug', null, '1aug'],
    ],
    C_MAJOR,
    'C 大调',
  );
});

/* ------------------------------------------------------------------ *
 * 核心对照：级数由「字母距离」决定
 * ------------------------------------------------------------------ */

test('同一个音在不同调里级数不同，证明用的是字母距离而非半音距离', () => {
  const inC = chordToDegree(chord('F#', 'dim'), C_MAJOR);
  const inG = chordToDegree(chord('F#', 'dim'), G_MAJOR);

  assert.equal(inC.value, '#4dim', 'C 大调里 F 是第 4 个字母，且 F 需要升号才是调内音');
  assert.equal(inG.value, '7dim', 'G 大调里 F 是第 7 个字母，G 大调本来就有 F#，所以不带前缀');
  assert.notEqual(inC.value, inG.value, '如果两个答案相同，说明算法退化成按半音算了');
});

test('调内音不带升降号前缀，调外音才带', () => {
  // F 大调的第 4 级是 Bb，所以 Bb 写作 4；写成本位 B 才是 #4。
  assert.equal(chordToDegree(chord('Bb'), F_MAJOR).value, '4');
  assert.equal(chordToDegree(chord('B'), F_MAJOR).value, '#4');

  // C 大调没有升降号，7 级本该是 B，Bdim 是 7dim。
  assert.equal(chordToDegree(chord('B', 'dim'), C_MAJOR).value, '7dim');
  // 同理 C 大调里 Bb 是降 7 级。
  assert.equal(chordToDegree(chord('Bb'), C_MAJOR).value, 'b7');
});

test('升降号只写最小写法，不会输出一堆 #', () => {
  // Cb 等价于 B：差 11 个半音，规约成 -1 后应写成 b1。
  assert.equal(chordToDegree(chord('Cb'), C_MAJOR).value, 'b1');
  assert.equal(chordToDegree(chord('B'), C_MAJOR).value, '7');
});

/* ------------------------------------------------------------------ *
 * 斜杠低音（§6.3）
 * ------------------------------------------------------------------ */

test('斜杠低音用同一套算法单独换算（SPEC §6.3）', () => {
  assert.equal(chordToDegree(chord('G', 'maj', 'B'), C_MAJOR).value, '5/7');
  assert.equal(chordToDegree(chord('C', 'maj', 'E'), C_MAJOR).value, '1/3');
  assert.equal(chordToDegree(chord('F', 'maj', 'A'), C_MAJOR).value, '4/6');
});

test('斜杠低音带升降号时也能换算', () => {
  const result = chordToDegree(chord('C', 'maj', 'Eb'), C_MAJOR);
  assert.equal(result.ok, true);
  assert.equal(result.value, '1/b3');
});

test('斜杠低音与根音同级时也照写不误', () => {
  assert.equal(chordToDegree(chord('C', 'maj', 'C'), C_MAJOR).value, '1/1');
});

/* ------------------------------------------------------------------ *
 * 错误分支
 * ------------------------------------------------------------------ */

test('未支持的调式明确拒绝，绝不悄悄按大调算', () => {
  const result = chordToDegree(chord('A', 'm'), { tonic: 'A', mode: 'dorian' });
  assert.equal(result.ok, false);
  assert.equal(result.value, null);
  assert.equal(result.code, DEGREE_CODES.MODE_UNSUPPORTED);
  assert.match(result.message, /尚不支持级数/);
});

test('调号主音非法时报错', () => {
  assert.equal(chordToDegree(chord('C'), { tonic: 'H', mode: 'major' }).code, DEGREE_CODES.TONIC_INVALID);
  assert.equal(chordToDegree(chord('C'), { mode: 'major' }).code, DEGREE_CODES.TONIC_INVALID);
  assert.equal(chordToDegree(chord('C'), null).code, DEGREE_CODES.TONIC_INVALID);
});

test('和弦根音 / 低音非法时报错', () => {
  assert.equal(chordToDegree(chord('X'), C_MAJOR).code, DEGREE_CODES.PITCH_INVALID);
  assert.equal(chordToDegree(chord('C', 'maj', 'H'), C_MAJOR).code, DEGREE_CODES.PITCH_INVALID);
});

test('未知和弦性质时报错', () => {
  assert.equal(chordToDegree(chord('C', 'invalid-quality'), C_MAJOR).code, DEGREE_CODES.QUALITY_UNKNOWN);
  assert.equal(chordToDegree(chord('C', null), C_MAJOR).code, DEGREE_CODES.QUALITY_UNKNOWN);
  // 注意这里必须显式写 undefined，不能让 helper 的默认参数把 quality 补成 'maj'。
  assert.equal(chordToDegree({ root: 'C', quality: undefined, bass: null }, C_MAJOR).code, DEGREE_CODES.QUALITY_UNKNOWN);
});

test('pitchToDegreeToken 对缺参数返回空串而不是崩掉', () => {
  assert.equal(pitchToDegreeToken(null, null), '');
  assert.equal(pitchToDegreeToken({ letter: 'C', accidental: 0 }, null), '');
});

/* ------------------------------------------------------------------ *
 * 显示层：失败时回退到和弦名
 * ------------------------------------------------------------------ */

test('formatChordForDisplay 在和弦名模式下不做转换', () => {
  const result = formatChordForDisplay(chord('C', 'maj7'), { line: 'chord', key: C_MAJOR }, formatChordSymbol);
  assert.equal(result.text, 'Cmaj7');
  assert.equal(result.usedDegree, false);
  assert.equal(result.note, null);
});

test('formatChordForDisplay 在级数模式下输出级数', () => {
  const result = formatChordForDisplay(chord('F#', 'dim'), { line: 'degree', key: C_MAJOR }, formatChordSymbol);
  assert.equal(result.text, '#4dim');
  assert.equal(result.usedDegree, true);
  assert.equal(result.note, null);
});

test('级数换算失败时回退到和弦名，并把原因放进 note', () => {
  const result = formatChordForDisplay(
    chord('A', 'm'),
    { line: 'degree', key: { tonic: 'A', mode: 'dorian' } },
    formatChordSymbol,
  );
  assert.equal(result.text, 'Am', '宁可显示正确的和弦名，也不显示可能错误的级数');
  assert.equal(result.usedDegree, false);
  assert.match(result.note, /尚不支持级数/);
});

test('canShowDegrees 告诉界面能不能切到级数显示', () => {
  assert.deepEqual(canShowDegrees(C_MAJOR), { ok: true, message: null });

  const minor = canShowDegrees({ tonic: 'A', mode: 'minor' });
  assert.deepEqual(minor, { ok: true, message: null });
  assert.equal(canShowDegrees({ tonic: 'D', mode: 'dorian' }).ok, false);

  const badTonic = canShowDegrees({ tonic: '无效', mode: 'major' });
  assert.equal(badTonic.ok, false);
  assert.match(badTonic.message, /调号主音无效/);
});

test('切换显示方式不修改任何和弦数据（§6.4）', () => {
  const source = chord('F#', 'dim', 'A');
  const snapshot = JSON.stringify(source);

  formatChordForDisplay(source, { line: 'degree', key: C_MAJOR }, formatChordSymbol);
  formatChordForDisplay(source, { line: 'chord', key: C_MAJOR }, formatChordSymbol);

  assert.equal(JSON.stringify(source), snapshot, '显示层必须只读');
});

/* ------------------------------------------------------------------ *
 * 级数切分：属七的后缀画成右下角小角标（SPEC §6.1）
 * ------------------------------------------------------------------ */

test('只有属七的后缀被标记成角标，其余性质一律不标记', () => {
  // 属七的符号是纯数字，级数会变成 `57` —— 两个数字直接相邻才有误读风险
  const dom7 = chordToDegree(chord('G', '7'), C_MAJOR);
  assert.deepEqual(dom7.parts, [
    { text: '5', script: null },
    { text: '7', script: 'sub' },
  ]);

  // 小七 / 大七 / 减三 / 挂四 的符号里带字母，数字不会连成一片，所以不做角标。
  // 这一组是**刻意的边界**：如果有人把 SUBSCRIPT_QUALITY_IDS 扩成「所有带 7 的」，
  // 这里会立刻红。
  for (const [root, quality, expected] of [
    ['A', 'm7', '6m7'],
    ['C', 'maj7', '1maj7'],
    ['B', 'dim', '7dim'],
    ['G', 'sus4', '5sus4'],
    ['G', 'sus2', '5sus2'],
    ['A', 'm', '6m'],
    ['C', 'maj', '1'],
  ]) {
    const result = chordToDegree(chord(root, quality), C_MAJOR);
    assert.equal(result.value, expected);
    assert.equal(
      result.parts.some((part) => part.script === 'sub'),
      false,
      `${expected} 不该带角标`,
    );
  }
});

test('parts 拼起来必然等于 value —— 文本往返与显示用的是同一份内容', () => {
  const cases = [
    chord('G', '7'),
    chord('G', '7', 'B'),
    chord('F#', 'dim'),
    chord('Bb', 'maj7', 'D'),
    chord('C'),
    chord('A', 'm7'),
  ];

  for (const source of cases) {
    const result = chordToDegree(source, C_MAJOR);
    assert.equal(result.ok, true, `${JSON.stringify(source)} 应当换算成功`);
    assert.equal(
      result.parts.map((part) => part.text).join(''),
      result.value,
      `${result.value} 的切分拼起来必须等于原文`,
    );
    assert.equal(
      result.parts.every((part) => part.text !== ''),
      true,
      '不产生空段 —— 空段会在渲染时多出没有意义的节点',
    );
  }
});

test('属七 + 斜杠低音时角标夹在中间，切分仍然正确', () => {
  const result = chordToDegree(chord('G', '7', 'B'), C_MAJOR);

  assert.equal(result.value, '57/7', 'C 大调里 G 是 5 级属七，低音 B 是 7 级');
  assert.deepEqual(result.parts, [
    { text: '5', script: null },
    { text: '7', script: 'sub' },
    { text: '/7', script: null },
  ], '角标不在末尾 —— 渲染时必须逐段顺序绘制，不能假设「最后一段才是角标」');
});

test('换算失败时 parts 为 null，不留半截切分', () => {
  const minor = chordToDegree(chord('A', 'm'), { tonic: 'A', mode: 'dorian' });
  assert.equal(minor.ok, false);
  assert.equal(minor.parts, null);

  assert.equal(chordToDegree(chord('C', 'invalid-quality'), C_MAJOR).parts, null);
  assert.equal(chordToDegree(chord('X'), C_MAJOR).parts, null);
});

test('和弦名模式下 parts 是单段，不带角标', () => {
  const result = formatChordForDisplay(
    chord('G', '7'),
    { line: 'chord', key: C_MAJOR },
    formatChordSymbol,
  );
  assert.equal(result.text, 'G7');
  assert.deepEqual(
    result.parts,
    [{ text: 'G7', script: null }],
    '和弦名没有「性质后缀」这个概念，整串就是一段',
  );
});

test('级数模式下 parts 把属七的后缀切成角标段', () => {
  const result = formatChordForDisplay(
    chord('G', '7'),
    { line: 'degree', key: C_MAJOR },
    formatChordSymbol,
  );
  assert.equal(result.text, '57', '纯文本仍然是 57 —— 文本输入与工程文件不认角标');
  assert.equal(result.usedDegree, true);
  assert.deepEqual(
    result.parts.map((part) => part.script),
    [null, 'sub'],
  );
});

/* ------------------------------------------------------------------ *
 * 罗马数字级数（SPEC §6.7）
 *
 * 这一组要盯住两件事：
 * 1. 两种字形算出的**级数必须相同** —— 它们共用同一套字母距离算法，
 *    只差最后一步字形表。如果哪天有人「顺手优化」成两套算法，这里会红。
 * 2. 大小写承担和弦性质，且 `m` 后缀被小写吸收 —— 不能出现 `vim`。
 * ------------------------------------------------------------------ */

test('C 大调：SPEC §6.7 对照表逐行一致', () => {
  // [root, quality, 数字级数, 罗马级数]
  const cases = [
    ['C', 'maj', '1', 'I'],
    ['D', 'm', '2m', 'ii'],
    ['E', 'm', '3m', 'iii'],
    ['F', 'maj', '4', 'IV'],
    ['G', 'maj', '5', 'V'],
    ['A', 'm', '6m', 'vi'],
    ['B', 'dim', '7dim', 'viidim'],
    ['C', 'maj7', '1maj7', 'Imaj7'],
    ['A', 'm7', '6m7', 'vi7'],
    ['G', '7', '57', 'V7'],
    ['F#', 'dim', '#4dim', '#ivdim'],
    ['Bb', 'maj', 'b7', 'bVII'],
  ];

  for (const [root, quality, arabic, roman] of cases) {
    const source = chord(root, quality);
    const symbol = `${root}${quality === 'maj' ? '' : quality}`;

    const a = chordToDegree(source, C_MAJOR, 'arabic');
    const r = chordToDegree(source, C_MAJOR, 'roman');

    assert.equal(a.ok, true, `${symbol} 数字级数应换算成功`);
    assert.equal(r.ok, true, `${symbol} 罗马级数应换算成功`);
    assert.equal(a.value, arabic, `${symbol} 的数字级数`);
    assert.equal(r.value, roman, `${symbol} 的罗马级数`);
  }
});

test('两种字形只差字形：同一个音名的级数必然一一对应', () => {
  // 这一条盯的是「共用同一套算法」这个设计。如果哪天有人把罗马级数
  // 实现成第二套独立算法，两者迟早会在某个调 / 某个升降号上分叉。
  for (const letter of ['C', 'D', 'E', 'F', 'G', 'A', 'B']) {
    for (const accidental of [-1, 0, 1]) {
      const pitch = { letter, accidental };
      const tonic = { letter: 'C', accidental: 0 };
      const arabic = pitchToDegreeToken(pitch, tonic, 'arabic');
      const roman = pitchToDegreeToken(pitch, tonic, 'roman');

      const prefix = arabic.match(/^[#b]*/)[0];
      const degree = Number(arabic.slice(prefix.length));
      const expected = prefix + ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII'][degree - 1];

      assert.equal(arabic, `${prefix}${degree}`, `${letter} 带 ${accidental} 个升降号`);
      assert.equal(roman, expected, `${letter} 带 ${accidental} 个升降号：${arabic} 应对应 ${expected}`);
    }
  }
});

test('两种字形只在「字形 + 大小写 + m 后缀」上有差别', () => {
  const ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII'];
  const LOWERCASE = new Set(['m', 'm7', 'dim']);

  for (const root of ['C', 'D', 'E', 'F', 'G', 'A', 'B', 'F#', 'Bb', 'Eb', 'C#']) {
    for (const quality of ['maj', 'm', '7', 'maj7', 'm7', 'sus2', 'sus4', 'dim', 'aug']) {
      const source = chord(root, quality);
      const arabic = chordToDegree(source, C_MAJOR, 'arabic');
      const roman = chordToDegree(source, C_MAJOR, 'roman');

      assert.equal(arabic.ok, roman.ok, `${root}${quality}：两种字形必须同时成功或同时失败`);
      if (!arabic.ok) continue;

      // 级数部分：数字 ↔ 罗马，大小写由和弦性质决定
      // 用 parts[0] 而不是从 value 里正则取数字 —— `C7` 的纯文本是 `17`，
      // 直接抓连续数字会得到「十七」。parts 已经替我们切好了根音段。
      const arabicRoot = arabic.parts[0].text;
      const prefix = arabicRoot.match(/^[#b]*/)[0];
      const degree = Number(arabicRoot.slice(prefix.length));
      const numeral = ROMAN[degree - 1];
      const expectedRoot = prefix + (LOWERCASE.has(quality) ? numeral.toLowerCase() : numeral);
      assert.equal(roman.parts[0].text, expectedRoot, `${root}${quality} 的级数部分`);

      // 后缀部分：只有 m / m7 被吸收改写，其余逐字沿用数字字形的后缀
      const arabicSuffix = arabic.parts.slice(1).map((part) => part.text).join('');
      const expectedSuffix = quality === 'm' ? '' : quality === 'm7' ? '7' : arabicSuffix;
      assert.equal(
        roman.parts.slice(1).map((part) => part.text).join(''),
        expectedSuffix,
        `${root}${quality} 的后缀：数字字形是「${arabicSuffix}」`,
      );
    }
  }
});

test('大小写承担和弦性质：大三 / 属七 / 大七 / 挂留 / 增是大写', () => {
  for (const [root, quality, expected] of [
    ['C', 'maj', 'I'],
    ['G', '7', 'V7'],
    ['C', 'maj7', 'Imaj7'],
    ['G', 'sus4', 'Vsus4'],
    ['G', 'sus2', 'Vsus2'],
    ['C', 'aug', 'Iaug'],
    ['F', 'maj', 'IV'],
  ]) {
    const result = chordToDegree(chord(root, quality), C_MAJOR, 'roman');
    assert.equal(result.value, expected, `${root}${quality} 应当写成大写`);
  }
});

test('小三 / 小七 / 减三是小写，且 m 后缀被大小写吸收（不出现 vim）', () => {
  for (const [root, quality, expected] of [
    ['A', 'm', 'vi'],
    ['D', 'm', 'ii'],
    ['A', 'm7', 'vi7'],
    ['B', 'dim', 'viidim'],
  ]) {
    const result = chordToDegree(chord(root, quality), C_MAJOR, 'roman');
    assert.equal(result.value, expected, `${root}${quality} 应当写成小写`);
    assert.match(result.value, /^[#b]*[iv]+/, '级数部分必须是小写罗马数字');
    // 唯一允许出现 m 的地方是 dim —— 那是性质符号本身，不是被吸收掉的那个 m
    if (!expected.endsWith('dim')) {
      assert.equal(result.value.includes('m'), false, `${root}${quality}：小写已经表达了小三，不能再补一个 m`);
    }
  }
});

test('罗马字形的 parts 拼起来仍然等于 value（不变式对两种字形都成立）', () => {
  const cases = [
    chord('G', '7'),
    chord('G', '7', 'B'),
    chord('A', 'm7'),
    chord('B', 'dim'),
    chord('C', 'maj7'),
    chord('F#', 'dim'),
    chord('Bb', 'maj', 'D'),
  ];

  for (const source of cases) {
    const result = chordToDegree(source, C_MAJOR, 'roman');
    assert.equal(result.ok, true, `${JSON.stringify(source)} 应当换算成功`);
    assert.equal(result.parts.map((part) => part.text).join(''), result.value);
    assert.equal(result.parts.every((part) => part.text !== ''), true, '不产生空段');
  }
});

test('罗马字形的属七角标规则与数字字形完全一致', () => {
  const result = chordToDegree(chord('G', '7', 'B'), C_MAJOR, 'roman');

  assert.equal(result.value, 'V7/VII', 'C 大调里 G 是 V 级属七，低音 B 是 VII 级');
  assert.deepEqual(result.parts, [
    { text: 'V', script: null },
    { text: '7', script: 'sub' },
    { text: '/VII', script: null },
  ], '角标依然不在末尾 —— 两种字形共用同一套切分');

  // 斜杠低音只换算音名、没有和弦性质，所以不参与大小写规则，一律大写。
  assert.equal(result.parts[2].text, '/VII', '斜杠低音不跟随大小写规则');
});

test('formatChordForDisplay 用 line: "roman" 触发罗马级数', () => {
  const result = formatChordForDisplay(
    chord('G', '7'),
    { line: 'roman', key: C_MAJOR },
    formatChordSymbol,
  );
  assert.equal(result.text, 'V7');
  assert.equal(result.usedDegree, true);
  assert.deepEqual(result.parts.map((part) => part.script), [null, 'sub']);

  // 同一个和弦换成数字字形，parts 结构不变、只有字形不同。
  const arabic = formatChordForDisplay(
    chord('G', '7'),
    { line: 'degree', key: C_MAJOR },
    formatChordSymbol,
  );
  assert.deepEqual(
    result.parts.map((part) => part.script),
    arabic.parts.map((part) => part.script),
  );
});

test('羅马字形下未支持的调式也回退到和弦名', () => {
  const result = formatChordForDisplay(
    chord('A', 'm'),
    { line: 'roman', key: { tonic: 'A', mode: 'dorian' } },
    formatChordSymbol,
  );
  assert.equal(result.text, 'Am', '小调不猜级数，宁可显示和弦名');
  assert.equal(result.usedDegree, false);
  assert.match(result.note, /尚不支持级数/);
});

test('切换字形不改数据 —— value 与 parts 都是新对象', () => {
  const source = chord('F#', 'dim', 'A');
  const snapshot = JSON.stringify(source);

  const roman = chordToDegree(source, C_MAJOR, 'roman');
  const arabic = chordToDegree(source, C_MAJOR, 'arabic');

  assert.equal(JSON.stringify(source), snapshot, '换算必须只读');
  assert.notEqual(roman.value, arabic.value, '两种字形确实产出了不同的文本');
  assert.notEqual(roman.parts, arabic.parts, 'parts 不是同一个数组');
});

/* ------------------------------------------------------------------ *
 * 减三和弦后缀：`dim` 还是 `°`（SPEC §6.7.1）
 * ------------------------------------------------------------------ */

test('缺省就是 dim —— 省略 dimSuffix 与显式传 dim 必须完全一致', () => {
  const source = chord('B', 'dim');
  for (const glyph of ['arabic', 'roman']) {
    assert.deepEqual(
      chordToDegree(source, C_MAJOR, glyph),
      chordToDegree(source, C_MAJOR, glyph, 'dim'),
      `${glyph}：省略等价于显式传 'dim'`,
    );
  }
  assert.equal(chordToDegree(source, C_MAJOR, 'arabic').value, '7dim');
  assert.equal(chordToDegree(source, C_MAJOR, 'roman').value, 'viidim');
});

test('dimSuffix 改成 ° 时，数字行与罗马行必须同时变', () => {
  const source = chord('B', 'dim');
  assert.equal(chordToDegree(source, C_MAJOR, 'arabic', '°').value, '7°');
  assert.equal(chordToDegree(source, C_MAJOR, 'roman', '°').value, 'vii°');

  // 这条是设计要点：两行共用一个值。若只变一边，并排会出现 `7dim` 与 `vii°` 并存，
  // 看着像两个不同的和弦 —— 那比不做这个开关还糟。
  for (const glyph of ['arabic', 'roman']) {
    assert.equal(chordToDegree(source, C_MAJOR, glyph, '°').value.includes('°'), true);
    assert.equal(chordToDegree(source, C_MAJOR, glyph, 'dim').value.includes('°'), false);
  }
});

test('° 下的 C 大调对照（SPEC §6.7.1），级数部分逐字不变', () => {
  for (const [root, arabic, roman] of [
    ['B', '7°', 'vii°'],
    ['F#', '#4°', '#iv°'],
  ]) {
    assert.equal(chordToDegree(chord(root, 'dim'), C_MAJOR, 'arabic', '°').value, arabic);
    assert.equal(chordToDegree(chord(root, 'dim'), C_MAJOR, 'roman', '°').value, roman);
  }

  // 换的只是后缀写法：把后缀去掉之后，两种设置必须逐字相同。
  const withDim = chordToDegree(chord('F#', 'dim'), C_MAJOR, 'roman', 'dim').value;
  const withSymbol = chordToDegree(chord('F#', 'dim'), C_MAJOR, 'roman', '°').value;
  assert.equal(
    withDim.replace('dim', ''),
    withSymbol.replace('°', ''),
    '级数部分（#iv）与后缀是分开的，改后缀不该碰到级数',
  );
});

test('° 是普通后缀，不是右下角小角标（角标只给属七）', () => {
  const dim = chordToDegree(chord('B', 'dim'), C_MAJOR, 'arabic', '°');
  assert.deepEqual(
    dim.parts,
    [
      { text: '7', script: null },
      { text: '°', script: null },
    ],
    '° 必须全字号 —— 它在字形里本来就画在上方，再下沉会看不懂',
  );

  // 同一次换算里，属七的角标不受影响：两条规则互不干扰。
  const seven = chordToDegree(chord('G', '7'), C_MAJOR, 'arabic', '°');
  assert.deepEqual(seven.parts.map((part) => part.script), [null, 'sub']);
});

test('parts 不变式对 ° 也成立（拼起来必须等于 value）', () => {
  for (const [root, glyph, bass] of [
    ['B', 'arabic', null],
    ['B', 'roman', null],
    ['B', 'roman', 'D'],
    ['F#', 'roman', 'A'],
  ]) {
    const result = chordToDegree(chord(root, 'dim', bass), C_MAJOR, glyph, '°');
    assert.equal(result.ok, true);
    assert.equal(result.parts.map((part) => part.text).join(''), result.value);
    assert.equal(result.parts.every((part) => part.text !== ''), true, '不产生空段');
  }
});

test('° 只改减三，其余性质一个字都不许动', () => {
  for (const quality of ['maj', 'm', '7', 'maj7', 'm7', 'sus2', 'sus4', 'aug']) {
    for (const glyph of ['arabic', 'roman']) {
      assert.equal(
        chordToDegree(chord('B', quality), C_MAJOR, glyph, '°').value,
        chordToDegree(chord('B', quality), C_MAJOR, glyph, 'dim').value,
        `${quality} / ${glyph} 不该被 dimSuffix 影响`,
      );
    }
  }
});

test('和弦名永远写 Bdim —— dimSuffix 是级数记法，不是和弦性质符号（§6.7.1）', () => {
  const asChord = formatChordForDisplay(
    chord('B', 'dim'),
    { line: 'chord', key: C_MAJOR, dimSuffix: '°' },
    formatChordSymbol,
  );
  assert.equal(asChord.text, 'Bdim', '和弦名不受 dimSuffix 影响');
  assert.equal(asChord.usedDegree, false);

  // 同一份 options 换到级数行，才出现 °。
  const asDegree = formatChordForDisplay(
    chord('B', 'dim'),
    { line: 'degree', key: C_MAJOR, dimSuffix: '°' },
    formatChordSymbol,
  );
  assert.equal(asDegree.text, '7°');
});

test('非法 dimSuffix 退化成缺省，而不是让级数换算失败（容错）', () => {
  const source = chord('B', 'dim');
  for (const bogus of [undefined, null, 'o', 'DIM', '', 123, {}]) {
    const result = chordToDegree(source, C_MAJOR, 'arabic', bogus);
    assert.equal(result.ok, true, `bogus=${JSON.stringify(bogus)} 不该让换算失败`);
    assert.equal(result.value, '7dim', `bogus=${JSON.stringify(bogus)} 应当退化成 dim`);
  }
});
