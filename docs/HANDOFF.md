# HANDOFF —— 交接文档

> **当前交接入口（2026-10-10）**：主应用为 `src/ui/studio-app.js`，已落实谱库 / 写谱双入口工作台，包含多页导入、逐字位置校正、空白起稿与可插入的原生 SVG 和弦图。歌曲结构为 v3，新增可选 `unsetMeta` 与 `chordDiagrams` 字段；351 条测试、构建和依赖审计通过。和弦图库沿用已安装的 SVGuitar / chords-db，420 种和弦与 1,634 个指法，支持把位、独立大小、排序、随谱保存与 SVG 下载。功能、开源依赖、真实界面截图与验证见 [轻谱当前实现说明](轻谱-当前实现说明.md)；本轮截图在 `design/implemented-chord-diagrams/`。下文是 2026-09-22 的历史阶段记录，旧版本号、模块入口和体积不代表当前交付。

> 本文件每完成一个阶段都会更新。**只记录实际发生的事**：没跑过的检查一律标「未验证」。

| 项 | 值 |
| --- | --- |
| 当前阶段 | **阶段三：把核心逻辑接进界面**（+ 显示行 / 减三后缀 / 记谱风格与输入别名 / 界面整理 / 主题与字体 / 歌词 / 自由文字块七个增量，见 §8） |
| 交付状态 | 阶段三完成、七个增量均已落地并验证，等待确认后进入阶段四 |
| 数据结构版本 | `schemaVersion = 2`（v1 自动迁移，不拒绝导入） |
| 自动化测试 | **326 条，全部通过** |
| 生产构建 | 通过（28 模块；JS 149.11 kB / gzip 49.48 kB；CSS 21.73 kB） |
| 浏览器验证 | Chrome 153，390 / 768 / 1280px 三档，零运行时错误 |
| 最后更新 | 2026-09-22 |

---

## 1. 这个阶段完成了什么

阶段三把阶段二那 7 个核心模块**真正接进了界面**，并补齐了 SPEC §8 的导出能力。
新增 8 个界面模块，重写了入口与样式。所有编辑操作都走 `core/edit.js` 的纯函数，
再经 `store.js` 统一提交，因此**撤销 / 重做 / 自动保存 / 校验提示是全自动的** ——
没有哪一处界面代码自己改数据。

### 1.1 界面怎么分层

| 模块 | 职责 | 一句话 |
| --- | --- | --- |
| `ui/dom.js` | 安全 DOM 构造 | **没有 `innerHTML` 入口**；空值一律跳过 |
| `ui/dialogs.js` | 提示 / 确认 / 输入 / 底部面板 | 错误提示不自动消失 |
| `ui/store.js` | 状态中枢 | 单一数据源 + 撤销栈 + 自动保存 |
| `ui/chart.js` | 谱面渲染 | 屏幕 / 打印 / PNG 共用一套排版规则 |
| `ui/sheets.js` | 点按面板 | 和弦 / 小节 / 段落的全部操作 |
| `ui/panels.js` | 侧栏面板 | 歌曲信息 / 曲库 / 文本输入 / 数据 |
| `ui/png.js` | PNG 导出 | Canvas 手绘，按页导出 |
| `ui/export.js` | 导出与打印统一入口 | 一个面板选 PDF / PNG / 打印 + 选页 |
| `ui/app.js` | 装配层 | 布局、模式、快捷键、打印 |

分工的界线是：**`core/` 不知道 DOM 的存在，`ui/` 不持有歌曲的副本。**
界面每次都从 `store.getSong()` 现取，所以不可能出现「屏幕上是旧的、存的是新的」。

### 1.2 单一数据源怎么保证

`ui/store.js` 只有一个入口能改动数据：

```js
store.run('添加事件', (song) => edit.addEvent(song, {...}));
```

它负责四件事：成功才推进历史栈 → 更新曲库 → 排一次自动保存（200ms 合并窗口）
→ 通知重画。**失败（`{ok:false}`）时什么都不改**，连历史栈都不动。
界面拿到失败就弹提示，数据保持原样。

这样一来，那些最容易写错的耦合都不需要各写一遍：
「撤销之后要顺便重画」「保存失败要显示真实状态」「操作被拒绝时不能留下半截数据」，
全都只在这一个函数里发生。

### 1.3 重画策略：整块重建 + 状态还原

面板一律**整块重建**，而不是细粒度改某几个节点。理由很实际：细粒度更新最容易
出现「数据改了但界面没跟上」，而那种问题会让人开始不信任屏幕上的东西。

重建的代价是会换掉正在输入的控件，所以重建前后做两件事：

1. **搬回焦点与光标**（`captureFocus` / `restoreFocus`，靠 `data-focus-key`）。
2. **搬回 `<details>` 的展开状态**（按 summary 文字为键记着）。

外加一条从源头避免麻烦的规则：**表单在 `change` 而不是 `input` 上提交**，
所以打字过程中根本不触发重建，上面两件事只是兜底。

### 1.4 窄屏折行：一个必须解释清楚的取舍

SPEC §8.2 要求「和弦按时值占比例占宽」，§9 要求「触控目标 ≥ 44px」，
这两条在 390px 上会直接打架：按每行 4 小节排，一个和弦块只剩 **33px**，点不准。

处理方式是**屏幕上往下减少每行小节数**（`ui/chart.js` 的 `effectiveColumns`）：

- 从 `barsPerRow` 设置值开始往下试 8 / 4 / 2 / 1，取第一个能让「一个小节 ≥ 88px」
  （约两个和弦块各 44px）的档位。
- **不改动 `layout.barsPerRow` 一个字节**，并且在谱面上写出
  「这一个屏幕放不下每行 4 小节，现在按每行 2 小节显示……歌曲设置本身没有被改动」。
- **打印和 PNG 不受影响**：它们仍严格按设置值排。

最后这一条技术上有个坑：打印复用**同一份 DOM**，所以如果屏幕和打印共用一个
CSS 变量，在手机上按打印就会印出「每行 2 小节」。因此栅格拿的是两个变量 ——
`--cols`（屏幕）和 `--cols-print`（打印），`@media print` 里改回后者。

### 1.5 PNG 导出：不引依赖

用 Canvas 2D 手绘（`ui/png.js`），没有引入任何截图或图像库。理由：

- 导出内容只有文字、线条和矩形，`fillText` / `strokeRect` 够用。
- 直接继承系统字体，**中文与升降号不会出现字体缺失**（这是引库反而要额外处理的问题）。
- 不需要处理字体加载时机、不需要多几百 KB。

分页按 A4 比例 `900 × 1273`（导出时 2.5× 放大成 `2250 × 3183`），
**小节不跨页**，段落标题不孤零零留在页尾，续页标歌曲名，页脚有页码。
`eventDisplayText` 与屏幕渲染是同一个函数，避免「级数换算失败回退到和弦名」
这条规则在两处各写一遍然后慢慢漂移。

### 1.6 保存状态说实话

`store.js` 区分 5 种状态：`saved` / `pending` / `error` / `unsupported` / `blocked`。

- `unsupported`：环境不支持 localStorage（无痕模式等）→ 明确告知「刷新就会丢，请导出备份」。
- `blocked`：**读到损坏数据** → 不写盘（因为一写就覆盖了用户可能想救的原文）。
- `error`：配额满 / 写入失败 → 如实上报，不假装成功。

损坏数据有专门的出口横幅：可以导出原始字符串，也可以清空重来
（清空要求输入确认词，这是**唯一**会覆盖损坏数据的动作）。

### 1.7 阶段三收尾追加：显示行（2026-09-21）

在「可配置记谱法」提案（§8）上按用户拍板**收窄到两个点**：

- **级数字形可切换**：阿拉伯数字 `1 2 3 #4 b7` / 罗马数字 `I ii iii #IV bVII`，同一套算法换字形。
- **显示行可并行**：和弦名 / 数字级数 / 罗马级数，一个和弦块最多三行，顺序固定不可调。

设计上只有一条主线：**显示行只影响渲染，永不改数据。** 所以
`layout.displayMode`（字符串）升级成 `layout.displayLines`（1–3 项数组），
`schemaVersion` 1 → 2，v1 老文件读取时自动迁移。

三条「不做」同样是决定：输入符号体系不放开、和弦性质符号不改、角标范围不扩大。
理由见 §8.0。

### 1.8 阶段三收尾追加：减三后缀 `dim` / `°`（2026-09-22）

用户拍板「**能加进来，设置里面也能改**」，于是把「罗马级数里减三写不写 `°`」也做成了设置项。
做法与上一轮同源：**只放开有争议的那一项，且不改变默认行为**。

- 新增 `layout.dimSuffix`，取 `'dim'`（缺省，等于旧行为）或 `'°'`。
- **两种字形共用同一个值**：设成 `°` 时数字行与罗马行**同时**变（`7°` / `vii°`）。
  若只变一边，并排会出现 `7dim` 与 `vii°` 并存，看着像两个不同的和弦，比不做还糟。
- **`°` 是级数记法，不是和弦性质符号**：和弦名永远写 `Bdim`，不受这个开关影响。
- **不升版本号**（仍为 2）。判据见 SPEC §7.4：只有当「老程序读新文件会得到不同结果」时才升；
  纯新增可选字段、缺省值等于旧行为的，不升 —— 升版本会让老程序**拒绝整份工程文件**，
  为一个后缀写法把用户的工程挡在门外，代价远大于收益。

**`dimSuffix` 是可缺省字段，这一条不能改成必需。** `library.js` 读 `localStorage` 时
**直接调 `validateSongShape`、不走迁移**；一旦把它设成必需，用户已存的每一首歌
都会在下次打开时被判为损坏并隔离。有一个专门的回归测试钉住这件事（§4.10）。

### 1.9 阶段三收尾追加：记谱风格四项 + 输入别名（2026-09-22）

用户拍板「继续放开记谱法剩下的决策点」，于是把 §8.2 里除 **G** 之外的争议点一次性放开。
流程没变：**先改 SPEC 再改实现**；**缺省值逐一等于各自引入之前的观感**。

新增四个 `layout` 字段，**全部可缺省**：

| 字段 | 取值 | 缺省 | 作用范围 | 决策点 |
| --- | --- | --- | --- | --- |
| `chordSymbols` | `common` / `jazz` | `common` | **和弦名**的性质后缀（`Cmaj7` ↔ `CΔ7`） | A |
| `accidentalGlyphs` | `glyph` / `ascii` | `glyph` | **和弦名与调号**（`F♯m` ↔ `F#m`） | B |
| `seventhSuffix` | `subscript` / `plain` / `superscript` / `parens` | `subscript` | **级数行**的属七后缀 | C |
| `restText` | `cn` / `dash` / `R` | `cn` | **休止符**写成什么字 | F |

外加两件与「显示」成对的事：

- **输入别名（决策点 H）**：屏幕上能显示出来的写法，输入框里必须打得进来。
  `CΔ7` `C-7` `C°` `C+` `CM7` `Co` 现在都是**合法输入**，解析后归一成同一份音乐事实。
  这条不改数据 —— 打进去的是写法，存下来的仍然只有 `root` / `quality` / `bass`。
- **文本导出跟随符号体系（决策点 I，部分放开）**：导出的文本里，**性质后缀**跟着
  `chordSymbols`（爵士体系导出 `CΔ7`），但升/降号、`R`、`0` 不跟随 —— 那些是**语法记号**，
  跟着显示偏好变会让同一首歌导出两种不同的文本语义。

**四条边界，每一条都对应一个具体风险：**

1. **`parens` 是唯一会改变 `value` 的一档。** 另三档（角标 / 连写 / 上标）只切 `parts` 的
   `script` 字段，`value` 恒为 `57`；`parens` 的 `value` 就是 `5(7)`。所以它不能和其他档
   当成同一类「纯排版」处理 —— 读屏、文本往返都按 `value` 走。
2. **`accidentalGlyphs` 不作用于级数行。** 级数里的 `#4` / `b7` 那个 `#` `b` 是**级数限定符**，
   属于级数记法本身，不是音名升降号。改它会让所有已有谱子的级数行外观都变。
3. **`restText` 刻意没有 `0` 这一档。** `0` 在本工具的文本语法里已经是**空白小节**的记号
   （SPEC §2.4）。同一个字形不能有两个意思 —— 简谱里 `0` 确实是休止符，但那是另一套语法，
   混进来只会让人分不清「没排」和「要求不发声」。
4. **G（角标适用范围）仍然不做。** 属七角标只对属七生效，小七 / 大七不跟着标。
   `CHORD_QUALITIES` 里的 `SEVENTH_QUALITY_IDS` 就是这一条的落地点，**不是漏改**。

`°` 现在有两个来源，**必须分清**：设置里选 `dimSuffix = °` 是**级数记法**（`7°` / `vii°`）；
在文本里打 `C°` 是**和弦性质写法的别名**（归一成 `quality: 'dim'`）。前者不改和弦名，
后者不改级数行 —— 这正是 §8.2 里 J 与 A 要分开列的原因。

**仍然不升 `schemaVersion`（2）。** 四个字段都是纯新增可选字段、缺省值等于旧行为，
SPEC §7.4 的判据没有被触发。**而这四个字段同样不能改成必需** —— 理由与 `dimSuffix` 完全相同
（`library.js` 不走迁移），所以 `validateSongShape` 用一张 `optionalStyleFields` 表循环校验，
`updateSongMeta` 用一张 `styleFields` 表循环写严格校验，**两侧都用表而不是逐个字段手写**，
就是为了不让某一次新增漏掉容错方向。

**这一轮顺手发现并修掉的验证工具问题**（都不是本轮引入的）：

1. `.verify/cdp-verify.mjs` 与 `.verify/cdp-check4.mjs` 仍在用 `.ev__symbol` ——
   那个类名在「显示行」那一轮就改名成 `.ev__lines` / `.ev__line` 了（§2.2.1 记着），
   但这两个脚本没跟着改。结果：前者探针读到 `null` 直接抛异常挂掉，
   后者静默报告「级数模式下没有角标」等 7 项失败。**两个脚本都是「显示行」改造后一直坏的**，
   与记谱风格这轮无关。已修（`displayMode` 也一并改成 `displayLines`），现在都通过。
2. 新写的专项脚本自己也踩了两个坑，记在脚本注释里：
   - `localStorage.clear()` + reload **是无效的** —— 应用注册了 `beforeunload` → `store.flushSave()`，
     页面卸载时会把内存里整份曲库写回去。要在 `about:blank` 上清源数据。
   - 「解析并应用」会先弹一次确认框（`await confirmDialog`），只点按钮不点「替换」什么都不发生，
     会拿到"操作 ok 但数据没变"的假报告。

### 1.10 界面整理 + 导出打印统一（2026-09-22，第四轮）

用户提出一揽子界面诉求（就地编辑、歌词、导出打印合一、找谱、竖屏精简、主题字体），
经澄清后确认本轮**先做「界面骨架整理」这一批纯界面改动，不新增数据概念**：

| 改动 | 落地 | 对应 SPEC |
| --- | --- | --- |
| 导出与打印合成一个入口 | `ui/export.js`：一个面板选 PDF / PNG / 打印，PDF 与 PNG 能勾选页 | §8.4 |
| 自造多页 PDF | `core/pdf.js`：若干张 JPEG + 页尺寸 → PDF 字节，不引依赖，位图化 | §8.5 |
| 左栏信息分层 | `panels.js` 的 `section()` 加 `collapsed`；曲库 / 文本 / 数据默认折叠，「数据」收纳导入导出 JSON + 导出打印 | §9.1 |
| 预览与演出分工 | 演出模式顶栏极简（只留歌名），撤销 / 重做 / 保存状态收起 | §8.7 |

**几个关键取舍（都写进了 SPEC）：**

- **「保存为 PDF」和「浏览器打印」是两条不同的路，都保留、分开命名。** 前者自造 PDF
  换来「手机一键下载 + 能选页」，代价是位图化、文字不可搜索；后者保留矢量文字但
  **不能选页**（分页由浏览器决定）。二选一都满足不了「存得下来、想打第几页打第几页」。
- **自造 PDF 用 JPEG 内嵌（`DCTDecode`），不走 PNG。** PNG 要为「canvas.toBlob 输出 RGB 还是
  RGBA」写两套分支（RGBA 得补 SMask），JPEG 天然无 alpha、一条 filter 就够。0.93 质量在
  深灰字 + 白底 + 细线的谱面上与 PNG 无视觉差。
- **`core/pdf.js` 是纯函数、不碰 DOM**，所以能像其它 `core/` 模块一样在 Node 里直接单测。
  浏览器里真实生成的 370 KB PDF 与单测断言的是同一份字节结构。

**顺手踩到并绕开的验证坑（都记进了 `cdp-export.mjs` 注释）：**

1. 示例曲本身**有时值问题**，点「导出与打印」会先弹确认框 —— 这是产品**正确**行为，
   验证脚本必须先点「仍然导出」，否则拿到"面板没打开"的假失败。
2. PDF 页数统计不能用 `/Type /Page` 子串匹配，它会误把 `/Type /Pages`（页树）也数进去。
   要匹配 `/Type /Page `（带尾随空格）。
3. 外层模板字符串里写正则的 `\b` / `\/` 会破坏字符串（老坑，记忆里记过）——用 `indexOf` 数页。

### 1.11 主题与字体（2026-09-22，第五轮）

用户要「能改字体 + 整个 UI 颜色，UI 颜色也改变导出颜色」。经澄清确认三点：主题是
**全局偏好**（跟设备走，不进歌曲数据）、配色预置**护眼绿 / 黑白 / 纯白三套**、字体
**无衬线 / 衬线 / 等宽三档**。

| 改动 | 落地 | 对应 SPEC |
| --- | --- | --- |
| 配色方案表 | `core/theme.js`：三套色表，键名与 CSS 变量一一对应，是颜色唯一真相 | §9.2 |
| 字体三档 | `core/theme.js` 的 `FONT_STYLES`，全部系统字体、不引外部文件 | §9.2 |
| 全局偏好读写 | `loadPrefs` / `savePrefs`，localStorage 键 `chord-chart-workbench/v1/prefs`，与曲库隔离 | §9.2 |
| 屏幕/打印随主题 | `app.js` 启动 `applyTheme()`：色表写进 `:root` 的 CSS 变量，字体栈写 `--font-sans` | §9.2 |
| 导出随主题 | `png.js` 的 `COLORS` 从写死常量改成「由主题派生的可变引用」，`buildPngPages({theme})` 切换 | §9.2 |
| 设置界面 | 歌曲信息面板末尾加「外观」小节：配色 / 字体两个下拉 | §9.2 |

**关键取舍（都写进了 SPEC §9.2）：**

- **主题不进 `song.layout`、不进工程文件、不跟歌走。** 它是应用层观感，不是音乐事实；
  混进歌曲数据会「分享工程文件时对方被迫看到你的配色」，而且 `library.js` 直接校验
  会让「改主题」这种动作触碰「歌曲被判损坏」的红线。
- **色表是唯一颜色真相**：CSS 变量和 Canvas 的 `COLORS` 都从 `getThemeColors()` 派生，
  渲染代码里不再写死十六进制值。这样「切主题后导出颜色变」是结构上成立的，不是
  「记得同步」的约定。
- **`png.js` 里保留了历史键名视图**（`line` / `lineSoft` / `warn` 三个别名），避免为
  对齐主题键名而逐个改十几处绘制调用 —— 那些键名的语义（深浅线、6/8 提示）和主题
  色表的 `lineStrong` / `line` / `danger` 一一对应，由 `themeView()` 集中做一次映射。

**这一轮踩到并修掉的一个真 bug：**

把 `png.js` 的模块级常量 `COLORS` 改名为小写 `colors` 时，**漏改了十几个内部引用**
（它们仍写 `COLORS.xxx`）。构建能通过（Vite 不做未定义变量的运行时检查）、单测也不碰
绘制路径，所以直到浏览器里真跑导出才暴露 `ReferenceError`。教训：**改名常量时必须先
`grep` 一遍全部引用点**，而不是只改定义那一行。已改回 `COLORS` 大写、保留名字，只把
`Object.freeze({...})` 换成 `let COLORS = themeView(...)`。

### 1.12 歌词（逐字对齐）（2026-09-22，第六轮）

用户这一轮其实提了两件事，分两个层面处理：

1. **演出模式顶栏丢了「回编辑」的路** —— 之前「界面整理」那轮（§1.10）把演出模式顶栏做得
   **极简到只剩歌名**，模式切换（编辑 / 预览 / 演出）被刻意隐藏，用户切进去就找不到出口了。
   这是**上一轮设计的副作用**，不是新需求。本轮把演出模式顶栏恢复成**保留三个模式切换入口**
   （编辑 / 预览 / 演出），只收起撤销 / 重做 / 保存状态 —— 既保住了「台上别分心」的精神，
   又不把人困在演出模式里。

2. **「和弦下方能加文本行」= 之前定的「逐字对齐歌词」**，只是还没动工。本轮开始做，落地如下：

| 改动 | 落地 | 对应 SPEC |
| --- | --- | --- |
| 歌词数据模型 | `bar.lyrics`：按**事件下标**对齐的数组，每项 `{ text } \| null`；可缺省 | §8.9、§2.2 |
| 编辑入口 | 事件面板（点按和弦 / 休止）加「歌词」输入框，只走谱面点按，不进文本语法 | §8.9 |
| 谱面渲染 | 小节框内、事件下方多一行 `.bar__lyrics`，片段用与事件相同的时值比例占位 | §8.9 |
| PNG 导出 | `hasLyrics(song)` 判断整首歌有无歌词，有则每小节框加高 `LYRIC_ROW_HEIGHT`，逐字铺开绘制 | §8.9 |
| 事件与歌词合并一步撤销 | 「改和弦 + 填词」是一次 `run`，一次撤销 | §7.2 |
| 「解析并应用」会清空歌词 | 歌词不进文本语法，文本重写段落会清空歌词 → 确认框里加显式警告 | §8.9 |

**关键取舍（都写进了 SPEC §8.9）：**

- **歌词不独立成实体，挂在 `bar.lyrics` 上用事件下标对齐。** 加一个"歌词实体 + 时间轴"会引入
  一整套新的 ID 管理、对齐校验、克隆逻辑，收益却只是"更灵活"。事件下标对齐已经能表达
  "逐字对齐到和弦"，而且跟着 `cloneBar` / 复制小节 / 复制段落自动走，**零额外克隆代码**。
- **一个片段可以放多个音节，渲染时在事件占的水平空间里均匀铺开** —— 让"字对着和弦"在视觉上
  成立，而不需要用户手动调每个字的 x 坐标（那才是真正的繁琐）。
- **`lyrics` 是可缺省字段，这一条不能改成必需**（与 `dimSuffix` / 四个风格字段同一条红线）：
  `library.js` 读 `localStorage` 直接调 `validateSongShape`、不走迁移，设成必需会让用户已存的歌
  全部被判损坏隔离。整小节清空歌词后字段会被**整个移除**，不留全空数组 —— "有没有歌词"
  始终可由"字段是否存在"判定。
- **歌词不进文本输入语法**（这是用户在上一轮 AskUserQuestion 里拍板的「只在谱面点按编辑」）。
  代价是「解析并应用」会重写段落并清空歌词，这条在 SPEC §8.9 写明、并在确认框里显式警告，
  **不装不知道**。

**验证脚本自己踩的一个坑（记在 `cdp-lyrics.mjs` 注释里）：**

画布尺寸是**固定 A4**（`PAGE` 常量），**永远不会因为内容变**。所以「有歌词 vs 无歌词」不能比
「页数 / 画布尺寸」（它们恒相等），要比**「canvas 上墨迹像素数」**——有歌词时多了两个字的墨迹，
像素数必然更大。第一版脚本比页数，拿到一个"功能没问题、断言却 FAIL"的假失败，改比墨迹后通过。

### 1.13 自由文字块（逐行写 + 自由拖拽）（2026-09-22，第七轮）

用户要的不是「逐字对齐歌词」（§1.12 已做），而是**自由定位的文字块**：把文字一行一行写开，
每个文字块能**手动拖到小节的任意位置**，还能**按小节 / 按和弦两种粒度**写。这是与歌词并存的
另一套机制。

**关键设计决策（AskUserQuestion 拍板 + SPEC §8.10 落定）：**

| 决策 | 结论 |
| --- | --- |
| 拖拽自由度 | **真自由拖拽**，存 `x` / `y` 坐标 |
| 文字块跟不跟和弦 | **跟着和弦走**，用 `anchor` 绑定和弦下标（`-1` = 小节级） |
| 两种粒度 | 一个 `layout.textBlockMode` 开关（`'bar'` 按小节 / `'chord'` 按和弦），切换只改新建块的默认锚点、不动已有块 |

**数据结构（`bar.textBlocks`，可缺省数组）：**

```
textBlock = { id: 'txt_…', text: '副歌第一遍\n转调前', x: 0.5, y: 0.8, anchor: 0 }
```

**最重的一条纪律：`x` / `y` 用 0–1 比例，不是像素。** 屏幕、PNG、打印共用一份坐标，
只有比例才能保证「手机上对好了、导出去不歪」。渲染时拿「小节框实际宽高 × 比例」换算像素。

**跟随调整（`anchor` 的生命周期）：** 删掉和弦 `events[k]` 后，`anchor === k` 的块降级 `-1`、
`anchor > k` 的块前移；交换两个和弦时，绑定到它们的块 `anchor` 互换；设为空白小节时文字块
**保留**（空白小节也能写「间奏」）、anchor 全部降级 `-1`。

**编辑入口**：小节面板里加「文字块」区——新增（`askText` 支持 `multiline` 换行）、改文字、
删除。**拖拽走 Pointer Events**（不是 HTML5 drag & drop，后者触屏不可用，违反 §9），
一次拖拽松手 = 一步撤销（`store.run('移动文字块', …)`）。

**踩的一个坑（记进 `text-blocks.test.js` 的教训）：** `song.js` 里 `normalizeTextBlocksInput`
最初写成了 `createId('txt')`——`createId` 认的是 ID_PREFIXES 的**键名**（`'textBlock'`），
不是前缀字符串 `'txt'`。单测立刻抓到（4 条连锁失败），改成 `createId('textBlock')` 后全绿。
这是「前缀 ≠ 键名」的经典坑，加实体类型时要同时改三处：`ID_PREFIXES`、`createId` 调用点、
`isIdLike` 调用点。

### 1.14 文字块视觉修订：文字栏 + 字号 + 不竖排（2026-09-22，第七轮补丁）

用户实机一看，指出上一版文字块三个「看不清 / 没处待 / 会竖起来」的问题，三条都是
明确的视觉判断，直接改、没再问：

| 问题 | 上一版 | 这一版 |
| --- | --- | --- |
| 没处待 | 文字块 `translate(-50%,-50%)` 飘在小节框**正中间**，压着和弦 | 默认 `y = 0.8` 落到**下方文字栏**；`.bar--has-text` 底部预留 `padding-bottom`，字有明确的落脚点 |
| 会竖起来 | `.textblock` `word-break: break-word` + `max-width: 92%`，长文本自动折行、一字一竖 | `white-space: nowrap`，字**横着延伸**，只有手动回车才换行 |
| 字太小 | `.textblock` `font-size: 0.72em`，比和弦还小 | `1.15em` + `font-weight: 600`；PNG 导出用和弦主行同档 `symbolSize`。**字是主角，和弦可以小，字不能小** |

**改到的文件：** `styles.css`（`.textblock` / `.textblock__line` / `.bar--has-text`）、
`chart.js`（`renderBar` 加 `bar--has-text` class 判断）、`sheets.js`（新增块默认 `y: 0.8`）、
`png.js`（文字块字号 `12` → `symbolSize`，`textBaseline` middle → top，顶部对齐往下长）。

**验证：** 新增专项脚本 `.verify/cdp-textstyle.mjs`（8 项，全过）：
默认 y ≈ 0.8 落到下方、字号 ≥ 16px 且 ≥ 和弦主行 85%、`.textblock` / `.textblock__line`
都是 `nowrap` 不竖排、`.bar--has-text` 底部预留文字栏、导出有墨迹、零运行时错误。
顺带修了 `cdp-textblocks.mjs` / `cdp-textstyle.mjs` 的**测试隔离**问题——两个脚本共享
localStorage，前一脚本新增的文字块会污染后一脚本的「缺省」断言；现在各自用
`store.clearStorageAndRestart()` 清库后再跑。

---

## 2. 改动了哪些文件

### 2.1 新增（阶段三）

| 文件 | 说明 |
| --- | --- |
| `src/ui/dom.js` | 安全 DOM 构造与常用控件 |
| `src/ui/dialogs.js` | 提示 / 确认 / 输入 / 底部面板 |
| `src/ui/store.js` | 状态层：单一数据源、撤销栈、自动保存 |
| `src/ui/chart.js` | 谱面渲染（屏幕 / 打印 / PNG 共用） |
| `src/ui/sheets.js` | 点按面板（和弦 / 小节 / 段落） |
| `src/ui/panels.js` | 侧栏面板（歌曲信息 / 曲库 / 文本 / 工程） |
| `src/ui/png.js` | Canvas 手绘 PNG 导出 |
| `src/ui/app.js` | 装配层 |
| `tests/ui-dom.test.js` | DOM 工具的防呆契约（4 条） |

### 2.1.1 新增（阶段三收尾：显示行，2026-09-21）

| 文件 | 说明 |
| --- | --- |
| `tests/migration.test.js` | v1 → v2 数据迁移（12 条）：老文件能救回来、旧字段不写回、迁移是纯函数 |
| `tests/display-lines.test.js` | 显示行（16 条）：容错 / 严格两种规整，`eventDisplayLines` 这个唯一显示关口 |

### 2.2 重写 / 修改（阶段三）

| 文件 | 改了什么 |
| --- | --- |
| `src/main.js` | 重写：只做挂载 + 启动失败兜底（失败时把错误栈直接显示在页面上，而不是白屏） |
| `src/styles.css` | 重写：完整样式 + 响应式断点 + `@media print`（A4、去控件、小节不跨页） |
| `index.html` | 注释改为「用内存里那一份歌曲数据渲染」 |
| `docs/SPEC.md` | 补 §8.2 的窄屏折行规则、§9 的 44px 与比例规则如何共存、§11 第 7 条（PNG 依赖已定） |
| `README.md` | 进度、目录结构、怎么用、依赖说明、备份说明 |

**`src/core/` 一行未改** —— 阶段二的逻辑层原样复用，这也反过来验证了那层抽象的边界
划得对：接界面没有逼着核心逻辑让步。

### 2.2.1 重写 / 修改（阶段三收尾：显示行，2026-09-21）

| 文件 | 改了什么 |
| --- | --- |
| `src/core/constants.js` | `SCHEMA_VERSION` 1 → 2；`displayMode` 字符串换成 `displayLines` 数组；新增 `normalizeDisplayLines` / `isDisplayLinesValid` / `DEGREE_GLYPHS` / `LEGACY_DISPLAY_MODE_TO_LINES` |
| `src/core/degrees.js` | 新增罗马数字字形（`ROMAN_NUMERALS` / 后缀改写表 / 大小写规则）；`pitchToDegreeToken` / `chordToDegree` 多一个 `glyph` 参数；`formatChordForDisplay` 的 `options.line` |
| `src/core/song.js` | 新增 `migrateSong`；`createSong` 读旧字段迁移；`deserializeSongText` **先迁移再校验** |
| `src/core/edit.js` | `updateSongMeta` 校验 + 规范化 `layout.displayLines` |
| `src/core/project.js` | v1 视为**可迁移**而非「版本不支持」；导入时先 `migrateSong` |
| `src/data/sample-song.js` | `displayMode: 'chord'` → `displayLines: ['chord']`；`schemaVersion` 1 → 2 |
| `src/ui/chart.js` | `eventDisplayText` → `eventDisplayLines`（返回多行）；`renderEvent` 渲染 `.ev__lines`；小调跳过级数行时**给出原因** |
| `src/ui/png.js` | 块高随行数增高（`barBaseHeight` + `barHeightPerLine`）；次行 0.86 倍字号 |
| `src/ui/panels.js` | `displayMode` 下拉框换成三个复选框；「至少保留一行」拦截 |
| `src/ui/app.js` | `summarize` 报 `displayLines` |
| `src/styles.css` | `.ev__symbol` → `.ev__lines` / `.ev__line`；新增 `.check-group` / `.check-line` |
| `docs/SPEC.md` | 新增 §6.7（罗马数字级数）、§8.1.1（显示行）；§6.4 / §6.5 / §7.4 / §2.2 / §11 同步更新 |
| `tests/degrees.test.js` | 新增 9 条罗马数字用例；`displayMode` → `line` |
| `tests/edit.test.js`、`tests/project.test.js` | `displayMode` → `displayLines` |
| `tests/parser.test.js` | 新增「文本导出不受显示行影响」 |

**注意：这一轮把 schemaVersion 升到了 2。** 任何写死 `schemaVersion: 1` 的外部工具
都会失效 —— v1 文件仍然能导入（自动迁移），但导出的永远是 v2。
`tests/song-model.test.js` 里用 `schemaVersion: 99` 造坏数据的那两条仍然有效。

### 2.2.2 修改（阶段三收尾，第二增量：减三后缀，2026-09-22）

| 文件 | 改了什么 |
| --- | --- |
| `src/core/constants.js` | 新增 `DIM_SUFFIX_STYLES` / `DEFAULT_DIM_SUFFIX` / `normalizeDimSuffix`（读容错）/ `isDimSuffixValid`（写严格） |
| `src/core/degrees.js` | `chordToDegree` 多第四个参数 `dimSuffix`；后缀改用 `°` 时走同一套切分（**不是角标**） |
| `src/core/song.js` | `LayoutSettings` 新增 `dimSuffix`（标注为**可缺省**）；`createSong` 写入缺省值；校验**接受缺失**、只在存在时判合法性 |
| `src/core/edit.js` | `updateSongMeta` 校验 `layout.dimSuffix`，**写入路径不做 normalize**（拼错就报错，不悄悄改正） |
| `src/ui/chart.js` | `eventDisplayLines` 透传 `song.layout?.dimSuffix`（`undefined` 交给 `chordToDegree` 兜底，兜底只写一处） |
| `src/ui/panels.js` | 排版区新增「减三和弦后缀」下拉框；**只勾和弦名时置灰并说明什么时候生效** |
| `src/ui/app.js` | `summarize` 如实报 `dimSuffix ?? null`（不补默认值 —— 验证脚本要看数据里到底有没有这个字段） |
| `docs/SPEC.md` | 新增 §6.7.1；§2.2 字段表、§7.4（**新增「何时才升版本号」判据**）、§11 第 9/10/11 条同步 |
| `tests/degrees.test.js` | 新增 8 条（缺省等价、两行同时变、非角标、parts 不变式、只改减三、和弦名不受影响、非法值退化） |
| `tests/display-lines.test.js` | 新增 5 条（`normalizeDimSuffix` / `isDimSuffixValid` 的分工、老数据缺字段、透传、脏值兜底） |
| `tests/edit.test.js` | 新增 3 条（写入路径必须报错而不是容错、不碰其他字段、纯函数性） |
| `tests/migration.test.js` | 新增 5 条，其中**第一条是回归**：`validateSongShape` 必须接受缺 `dimSuffix` 的歌 |

**没有升 schemaVersion。** 判据写在 SPEC §7.4，一句话：老程序读新文件会得到不同结果才升。
这一轮是纯新增可选字段，缺省值等于旧行为 —— 升了反而会把老程序挡在门外。

### 2.2.3 修改（阶段三收尾，第三增量：记谱风格四项 + 输入别名，2026-09-22）

| 文件 | 改了什么 |
| --- | --- |
| `docs/SPEC.md` | §2.1 / §2.2 加四个可缺省字段；新增 §5.1.1（和弦性质符号体系）、§5.1.2（升降号字形）、§5.2.1（输入别名）、§8.1.2（休止符写法）；§5.4 不支持写法表**变短**；§6.6 属七后缀由唯一选项变四档；§6.7.1 句号兑现为爵士体系下的和弦名对照；§4.8 新增文本导出符号规则 |
| `src/core/constants.js` | 新增 `CHORD_SYMBOL_STYLES` / `ACCIDENTAL_GLYPH_STYLES` / `SEVENTH_SUFFIX_STYLES` / `REST_TEXT_STYLES` 四张表与 `REST_TEXTS`；新增 `defineStyleField()` 工厂生成 read 容错 / write 严格成对函数（**四个字段共用，避免把容错方向写反**）；`CHORD_QUALITIES` 每条加 `jazzSymbol` + `aliases`；新增 `CHORD_SUFFIX_ALIASES`（按长度降序）与 `getChordSymbol()`；新增 `usesAccidentalGlyphs()`（全应用唯一一处「风格 → 是否用 ♯♭」映射）；`UNSUPPORTED_CHORD_HINTS` 移除 7 条已变成别名的写法，换成真·乐理范围提示（`C°7` / `Cm9` 等） |
| `src/core/chord.js` | `matchQualitySuffix` 改走 `CHORD_SUFFIX_ALIASES`（精确相等，支持别名）；`formatChordSymbol` 加 `symbols` 选项（与 `glyphs` 正交），改用 `getChordSymbol()`；`describeUnknownQuality` 的提示文案跟着改 |
| `src/core/degrees.js` | `SUBSCRIPT_QUALITY_IDS` → `SEVENTH_QUALITY_IDS`（名字对齐它在四档里的角色）；新增 `buildSeventhSuffixPart()` 按四档切 `parts`；`chordToDegree` 加第 5 参数 `seventhSuffix`，**`value` 改为由 `parts` 拼出**（`parts` / `value` 不变式从"两处各累加凑巧相等"变成**结构上必然成立**）；`formatChordForDisplay` 加 `chordSymbols` / `accidentalGlyphs` |
| `src/core/parser.js` | `songToText` 让性质后缀跟随 `chordSymbols`，**升/降号与 `R` / `0` 不跟随**（语法记号） |
| `src/core/song.js` | `LayoutSettings` 加四个可缺省字段；`createSong` 写入缺省值；`validateSongShape` 改用 `optionalStyleFields` 表循环（**缺字段一律合法**） |
| `src/core/edit.js` | `updateSongMeta` 用 `styleFields` 表循环写严格校验（`undefined` = 不改，且**不做 normalize**） |
| `src/ui/chart.js` | `formatKey()` 加 `accidentalGlyphs`（调号也是音名，跟着变）；休止改走 `getRestText()`；`partsToNodes` 支持 `script === 'sup'`；读屏把 `sub` / `sup` 都拆开读 |
| `src/ui/png.js` | `SUBSCRIPT_SCALE` → `SCRIPT_SCALE`；`sizeOf` 按 `script` 判字号；`drawY` 支持上浮（`parens` 走基线） |
| `src/ui/panels.js` | 「记谱风格」子标题下新增四个下拉框；选项文案**刻意不写 `⁷` / `₇` 这类上下标字符**（Unicode 覆盖面不如 `Δ` / `°` / `♯`，画成豆腐块时用户猜不到那一档是什么） |
| `src/styles.css` | 新增 `.deg-sup`（与 `.deg-sub` 并列） |
| `src/ui/app.js` | `summarize` 如实加报四个 `?? null` |
| `tests/parser.test.js` | 「明确拒绝不支持写法」用例移除 `C°` / `C+` / `C-` / `CM7`（现为合法别名），换成 `Cø` / `C°7` / `Cm9` 等乐理范围用例；新增 2 条别名用例（归一、别名不进数据） |

**这一轮把 `parts` / `value` 不变式从「约定」变成了「结构」。** 之前 `value` 是在两处分别累加
出来的，靠人记得同步；现在 `value` 由 `parts.map(p => p.text).join('')` 算出 ——
**想不同步都做不到**。`parens` 那一档之所以敢改变 `value`，正是因为这条不变式是结构性的。

### 2.2.4 修改（第四增量：界面整理 + 导出打印统一，2026-09-22）

| 文件 | 改了什么 |
| --- | --- |
| `docs/SPEC.md` | 重写 §8.4（导出与打印统一入口，三出口 + 选页）、§8.5（自造 PDF 与浏览器打印两条路、位图化取舍）、§8.6（PNG 不变）、§8.7（预览/演出分工表）；新增 §9.1（左栏信息层级）；§11 补第 14、15 条 |
| `src/core/pdf.js`（新） | 纯函数 `buildPdf(pages)`：若干张 JPEG + 页尺寸 → 多页 PDF 字节。不引依赖，位图化。**不碰 DOM，可在 Node 单测** |
| `src/ui/export.js`（新） | `openExportPanel(ctx)`：一个面板选 PDF / PNG / 打印；PDF 与 PNG 复用 `buildPngPages` 分页并支持勾选页；PDF 走 `canvasToBlob(..., 'image/jpeg', 0.93)` + `buildPdf` |
| `src/ui/png.js` | `PAGE` 导出（供 PDF 页面尺寸对齐）；`canvasToBlob` / `safeBaseName` 导出（供 export.js 复用）；`exportPngFlow` 移除（迁到 export.js） |
| `src/ui/panels.js` | `section()` 加 `collapsed`（复用 `details()` 的折叠状态记忆）；`renderProjectPanel` 改名「数据」区，收纳导出工程 / 导入工程 / 导出与打印，默认折叠；曲库 / 文本输入也默认折叠 |
| `src/ui/app.js` | `exportPng` 改指向 `openExportPanel`；`renderTopBar` 演出模式极简（只留歌名）；`openPanelMenu` 的「工程文件与导出」改名「数据」 |
| `src/styles.css` | 新增 `.panel--collapse` / `.export-choice-list` / `.export-choice` 等 |
| `tests/pdf.test.js`（新） | 6 条：空输入拒绝、单页结构、多页 Kids/Count、JPEG 字节原样内嵌、每页独立对象、xref 偏移指向正确对象头 |

### 2.2.5 新增（第五增量：主题与字体，2026-09-22）

| 文件 | 说明 |
| --- | --- |
| `src/core/theme.js`（新） | 三套配色方案（`THEMES`）+ 三档字体（`FONT_STYLES`）+ 全局偏好读写（`loadPrefs`/`savePrefs`，localStorage 键 `chord-chart-workbench/v1/prefs`）。色表是颜色唯一真相，纯函数不碰 DOM |
| `src/ui/png.js` | `COLORS` 从写死常量改成「由主题派生的可变引用」；`buildPngPages(song, {theme})` 入口切换；空白小节硬编码 `#faf9f6` 改用 `COLORS.paperAlt` |
| `src/ui/export.js` | `openExportPanel` 里 `loadPrefs()` 读主题，传给 `buildPngPages`，导出颜色随主题 |
| `src/ui/app.js` | 启动 `applyTheme()`：色表写 `:root` CSS 变量、字体栈写 `--font-sans`；ctx 暴露 `getPrefs`/`setPrefs` |
| `src/ui/panels.js` | 歌曲信息面板末尾加「外观」小节：配色 / 字体两个下拉 |
| `tests/theme.test.js`（新） | 8 条：三套色表齐全且不同、容错读写、写严格、偏好隔离、坏数据退化 |

### 2.2.6 修改（第六增量：歌词 + 演出顶栏，2026-09-22）

| 文件 | 改了什么 |
| --- | --- |
| `docs/SPEC.md` | 新增 §8.9（歌词逐字对齐，数据 / 编辑 / 渲染 / 导出 / 边界）；§2.1 结构树加 `bar.lyrics`、§2.2 Bar 字段表加 `lyrics` 行、§11 加第 16 条决策点、规则落点表加 §8.9、状态行回填 307 条 |
| `src/core/constants.js` | `LIMITS` 新增 `lyricMaxLength` |
| `src/core/song.js` | `Bar` 加 `lyrics`（可缺省）；`normalizeBarInput` / `cloneBar` / `checkBar` 携带并校验 `lyrics`（整段为空 = 无歌词，缺失合法） |
| `src/core/edit.js` | 新增 `setEventLyric(song, sectionId, barIndex, eventIndex, text)`；`cloneBarWithNewIds` 带歌词；`setBarEmpty` 清空事件时一并清空歌词 |
| `src/ui/chart.js` | `renderBar` 加 `renderLyrics(bar, ctx)`：小节框内事件下方渲染 `.bar__lyrics` 行，片段按时值比例占位，全空则不占行 |
| `src/ui/sheets.js` | 事件面板加「歌词」输入框（`aria-label="这个和弦下方的歌词"`，`maxlength=lyricMaxLength`）；「完成」提交时把事件 + 歌词合并进一次 `run`（一步撤销） |
| `src/ui/panels.js` | 「解析并应用」确认框：当歌曲有歌词时，加一句「⚠ 歌词不在文本语法里，这一步会清空已有歌词」的显式警告 |
| `src/ui/png.js` | 新增 `hasLyrics(song)`；`barHeightFor` 有歌词时 + `LYRIC_ROW_HEIGHT`；`drawBarRow` 在小节框底部逐字铺开绘制歌词；`buildPngPages` 分页判断与绘制用同一个 barHeight |
| `src/styles.css` | 新增 `.bar__lyrics` / `.lyric` / `.lyric--empty` 样式 |
| `src/ui/app.js` | 演出模式顶栏恢复三个模式切换入口（编辑 / 预览 / 演出），只收起撤销 / 重做 / 保存状态 |
| `tests/lyrics.test.js`（新） | 13 条：模型可缺省、按事件下标对齐、空位 null、`setEventLyric` 设置 / 清空 / 越界、克隆带歌词、空白小节清空、序列化往返不丢 |

### 2.2.7 修改（第七增量：自由文字块，2026-09-22）

| 文件 | 改了什么 |
| --- | --- |
| `docs/SPEC.md` | 新增 §8.10（自由文字块：数据 / 两种粒度 / 拖拽 / 渲染 / 导出 / 边界）；§2.1 结构树加 `textBlocks`、§2.2 加 TextBlock 字段表、§11 加第 17 条决策点、规则落点表加 §8.10、状态行回填 323 条 |
| `src/core/constants.js` | `LIMITS` 新增 `textBlockMaxLength: 500`；`ID_PREFIXES` 新增 `textBlock: 'txt'`；新增 `TEXT_BLOCK_MODES` / `DEFAULT_TEXT_BLOCK_MODE` / `normalizeTextBlockMode` / `isTextBlockModeValid` |
| `src/core/ids.js` | `createId` / `isIdLike` 的 JSDoc 类型注释补 `'textBlock'`（`collectIds` 已自动收集 textBlocks 的 id 参与查重） |
| `src/core/song.js` | `Bar` 加 `textBlocks`（可缺省）；新增 `normalizeTextBlocksInput` / `cloneTextBlock`；`normalizeBarInput`（含 empty 分支）、`cloneBar`、`checkBar` 携带并校验 textBlocks；`layout.textBlockMode` 可缺省字段 + 校验 |
| `src/core/edit.js` | 新增 `addTextBlock` / `setTextBlockText` / `moveTextBlock` / `removeTextBlock`；`cloneBarWithNewIds` 带文字块换新 ID；`removeEvent` / `moveEvent` / `setBarEmpty` 里实现 anchor 跟随调整；`updateSongMeta` 加 textBlockMode 写入 |
| `src/ui/chart.js` | `renderBar` 加 `renderTextBlocks`（绝对定位浮层）+ `attachDrag`（Pointer Events 拖拽，换算 0–1 比例）；`renderChart` 透传 `onTextBlockMove` |
| `src/ui/sheets.js` | `openBarSheet` 加「文字块」区：新增（multiline）、改文字、删除；新增块按 `layout.textBlockMode` 决定默认 anchor |
| `src/ui/panels.js` | 歌曲信息面板加「文字块粒度」下拉（按小节 / 按和弦） |
| `src/ui/app.js` | import `edit`；`renderPaper` 加 `onTextBlockMove`；新增 `moveTextBlock` 动作（`store.run` 一步撤销） |
| `src/ui/png.js` | `drawBarRow` 里按 x/y 比例坐标绘制文字块（支持 `\n` 换行） |
| `src/styles.css` | 新增 `.bar__textblocks` / `.textblock` / `.textblock.is-dragging` / `.textblock__line` / `.textblock-row` 样式 |
| `tests/text-blocks.test.js`（新） | 19 条：可缺省、合法字段、空白小节允许、非法坐标/锚点拒绝、增改删移、anchor 跟随（删和弦/换和弦/设空白）、克隆换新 ID、序列化往返、textBlockMode 开关（缺省/改值/往返） |

### 2.3 临时验证工具（不属于交付物）

`.verify/` 目录（在 `.gitignore` 内，可随时删除）：

| 文件 | 说明 |
| --- | --- |
| `.verify/serve.mjs` | 本地静态服务器（127.0.0.1:8099）。`file://` 页面是不透明源，`localStorage` 一碰就抛，所以必须走 `http://` |
| `.verify/cdp-verify.mjs` | 三档视口测量 + 整页截图 + 真操作一遍。**2026-09-22 修复**：同样卡在已被改名的 `.ev__symbol`，探针读到 `null` 直接抛异常。注意它的 `PROBE` 是模板字符串，**注释里不能出现反引号**（本轮踩过，字符串被截断成语法错误） |
| `.verify/cdp-check2.mjs` | 屏幕 vs 打印媒体下的每行小节数、提示可见性、底栏可见性 |
| `.verify/cdp-check3.mjs` | PNG 导出对时值问题的拦截是否会真的弹 |
| `.verify/summarize.mjs` | 把 JSON 报告摘成人能读的文本（原始报告中文会乱码） |
| `.verify/cdp-shot-*.png` | 三档宽度的整页截图 |
| `.verify/cdpprof/` | Chrome 验证用的 profile 目录（约 58 MB，Chrome 关掉后可直删） |
| `.verify/env-check.mjs` | 环境自检：CDP 端口活着吗、8099 服务的**是不是本次构建**（旧服务器会把旧产物喂给验证脚本，报告「通过」但什么都没测） |
| `.verify/cdp-lines.mjs` | 显示行专项验证：三档视口 × 默认/三行两种状态，外加宽度高度对拍、顺序、拦截、刷新恢复 |
| `.verify/lines-summary.mjs` | 把 `lines-reports.json` 摘成 ASCII 行（PowerShell 捕获中文会乱码） |
| `.verify/shot-lines.mjs` | 三行 + 属七角标的 5 倍特写（数值证明不了「看起来对不对」） |
| `.verify/probe-degree-sign.mjs` | **码点验证**：`°` 是不是 U+00B0（`assert.equal(actual, '°')` 两边被同样弄坏也照样绿） |
| `.verify/cdp-dim-suffix.mjs` | 减三后缀专项：真点复选框 / 真改下拉框 → 读 DOM 文本 + 码点 + 数据 + PNG 位图对比 |
| `.verify/probe-png-degree-sign.mjs` | **Canvas 缺字检测**：用 png.js 的真实字体栈画 `°` 与一个肯定无映射的码点，像素比对。HTML 能显示不代表 `fillText` 找得到字形 |
| `.verify/diag-events.mjs` | 列出屏幕上所有和弦块的真实文字（用来认清界面字形，别拿猜的字符串去比） |
| `.verify/cdp-dim-persist.mjs` | 减三后缀能不能**存住**：改设置 → 刷新 → 读回。**必须先把视口设成宽屏**，否则设置面板在底部抽屉里、控件不在 DOM 中 → 假失败 |
| `.verify/png-degree-sign.png` | `#4dim/#ivdim` 与 `#4°/#iv°` 的 Canvas 渲染对照，给人眼看 |
| `.verify/storage-probe.mjs` | 读真实 `localStorage`：字节数、信封版本、歌曲版本、**有没有旧字段残留**、实际渲染出几行、`.paper` 上的 `dataset.displayLines` |
| `.verify/cdp-notation.mjs` | **记谱风格四项 + 输入别名专项**（28 项）：缺省态（示例曲 `layout` 里没有这四个字段、画面必须是旧观感）→ 真改四个下拉框 → 读 DOM 文本**与码点**（`Δ` U+0394 / `°` U+00B0 / `♯` U+266F / `—` U+2014）→ 读落盘原始 JSON（**改一项不许顺手补其它三项**）→ 刷新读回 → 打别名（`CM7` / `C-7` / `Co` / `C°` / `C+` / `CM` / `CΔ7`）看归一与「别名不进数据」 |
| `.verify/cdp-check4.mjs` | 属七角标的几何与计算样式（字号比、`vertical-align` 为负、水平右移）、读屏标签、PNG 位图对比。**2026-09-22 修复**：仍在用已被改名的 `.ev__symbol` 与 v1 的 `displayMode` |
| `.verify/cdp-export.mjs` | **导出与打印统一入口专项（14 项）**：左栏信息层级（只有歌曲信息展开）→ 展开「数据」→ 点「导出与打印」→ 三出口 radio + 页选择 → 真生成一份 PDF 并核对字节（`%PDF-1.4` 头 / `%%EOF` 尾 / xref / 页数）。注意点「导出与打印」会先弹时值确认框（示例曲有时值问题），脚本要先点「仍然导出」 |
| `.verify/cdp-theme.mjs` | **主题与字体专项（8 项）**：默认护眼绿 CSS 变量 → 真切「黑白」后 `--accent`/`--bg` 变 → `buildPngPages({theme:'green'})` vs `{theme:'mono'}` 导出的非白像素分布不同（导出随主题）→ 切等宽后 `--font-sans` 变 mono 栈 |
| `.verify/cdp-lyrics.mjs` | **歌词专项（12 项）**：缺省无歌词 → 点按和弦出「歌词」输入框 → 填词后谱面出 `.bar__lyrics` → 落盘 `lyrics` 对齐事件下标、空位 null → 刷新后还在（持久化）→ 有歌词 vs 无歌词的 canvas **墨迹像素数**不同（导出真画进去了）→ 清空归零。**注意不能比页数/画布尺寸**（画布是固定 A4，永不因内容变），要比墨迹像素 |
| `.verify/cdp-textblocks.mjs` | **文字块专项（11 项）**：缺省无块 → 小节面板「新增文字块」→ 谱面出 `.textblock` → 落盘 x/y/anchor → **Pointer 事件模拟拖拽后 x/y 变化并落盘** → 刷新后还在（持久化）→ 删除归零 → 有块 vs 无块的 canvas 墨迹像素数不同 → 零运行时错误 |
| `.verify/cdp-textstyle.mjs` | **文字块视觉专项（8 项）**：默认 `y≈0.8` 落到下方文字栏（非居中 0.5）→ 字号 ≥16px 且 ≥ 和弦主行 85% → `.textblock`/`.textblock__line` 都是 `nowrap` 不竖排 → `.bar--has-text` 底部预留文字栏 → 导出有墨迹 → 零运行时错误 |

---

## 3. 怎么启动和验证

### 3.1 启动

```bash
npm install
npm run dev        # http://localhost:5173
```

### 3.2 自动化检查

```bash
npm test           # 307 条测试
npm run build      # 生产构建，产出 dist/
```

### 3.3 浏览器验证（三档宽度）

```bash
npm run build
node .verify/env-check.mjs            # 先自检：CDP 活着吗？8099 服务的是本次构建吗？
node .verify/serve.mjs &              # 起在 127.0.0.1:8099
# 另开一个终端，起带调试端口的 Chrome：
"C:/Program Files/Google/Chrome/Application/chrome.exe" --headless=new --disable-gpu \
  --no-sandbox --no-proxy-server --remote-debugging-port=9222 \
  --user-data-dir="F:/AI写功能谱。/.verify/cdpprof" about:blank
node .verify/cdp-verify.mjs           # 测量 + 截图 + 真操作（阶段三那套）
node .verify/summarize.mjs            # 看摘要
node .verify/cdp-check2.mjs           # 屏幕 / 打印对比
node .verify/cdp-check3.mjs           # PNG 导出拦截
node .verify/cdp-lines.mjs            # 显示行专项（默认 / 三行 × 三档视口）
node .verify/lines-summary.mjs        # 显示行摘要
node .verify/shot-lines.mjs           # 三行 + 角标特写
node .verify/cdp-notation.mjs         # 记谱风格四项 + 输入别名专项（28 项，看退出码）
node .verify/cdp-dim-persist.mjs      # 减三后缀持久化（看 report.verdict）
node .verify/cdp-export.mjs           # 导出与打印统一入口 + 真生成 PDF（14 项，看退出码）
node .verify/cdp-theme.mjs            # 主题与字体专项（8 项，看退出码）
node .verify/cdp-lyrics.mjs           # 歌词专项（12 项，看退出码）
node .verify/cdp-textblocks.mjs       # 自由文字块专项（11 项，看退出码）
```

> **`env-check.mjs` 不是可选项。** 上一轮的静态服务器可能还活着，它服务的是 `dist/`；
> 如果没重新构建，它会把**旧产物**喂给验证脚本，于是脚本报「全部通过」，
> 而你刚改的东西根本没被测到。这个坑在本轮真实存在过（8099 上确实是上一轮的服务器）。
```

---

## 4. 哪些检查已经实际通过

### 4.1 测试：326 条，全部通过（2026-09-22 实跑）

```
# tests 326
# suites 4
# pass 326
# fail 0
```

阶段三的 219 条全数保留且仍然通过。七次增量共新增 107 条：

| 新增分组 | 条数 | 盯的是什么 |
| --- | --- | --- |
| 罗马数字级数（`degrees.test.js`） | 9 | §6.7 对照表逐行、两种字形一一对应、大小写与 `m` 后缀吸收、角标规则、斜杠低音 |
| 数据迁移（`migration.test.js`） | 12 | v1 能救回来、旧字段不写回、纯函数、`meta` 报源文件版本、真正不支持的版本仍被拒 |
| 显示行（`display-lines.test.js`） | 16 | 容错 / 严格两种规整、顺序固定、至少一行、休止只占一行、`layout` 缺失也不崩 |
| 文本导出不受显示行影响（`parser.test.js`） | 1 | 切到三行并行，导出的文本逐字不变 |
| **减三后缀（第二轮增量）** | **21** | 见下 |
| **输入别名（第三轮增量）** | **2** | 别名一律接受并归一成同一 `quality` id；别名只影响解析、不进数据（打 `CΔ7` 存下来就是 `{root, quality, bass}`） |
| **PDF 生成（第四轮增量，`pdf.test.js`）** | **6** | 空输入拒绝、单页结构（头/xref/trailer/startxref）、多页 Kids/Count、JPEG 字节原样内嵌、每页独立对象、xref 每个偏移指向正确的对象头 |
| **主题与字体（第五轮增量，`theme.test.js`）** | **8** | 三套色表齐全且不同、读容错退回缺省、写严格只认表里值、`getThemeColors`/`getFontStack` 稳定引用、`normalizePrefs` 对半个对象容错、偏好键与曲库键隔离、坏数据/无 storage 退化 |
| **歌词（第六轮增量，`lyrics.test.js`）** | **13** | 模型可缺省、按事件下标对齐、空位 `null`、`setEventLyric` 设置/清空/越界/超长、克隆带歌词、空白小节清空、序列化往返不丢 |
| **自由文字块（第七轮增量，`text-blocks.test.js`）** | **19** | 可缺省、合法字段、空白小节允许、非法坐标/锚点拒绝、增改删移、anchor 跟随（删和弦/换和弦/设空白）、克隆换新 ID、序列化往返、textBlockMode 开关 |

第三轮那次改动里有一条**不是新增、而是改判**的用例：`tests/parser.test.js` 的
「明确拒绝不支持写法」原本断言 `C°` / `C+` / `C-` / `CM7` **报错**，而本轮它们变成了合法别名
（§5.2.1）。已把这几条换成**真的不支持**的写法 —— `Cø`（半减七）、`C°7`（减七）、`Cm9`（扩展音）
——它们至今仍然明确报错，而且报的是**乐理范围**而不是「格式看不懂」。

> 这类「语义变更导致的测试翻转」值得单独留意：**它和"改坏了"长得一模一样**。
> 区分办法只有一个 —— 翻的那条是不是**本轮有意放开的行为**。是，就改断言；
> 不是，那就是回归，必须查。（本轮是前者，但要每次都问一遍这个问题。）


减三后缀那 21 条分布是：`degrees.test.js` 8 条（缺省等价于旧行为、数字行与罗马行**必须同时变**、
`°` 不是角标、`parts` 不变式、只改减三不动其他性质、和弦名永远 `Bdim`、非法值退化成缺省）、
`display-lines.test.js` 5 条（读容错 / 写严格的分工、老数据缺字段照常渲染、透传到每一行、脏值兜底）、
`edit.test.js` 3 条（**写入路径必须报错而不是容错**、不碰其他字段、纯函数性）、
`migration.test.js` 5 条（缺字段必须被接受、新歌写全、非法值定位到 `layout.dimSuffix`、
完整导入链路不被偷偷补值、迁移不凭空造字段）。

其中 `migration.test.js` 的**第一条是回归**，理由值得单独写下来：

> `library.js` 读 `localStorage` 时**直接调 `validateSongShape`、不走迁移**。
> 谁把 `dimSuffix` 改成必需字段，用户已存的每一首歌都会在下次打开时被判为损坏并隔离。
> 测试跑不出来，代价就是用户全部的歌。

覆盖范围（SPEC §10 的 8 项自动检查）与阶段二相同，另有阶段二已记录的
纯函数性、ID 唯一性、错误码归属、损坏数据保护等分组，见下文不再重复。

### 4.2 构建

`npm run build` 成功（exit 0）：

```
dist/index.html                   0.59 kB │ gzip:  0.44 kB
dist/assets/index-*.css          21.73 kB │ gzip:  4.92 kB
dist/assets/index-*.js          147.81 kB │ gzip: 49.07 kB │ map: 606.10 kB
```

比上一轮（歌词那轮，139.49 kB JS）多出约 9.6 kB JS，来自第七轮（自由文字块）的
`addTextBlock` / `moveTextBlock` / `renderTextBlocks` / `attachDrag` / textBlockMode 等。
CSS 涨 0.86 kB，是 `.textblock` / `.textblock-row` 样式。

`npm test` 326 条全绿（新增 19 条 `text-blocks.test.js`）。浏览器验证新增
`cdp-textblocks.mjs`：11 项断言全过，零运行时错误。

### 4.3 浏览器实际渲染（Chrome 153，CDP 设备模拟）

数据基线是**干净状态**下的示例歌曲（32 小节 / 43 和弦 / 1 休止 / 1 空白小节）。
每个视口都读的是 `window.__chordChart` 暴露的**真实数据**，不是去猜 DOM。

| 检查 | 390px | 768px | 1280px |
| --- | --- | --- | --- |
| 实际视口宽度 | 390 | 768 | 1280 |
| 页面横向溢出 | **无** | **无** | **无** |
| `scrollWidth / clientWidth` | 390 / 390 | 753 / 753 | 1265 / 1265 |
| 布局 | 单栏 + 底部工具条 | 单栏 + 底部工具条 | 双栏（侧栏常驻） |
| 小节 / 和弦 / 休止 / 空白 | 32 / 43 / 1 / 1 | 同左 | 同左 |
| 低于 44px 的**控件** | **0 个** | **0 个** | 见下方说明 |
| 和弦块最小宽 / 高 | 76px / 44px | 79px / 44px | 93px / 44px |
| 游离文本节点（`null` 之类） | 无 | 无 | 无 |
| 运行时错误 | 无 | 无 | 无 |

> **1280px 那一列的「低于 44px」需要解释，别当成缺陷**（2026-09-21 追加显示行控件后）：
>
> 1. **原生复选框本身只有 20×20**，但真正的可点区域是包着它的 `<label class="check-line">`，
>    实测 **350×44**，合格。探针遍历 `input` 时会把复选框本身量进去 —— **是探针量错了元素**。
> 2. **`.btn--small` 在桌面宽度下是 38px**，这是 `styles.css` 里写明的设计决定
>    （`@media (max-width: 1023px)` 才撑到 `var(--tap)` = 44px）。桌面有鼠标，窄屏才需要 44px。
>
> 这两条都不是缺陷：把有意的取舍当 bug 去「修」，比漏掉一个 bug 更糟。

时值 → 宽度（Intro 段 `C:4 | Am:4 | F:2 G:2 | C:4`）：

| 视口 | 每行小节数 | 小节容器宽 | 4 拍事件 | 2 拍事件 |
| --- | --- | --- | --- | --- |
| 390px | **2**（从设置的 4 降档） | 155px | 155px | 76px ×2 |
| 768px | 4 | 161px | 161px | 79px ×2 |
| 1280px | 4 | 190px | 190px | 93px ×2 |

2 拍事件宽度约为「容器宽 − 6px 间距」的一半，**严格按时值比例分配**（§8.2）。

**屏幕 vs 打印（`cdp-check2.mjs`，用 `Emulation.setEmulatedMedia` 切换）：**

| 视口 | 屏幕每行小节 | 打印每行小节 | 折行提示 | 底部工具条 |
| --- | --- | --- | --- | --- |
| 390px | 2 | **4**（回到设置值） | 屏幕显示 / 打印不出现 | 可见（flex, 64px） |
| 768px | 4 | 4 | 无（未降档） | 可见 |
| 1280px | 4 | 4 | 无 | 不显示（宽屏用侧栏，符合设计） |

### 4.4 交互流程（390px 下真跑一遍）

| 操作 | 结果 |
| --- | --- |
| 打开小节面板 | 标题「第 1 小节」、副标题「Intro（1 / 4）」；按钮：＋ 和弦 / ＋ 休止 / 前面插一小节 / 后面插一小节 / 复制这一小节 / 上移 / 下移 / 设为空白小节 / 删除这一小节 |
| 添加和弦 | 预览「将写入：Cm7 · 4 拍」；小节合计提示「本小节合计 8 / 4 拍，超出 4 拍」；级数提示「数字级数显示为 1m7（按 C 大调）」；和弦 43 → 44 |
| 撤销 | 44 → 43，`changed: true` |
| 重做 | 43 → 44，`changed: true` |
| 切演出模式 | 侧栏隐藏、底部工具条隐藏、**可点和弦块 0 个**（不会误触）；切回编辑后 45 个（44 和弦 + 1 休止） |
| 长歌分页 | 14 段 / 92 小节 → **3 页**；每页 2250 × 3183 像素；PNG 数据头合法（`data:image/png;base64,iVBORw0KGg`）；首屏非白像素占比 2.37%（确实画上了东西，不是一张白图） |
| 本地存储 | 25342 字节，2 首歌（阶段三当时读的，库里歌数是 2；v2 下复测见 §4.9） |
| 刷新后恢复 | 标题、32 小节、44 和弦全部原样回来；保存状态显示「已保存」 |
| 全流程运行时错误 | **0** |

### 4.5 PNG 导出对时值问题的拦截（`cdp-check3.mjs`）

SPEC §8.4 要求「对存在时值错误的歌曲，导出前明确提示先处理，不静默导出」：

| 情况 | 实际结果 |
| --- | --- |
| 没有时值问题 | 直接打开「导出 PNG」面板（**不多弹一次确认**） |
| 制造 1 处时值问题后 | 弹出确认框「这首歌还有时值问题」，正文「有 1 个小节的时值不合法……」，明细「`[Intro] · 第 1 小节：这一小节时值总和是 8 拍，比每小节要求的 4 拍多了 4 拍`」，按钮为「取消 / 仍然导出」 |

打印那条路走的是同一套判断（同名确认框），代码在 `ui/panels.js`。
**注：没有实际按下过浏览器打印对话框**，只验证了确认框这一层（见 §5.3）。

### 4.6 阶段三开发中实际发现并修掉的 7 个缺陷

前两条是「只有真浏览器才能发现」的类型 —— 构建不报错、测试全绿，页面却有一个按钮点不动。

| # | 缺陷 | 怎么发现的 | 怎么修的 |
| --- | --- | --- | --- |
| 1 | `panels.js` 漏导入 `details`，**构建不报错**（被当成未定义全局），运行时才 `ReferenceError` | 浏览器验证收集 `console.error` / 异常 | 补上导入 |
| 2 | `png.js` 里残留 `sortPitchText(...)` 调用（改名时漏改一处），导出 PNG 就抛异常 | 同上，跑长歌分页流程时抛出 | 改回 `glyph(...)` |
| 3 | 390px 下和弦块只有 **33px**，违反 §9 的 44px | 浏览器验证测出 `minEventWidth: 33` | 加 `effectiveColumns` 窄屏降档 |
| 4 | **缺陷 3 的修复本身是半成品**：`app.js` 根本没把可用宽度传进渲染器，`chart.js` 的栅格又写死用设置值 —— 两处都错，等于降档逻辑一行都没生效 | 复核代码时发现，重新验证确认 | 两处都改：`app.js` 量宽度传入，`chart.js` 用降档后的列数 |
| 5 | 打印复用同一份 DOM，会把屏幕的降档值印出去（手机上打印变成每行 2 小节），违反「打印按设置」 | 意识到只在屏幕降档不够，主动验证打印媒体 | 拆成 `--cols` / `--cols-print` 两个变量，`@media print` 改回设置值 |
| 6 | 编辑模式下页面底部出现**字面的 `null` 文字**：`paperEl.replaceChildren(chart, null)` —— 原生 `replaceChildren` 不像 `appendChild` 那样拒绝非节点参数，会把 `null` 字符串化成文本节点 | **整页截图里看见的**。探针当时查的是 `.paper` 的 `textContent`，而那个文本节点是它的**兄弟**，查子树永远查不到 | `dom.js` 新增会跳过空值的 `replaceChildren`；补 4 条单元测试钉住契约；探针改成扫整棵树的文本节点 |
| 7 | PNG 导出**没有**按 §8.4 提示时值问题（打印有、PNG 没有） | 逐条核对 SPEC §8.4 时发现 | `exportPngFlow` 加前置确认，并用 `cdp-check3.mjs` 验证真的会弹 |

### 4.7 验证工具自身也修了 3 个问题

工具出错会产出**看起来正常但错误**的结论，比不验证更危险，所以一并记下来：

| # | 问题 | 后果 | 怎么修的 |
| --- | --- | --- | --- |
| 1 | 用 `offsetParent !== null` 判断底栏是否可见 | `.app__bottom` 是 `position: fixed`，而 fixed 元素的 `offsetParent` **恒为 `null`** → 窄屏上明明可见的底部工具条被报成「不可见」，差点当成 bug 去改 | 改用 `getComputedStyle().display` + `getBoundingClientRect()`，并在探针里注释说明原因 |
| 2 | 用 `localStorage.clear()` + 重新导航来「清空后重来」 | 导航会触发 `beforeunload`，而应用的 `beforeunload` 处理器会 `flushSave()` 把**内存里的曲库写回**localStorage —— 等于白清。于是基线上多带了一个和弦（44 而不是 43），所有对比数字都偏 | 改用应用自己的 `store.clearStorageAndRestart()` |
| 3 | 探针注释里写了反引号 | 探针是**模板字符串**，反引号把字符串提前截断 → 整个验证脚本 `SyntaxError` 直接退出，而我把输出重定向到了 `$null`，看到的是一份**上一次的旧报告**，误以为验证通过了 | 去掉注释里的反引号；不再把输出丢进 `$null` |

第 3 条尤其值得记：**验证脚本自己崩掉时，留下的旧报告看起来和成功一模一样。**

### 4.8 属七后缀角标（阶段三交付后追加的产品决策）

用户在阶段三交付后答复：属七和弦级数里的 `7` 不要上标（看着像幂），要**右下角小角标**；
并明确**小七 / 大七不这样处理**。SPEC 已补 §6.6。

改动落在 4 个文件：`core/degrees.js`（把级数切成 `parts`）、`ui/chart.js`（渲染成嵌套 `span`）、
`ui/png.js`（Canvas 逐段绘制）、`styles.css`（`.deg-sub`）。核心约定：

- **`value` 是纯文本、`parts` 是切分，两者拼起来必然相等** —— 文本输入、工程文件、
  剪贴板一律走 `value`，角标只影响绘制。`degrees.test.js` 有专门用例钉住这条不变式。
- **只对属七生效**：小七 `6m7`、大七 `1maj7` 的性质符号里带字母，数字不会连成一片。
  测试对 7 种非属七性质逐一断言「不带角标」，防止以后有人把范围扩大。
- **PNG 那段必须逐段顺序绘制**：`G7/B` 的切分是 `[5][7角标][/7]`，角标**不在末尾**。

实测（`.verify/cdp-check4.mjs`，Chrome 153，1280px，12 项全通过）：

| 检查 | 实测值 |
| --- | --- |
| 和弦名模式下角标数量 | 0（共 44 个事件符号） |
| 级数模式下角标数量 | 2（示例曲里就两个属七） |
| 角标文字 | 全为 `7`，每个事件最多 1 个 |
| 字号 | `18.75px → 12.375px`（66%） |
| `vertical-align` 计算值 | `-3.09px`（**负值 = 下沉**，不是上标） |
| 几何偏移 | 右移 11.8px、下移 7.1px |
| 主文字 + 角标 === 整串文本 | 通过（切分不丢字） |
| 切回和弦名后 | 角标完全消失，无残留 |
| PNG 导出 | 两种模式都能导出合法 PNG，像素哈希不同（证明按级数重画了） |
| 运行时错误 | 0 |

外加两张**肉眼确认**的图（数值对不代表看起来对）：

- `.verify/cdp-shot-subscript-detail.png` — 屏幕上的 `5` + 小 `7` 特写（放大 6 倍）
- `.verify/png-subscript-crop.png` — 导出的 PNG 裁切，角标同样是右下角小字

导出 PNG 时顺带确认了小节内的**细分隔线仍在**（改动绘制逻辑时曾误删过一次，已补回）。

### 4.9 显示行（1–3 行并行）—— 2026-09-21 追加

`.verify/cdp-lines.mjs`（Chrome 153，CDP 设备模拟，三档视口 × 默认/三行两种状态共 6 次探针）。

**核心不变式：「行数只增高、不改宽度」（SPEC §8.2）。** 这条是这一类改动最容易破的地方，
所以用**同一批元素改动前后对拍**的方式验证，两个维度一起看：

| 事件 | 宽度（1 行 → 3 行） | 宽度 delta | 高度（1 行 → 3 行） | 高度 delta |
| --- | --- | --- | --- | --- |
| `ev--chord` | 190 → 190 | **0** | 44 → 78 | +34 |
| `ev--chord` | 190 → 190 | **0** | 44 → 78 | +34 |
| `ev--chord` | 93 → 93 | **0** | 44 → 78 | +34 |
| `ev--chord` | 93 → 93 | **0** | 44 → 78 | +34 |
| `ev--chord` | 190 → 190 | **0** | 44 → 78 | +34 |
| **汇总** | — | `maxWidthDelta = 0` | — | `minHeightDelta = +34` |

宽度 delta 恒为 0、高度 delta 恒为 +34 —— 说明「按时值占位」这条排版规则没有被动摇。

| 检查 | 结果 |
| --- | --- |
| 三档横向溢出（390 / 768 / 1280） | **全部无**，`scrollWidth === clientWidth`（390/390、753/753、1265/1265） |
| 行数分布（三行并行） | `{1 行: 1, 3 行: 43}` —— 43 个和弦各三行，**1 行的那个是休止**（休止本来就只有一行） |
| 行数分布（默认） | `{1 行: 44}` |
| 固定顺序：请求 `roman,degree,chord` | 数据存成 `chord,degree,roman`，DOM 第一行也是 `chord` |
| 每行文字（C 大调实例） | `C / 1 / I`、`Am / 6m / vi`、`F / 4 / IV`、`G / 5 / V` —— 与 SPEC §6.7 表格一致 |
| 复选框尺寸 | 三个 `.check-line` 各 **350×44**（≥44） |
| 「至少保留一行」拦截 | 点掉最后一个勾后 `checked` 回弹为 `true`，数据仍为 `roman`，并弹出说明 |
| 刷新后恢复 | `displayLines = roman`，`dataset.displayLines = roman` |
| PNG 分页 | 1 行 → **1 页**；3 行 → **2 页**（块变高，同样内容需要更多页，符合预期） |
| 实际落盘的数据（`.verify/storage-probe.mjs`） | `layout.displayLines = ['chord','degree','roman']`，**`displayMode` 已不存在**（迁移真的把旧字段丢掉了，不是两份偏好并存） |
| 实际落盘的渲染 | 第一个和弦块内 **3 个 `.ev__line`**，文字 `C` / `1` / `I`，第一个带 `--primary` |
| `.paper` 上的 `dataset.displayLines` | `"chord,degree,roman"` —— 顺序固定，与设置里勾选的先后无关 |
| 本地存储占用 | 6643 字节 / 1 首歌（阶段三旧格式是 25342 字节 / 2 首歌，不可直接比：歌数不同） |
| 游离文本节点 / 运行时错误 | 6 次探针**全为 0** |

> **曲库信封的 `schemaVersion` 是 1，这不是 bug。** `library.js` 里写明
> `LIBRARY_SCHEMA_VERSION` 「与歌曲的 `schemaVersion` 相互独立」—— 外层信封管的是
> 「曲库这个容器长什么样」，内层管的是「一首歌长什么样」。这轮变的只有内层。
> 别看到 `schemaVersion: 1` 就去「修」它。

肉眼确认（数值对不代表看起来对）：

- `.verify/lines-detail.png` — 390px 下 `Dm7 / 2m7 / ii7` 与 `G7 / 5₇ / V₇` 的 5 倍特写。
  确认：主行最大最粗、次行小一档且色淡、三行不重叠、属七的 `7` 在**数字行和罗马行**都仍是右下角小角标、
  `Dm7 → ii7` 的 `m` 被小写吸收。
- `.verify/lines-default-390.png` / `lines-threeLines-390.png` / `lines-default-1280.png` /
  `lines-threeLines-1280.png` 等整页截图。

**这一节没有验证的东西**（老实列出来）：

1. **调式为小调时「级数行被跳过 + 出角标」这条路径，无法通过真实交互触发** ——
   界面里调式选择器是 `disabled` 的（只支持大调）。只有单测覆盖。
2. 同理，小调下「数字级数 / 罗马数字」复选框置灰也只在单测里覆盖。
3. 打印的实际分页仍未验证（只对比了媒体查询的计算值）。
4. PNG 只验证了页数与画布尺寸，没有逐像素核对字型位置。

### 4.10 减三后缀 `dim` / `°` —— 2026-09-22 追加

这一轮的验证重点不是「逻辑对不对」（单测已经钉死），而是**`°` 是不是真的画出来了**。
理由写在 `probe-degree-sign.mjs` 的开头，值得在这里再说一遍：

> 测试里 `assert.equal(actual, '°')` 的**两边如果被同样弄坏**（例如存盘时 U+00B0 变成了
> U+00BA `º` 或 U+25CB `○`），断言照样全绿。**编码损坏这类 bug，断言天生抓不到。**

所以这一轮分三层验证：

**第一层：码点**（`.verify/probe-degree-sign.mjs`）

| 检查 | 结果 |
| --- | --- |
| 运行时阿拉伯输出末位码点 | `[55, **176**]` = `7` + U+00B0 |
| 运行时罗马输出末位码点 | `[118, 105, 105, **176**]` = `vii` + U+00B0 |
| `parts` 后缀段的码点 | `[176]` |
| `constants.js` 里的字面量 | `176` |
| `panels.js` 里的字面量 | `176` |
| 混进来的近似字符 | 只有 `183`（U+00B7 间隔号，是选项文案里**有意**写的分隔符）；**没有** `186`(`º`) / `9675`(`○`) |

**第二层：真实交互**（`.verify/cdp-dim-suffix.mjs`，Chrome 153，1280px）

| 检查 | 结果 |
| --- | --- |
| 只勾「和弦名」时下拉框 | **`disabled: true`**，并给出「勾上数字级数或罗马数字后生效」的说明 |
| 勾上两行级数后 | `disabled: false` |
| 操作方式 | 真点复选框、真改下拉框并派发 `change`，**不是直接改 store** |
| 减三和弦块（Bridge 段 `F♯dim`）三行 | `F♯dim` / `#4dim` / `#ivdim` |
| 改成 `°` 后 | `F♯dim` / `#4°` / `#iv°` |
| 和弦名那一行未被污染 | **true**（`°` 没有渗进和弦名） |
| 两行级数都带上了符号 | **true** |
| 两行级数末位码点 | **都是 176** |
| 切回 `dim` | 完整还原成 `#4dim` / `#ivdim` |
| 落盘数据（`__chordChart.summarize().layout`） | `dimSuffix` 跟随设置变化 |
| 运行时错误 | **0** |

**第三层：肉眼**（`.verify/dim-symbol-zoom.png`，6 倍特写）

确认 `°` 是真字形（顶上的小圆圈），**不是豆腐块**；主行最大最粗、次行小一档色淡、
三行不重叠、`F♯dim` 那一行完全没被碰。

**第四层（补的）：PNG 的 Canvas 缺字检测**（`.verify/probe-png-degree-sign.mjs`）

导出 PNG 走的是 Canvas `fillText`，**它的字体回退规则和 HTML 不同** ——
屏幕上能显示，不保证 Canvas 用同一条字体栈也找得到字形，找不到时它画一个缺字方框
**并且不报任何错**。

检测办法不猜坐标、也不用看图：从 `png.js` 源码里读出**真实字体栈**，
用它分别画 `°` 和一个肯定没有映射的私有区码点 `U+E000`，取像素比对。

| 检查 | 结果 |
| --- | --- |
| `°` 的墨迹像素数 | 44 |
| 缺字方框的墨迹像素数 | 129 |
| `°` 与缺字方框**像素完全相同**？ | **否** — 说明 `°` 有自己的字形 |
| 自检：缺字方框本身画出了东西吗？ | 是（129 > 0）—— 说明这套检测手段**本身有效**。若缺字时 Canvas 什么都不画，第一条判定就失去意义，所以这条自检必须有 |
| PNG 导出在 `dim` / `°` 两种设置下 | 页数相同（2 页），**位图长度不同**（第 2 页 365490 vs 363090） |
| 字体栈 | 直接从源码正则提取，不手抄（手抄的副本会随源码变化而失效，而且失效时不会报错） |

**第四层（补的）：持久化**（`.verify/cdp-dim-persist.mjs`）

「设置里面也能改」隐含一件事：**改完得存得住**。这条路径和「改一下就渲染」完全不同 ——
它要穿过 `store.run()` → 写 `localStorage`（经 `library.js`，**不走迁移**）
→ 刷新 → 读回 → `validateSongShape` → 渲染。**正好穿过那个「设成必需字段就会炸」的地方。**

| 检查 | 结果 |
| --- | --- |
| 改成 `°` 后，`localStorage` 里的原始 JSON | `hasDimSuffix: true`、`dimSuffix: "°"`（歌仍是 `schemaVersion: 2`） |
| 刷新后 | 下拉框 `°`、数据 `dimSuffix: "°"`、减三块渲染成 `#4°` / `#iv°`（末位码点 **176**） |
| 切回 `dim` 再刷新 | 下拉框 `dim`、数据 `dimSuffix: "dim"`、渲染回 `#4dim` / `#ivdim`（末位码点 109） |
| 运行时错误 | **0** |

> 这一轮探针自己也踩了一个坑，记在 `cdp-dim-persist.mjs` 里：**必须把视口设成宽屏**。
> 窄屏（< 1024px）下左侧设置面板在底部抽屉里，抽屉没打开时那些控件**根本不在 DOM 中**，
> `querySelector` 直接返回 `null` —— 脚本会「找不到下拉框」，
> 看起来像功能坏了，其实只是探针站错了屏幕宽度。上一版就是这么拿到一份假失败报告的。

**这一节没有验证的东西**：

1. **没有逐像素核对 `°` 在真实导出 PNG 里的位置**。验证的是「同一字体栈下 `°` 有真字形」
   加「导出位图确实随设置变化」，不是「第 2 页左上角那个 `°` 落在 x=… 处」。
2. 打印（PDF）路径下的 `°` 未单独验证，理由同 §5.1 第 1 条。
3. `°` 的**读屏发音**未处理。属七的 `57` 当初做过读屏空格处理（因为会被连读成「五十七」），
   而 `°` 拼进 `parts` 后是普通文本、读屏会读成「vii 度」之类 ——
   这与可见文本一致，属于字形本身的读音问题，没有改动。
4. `°` 只在**级数行**验证过。和弦名不受影响这一条是单测 + 面板文案钉的
   （浏览器实测里 `F♯dim` 在两种设置下都没变，算是旁证）。

### 4.11 记谱风格四项 + 输入别名 —— 2026-09-22 追加

专项脚本 `.verify/cdp-notation.mjs`，Chrome 153，1280px 宽屏（必须宽屏，理由同 §4.10 末尾）。
**28 项全部通过，退出码 0，零运行时错误。**

这一轮有**四个非 ASCII 字形**要验（`Δ` U+0394 / `°` U+00B0 / `♯` U+266F / `—` U+2014），
其中三个是**新引入**的 —— 所以仍然走「读码点」那条路，不靠断言里的字符串字面量。

**第一层：缺省态必须等于旧观感**

| 检查 | 结果 |
| --- | --- |
| 示例曲 `layout` 的键 | `["barsPerRow","displayLines","fontScale"]` —— **四个新字段一个都不在** |
| `summarize()` 四项 | 全部 `null`（**读路径没有偷偷补值**） |
| 和弦名 | `Cmaj7` / `Caug` / `F♯dim`（第二位码点 **9839** = U+266F） |
| 休止 | 「休止」（首字码点 20241 = U+4F11） |
| 只显示和弦名时 | 减三后缀与属七后缀两个下拉框**都是 `disabled: true`** |
| 属七在级数行 | `57`，且**带 `.deg-sub`**（右下角小字，与改造前一致） |

**第二层：真改下拉框 → 读 DOM 文本 + 码点**

| 设置 | 屏幕上的字 | 关键码点 |
| --- | --- | --- |
| `chordSymbols = jazz` | `CΔ7` / `C-7` / `C+` / `F♯°` | `Δ` = **916**、`°` = **176** |
| `accidentalGlyphs = ascii` | `F#°` | `#` = **35**（`♯` 不再出现） |
| `seventhSuffix = parens` | 数字行 `5(7)`、罗马行 `V(7)` | `.deg-sub` 数量 **0** |
| `seventhSuffix = superscript` | 数字行 `57` 但**带 `.deg-sup`**、无括号 | `.deg-sub` 数量 **0** |
| `restText = dash` | `—` | **8212**（U+2014 EM DASH） |

**第三层：落盘 —— 改一项不许顺手补其它三项**

改 `chordSymbols` 之后读原始 `localStorage`：

```
layoutKeys: ["barsPerRow","chordSymbols","dimSuffix","displayLines","fontScale"]
字段存在: { chordSymbols: true, accidentalGlyphs: false, seventhSuffix: false, restText: false }
```

**这一条是整轮里最值得钉的。** 「读取容错」很容易顺手写成「读取时把缺省值补齐」——
那样每改一次设置，所有可缺省字段都会被回填进文件，字段就变成了事实上的必需字段，
而**下一个真的必需字段会把用户已存的歌全部隔离**（§4.10 第一节的雷）。

**第四层：刷新后读回**（这条路径不经迁移）

四项设置（`jazz` / `ascii` / `superscript` / `dash`）全部从 `localStorage` 读回，
下拉框回到对应档位，画面同步回来（`F#°`、`—`、`.deg-sup` 都在）。

**第五层：输入别名**

打进文本框 `CM7 | C-7 | Co | Bbmaj7` / `C° | C+ | CM | CΔ7`：

| 检查 | 结果 |
| --- | --- |
| 解析错误 | **0 条** |
| 归一后的 `quality` 序列 | `maj7,m7,dim,maj7,dim,aug,maj,maj7` —— 与写法一一对应 |
| 根音序列 | `C,C,C,Bb,C,C,C,C` |
| 每个和弦对象的键 | 只有 `bass,quality,root` —— **一点别名痕迹都不留** |
| 刷新一遍再看 | 序列完全相同（没有把 `M7` 写进文件） |

**顺带跑的回归**（这一轮改的是 core 层的显示关口，必须确认没打破旧行为）：

| 脚本 | 结果 |
| --- | --- |
| `cdp-dim-persist.mjs` | `verdict: ALL_PASS` |
| `cdp-check2.mjs`（屏幕 vs 打印） | 无失败，横向溢出 = false |
| `cdp-check3.mjs`（PNG 时值拦截） | exit 0 |
| `cdp-check4.mjs`（角标几何） | **13 / 13**（44 个事件、2 个带角标；`vertical-align = -3.09px` 确实下沉） |
| `cdp-lines.mjs`（显示行） | 6 次探针、0 错误（1 行 / 3 行、顺序固定、至少保留一行都正常） |
| `cdp-verify.mjs`（三档视口） | 390 / 768 / 1280px 均无横向溢出、无游离文本节点、**0 运行时错误**；长歌 14 段 92 小节 → 3 页 PNG |

**这一节没有验证的东西**：

1. **`Δ` / `♭` 没有做 Canvas 缺字检测。** §4.10 给 `°` 做过（`probe-png-degree-sign.mjs` 的
   真实字体栈像素比对），而这一轮新引入的 `Δ`（U+0394）、以及新加进选项的 `—`（U+2014）
   只在 DOM 层验了码点，**没有验 Canvas `fillText` 找不找得到字形**。
   风险不高（两者都在常见字体覆盖范围内，`Δ` 还是希腊字母基本区），但属于未验证。
2. **`chordSymbols` 与 `accidentalGlyphs` 的组合只验了 `jazz + ascii` 这一格。**
   四档 × 两档 = 8 种组合没有穷举。`ascii` 只影响和弦名与调号，`jazz` 只影响性质后缀，
   两者作用面不重叠，所以漏一组组合的风险很低 —— 但这是推理，不是实测。
3. **文本导出的符号跟随只在单测里验过**（`songToText` 跟随 `chordSymbols`），
   没有在浏览器里真的点一次「复制/下载文本」再看剪贴板/文件内容。
4. **`restText = 'R'` 这一档没有实测**，只验了 `cn` 与 `dash`（`R` 是纯 ASCII 单字符，
   与 `dash` 走的是同一条渲染路径）。

### 4.12 歌词（逐字对齐）—— 2026-09-22 追加

专项脚本 `.verify/cdp-lyrics.mjs`，Chrome 153，1280px 宽屏。**12 项全部通过，退出码 0，零运行时错误。**

验证走的是**真实用户路径**（点按和弦 → 改输入框 → 派发 `change` → 点「完成」），不是直接改 store：

| 检查 | 结果 |
| --- | --- |
| 缺省态：数据里没有 `lyrics` 字段 | 通过（示例曲不带歌词，符合可缺省设计） |
| 缺省态：谱面上没有 `.bar__lyrics` | 通过（无歌词不额外占行，谱面不被拉长） |
| 点按和弦 → 事件面板出现「歌词」输入框 | 通过（`input[aria-label="这个和弦下方的歌词"]`） |
| 填「候鸟」→ 数据里出现 1 段歌词 | 通过（`fragments[0] === '候鸟'`） |
| 填「候鸟」→ 谱面出现歌词行且文字正确 | 通过（`.bar__lyrics` 行数 ≥ 1，`.lyric` 含「候鸟」） |
| 落盘：`lyrics` 长度对齐 `events` 长度 | 通过 |
| 落盘：空事件位是 `null`、只填了目标位 | 通过（`texts.filter(t => t != null).length === 1`） |
| 刷新后歌词还在（持久化，经 library.js 不走迁移） | 通过 |
| 刷新后谱面歌词行还在 | 通过 |
| 清空歌词 → 数据归零 | 通过（`total === 0`，字段整体移除） |
| 导出：有歌词 vs 无歌词的 canvas **墨迹像素数**不同 | 通过（歌词真的画进了 PNG，不只是数据里有） |
| 全程零运行时错误 | 通过（0 个异常 / console.error） |

**这一轮验证脚本自己踩的一个坑，值得写下来：**

> **画布是固定 A4 尺寸（`PAGE` 常量），永不因内容变化。** 所以「有歌词 vs 无歌词」不能比
> 「页数 / 画布尺寸」—— 它们恒相等（示例曲加 16px 高、加两个字，既压不满第 2 页，也改变不了
> 固定画布）。第一版脚本比页数，拿到一个「功能没问题、断言却 FAIL」的假失败。
> 正确做法是比**「canvas 上的墨迹像素数」**：有歌词时多了「候鸟」两个字的墨迹，像素数必然更大。
> 这跟 §4.10 给 `°` 做的「缺字检测」同源 —— 验证「画出来了没」，不能靠「尺寸变了没」。

**这一节没有验证的东西：**

1. **歌词在 PNG 里的逐字位置没有像素级核对。** 验证的是「有歌词时墨迹更多」，
   不是「候鸟两个字精确落在第一个和弦下方 x=… 处」。屏幕端（DOM）逐字对齐已验
   （`.lyric` 的 `flex-grow` 按时值比例），但 PNG 端只验了「画进去了」。
2. **歌词与「显示行 / 级数」的叠加排版没有单独验证。** 歌词行加在事件下方、与显示行
   （最多三行）并存时的视觉效果没有逐屏截图核对，只有单测 + 逻辑保证。
3. **歌词在真机软键盘下的输入体验未验证**（同上 §5.3，桌面浏览器无法复现）。
4. **复制小节 / 段落时歌词一并带过去**这条，只有单测覆盖（`cloneBar` / `cloneBarWithNewIds`），
   没有在浏览器里真点一次「复制这一小节」再看歌词是否跟着走。

### 4.13 自由文字块 —— 2026-09-22 追加

专项脚本 `.verify/cdp-textblocks.mjs`，Chrome 153，1280px 宽屏。**11 项全部通过，退出码 0，零运行时错误。**

| 检查 | 结果 |
| --- | --- |
| 缺省态：数据里没有 `textBlocks` | 通过 |
| 缺省态：谱面上没有 `.textblock` | 通过 |
| 小节面板「新增文字块」→ 数据里出现 1 块「副歌第一遍」 | 通过 |
| 谱面出现 `.textblock` 且文字正确 | 通过 |
| 落盘：x/y 在 0–1、anchor = -1 | 通过 |
| **拖拽（Pointer 事件模拟）后 x/y 变化并落盘** | 通过 |
| 刷新后文字块还在（持久化） | 通过 |
| 刷新后谱面文字块还在 | 通过 |
| 删除 → 数据里文字块归零 | 通过 |
| 导出：有块 vs 无块的 canvas 墨迹像素数不同 | 通过 |
| 全程零运行时错误 | 通过 |

**这一节没有验证的东西：**

1. **拖拽只验证了「x/y 变了且落盘」，没有验证「拖到精确像素位置」的视觉准确性。**
   验证脚本用 Pointer 事件派发了固定位移，确认坐标换算链路通；但「手指/鼠标拖到哪、
   块就精确落在哪」的逐像素对拍没有做（真机手势 + 截图核对）。
2. **`layout.textBlockMode` 的「按小节 / 按和弦」开关已在设置面板落地**（歌曲信息 → 文字块粒度），
   切换只改新建块默认锚点、不动已有块。但**「按和弦写」时新建块默认绑到第一个和弦**这个行为
   只在单测 + 逻辑里保证，没有在浏览器里真点一次「按和弦模式 → 新增文字块 → 看 anchor = 0」。
3. **文字块在「显示行 / 级数」并存时的视觉重叠没验证**（同 §4.12 未验证第 2 条）。
4. **真机触屏拖拽没验证**（Pointer Events 理论上触屏可用，但桌面 CDP 只模拟了鼠标）。

**视觉修订补丁（§1.14）追加验证：** `.verify/cdp-textstyle.mjs` 8 项全过（Chrome 153，1280px），
覆盖默认落到下方文字栏、字号够大、不竖排、文字栏预留高度、导出墨迹。这轮三条视觉诉求
（字有处待 / 字大 / 字不竖起来）都已在真实浏览器里验证到 computed style 与落盘数据两层。

---

## 5. 已知问题

### 5.1 需要下一阶段注意的

1. **打印/PDF 的实际分页结果没验证过。** 我们验证的是 `@media print` 下计算出的
   栅格列数、控件隐藏、以及 `break-inside: avoid` 等规则**已经生效**；
   但**没有真的按下打印对话框**、也没有检查 Chrome 的打印预览产出几页。
   PNG 那条路是逐页自己算的，已验证到 3 页。

2. **文件下载与文件选择器没有走完整的用户路径。**
   PNG 的 `buildPngPages` + `toDataURL` 已验证产出合法图像数据，
   但**「点下载按钮后文件真的落到磁盘」**这一步没验证；工程导入的
   `<input type=file>` 选择文件流程同理。这两处用的是浏览器标准 API，
   风险不高，但属于未验证。

3. **屏幕常亮（Wake Lock）未验证。** 代码在 `present` 模式尝试申请，
   失败静默降级。它需要安全上下文和用户手势，无头环境里跑不出真实结果。

4. **软键盘避让是近似实现，真机行为未知。** 现在的做法是聚焦后把控件滚到视口中间，
   底部面板的操作按钮是 sticky 的。真机上软键盘弹起时的视口变化没法在桌面浏览器复现。

5. **窄屏折行的边界条件。** 一个小节里挤 **3 个以上等长事件**时，和弦块会低于 44px
   （实测 3 个 4 拍事件 → 49px，仍在 44px 以上；4 个就会低下去）。
   这种小节**本身就违反时值规则**（Σ 拍数超过小节容量），界面上已标红提示。
   这是刻意的取舍：不为了一个已经报错的状态去牺牲正常情况的排版。规则已写进 SPEC §9。

6. **`store.run` 的提交粒度靠调用方自觉。** `change` 事件提交一次是当前约定，
   新增表单控件时要沿用，否则撤销栈会被逐字符撑满。

7. **`layout.barsPerRow` 在屏幕上只是「上限」。** 用户设置的 4 在 390px 上显示为 2。
   如果产品上希望「设置多少就多少，哪怕点不准」，要改 `effectiveColumns` 的判据。

8. 阶段二记录过的 4 个未决问题**仍然未决**（见 §7），实现按 SPEC 当前写法保持不变。

9. **`.verify/cdpprof` 约 58 MB**。Chrome 进程还开着时删不掉，关掉后直删即可，
   不影响任何交付物。

10. **⚠️ 数据格式已升到 `schemaVersion: 2`（2026-09-21）。** 任何写死 `schemaVersion: 1`
    的外部工具会失效。v1 工程文件**仍然能导入**（`migrateSong` 自动迁移，
    `displayMode` 字符串 → `displayLines` 数组），但导出的永远是 v2。
    迁移是**读取时的一次转换**，旧字段翻译完立刻丢弃、永不写回。

11. **并行编辑同一个文件会互相覆盖。** 本轮真实吃过这个亏：对同一文件连发多个编辑，
    工具报「成功」，内容却被并发写覆盖掉了 —— 结果是一串 `xxx is not defined` 的
    SyntaxError 和一个「参数收了但没用」的 bug 潜伏到构建才暴露。
    **规矩：同一个文件串行改，不同文件才可以并行。** 每次改完 `grep` 一下确认真的落地。

12. **「一个参数被接受但从未被使用」这类 bug 很难靠读代码发现。**
    本轮 `pitchToDegreeToken(pitch, tonic, glyph)` 的 `glyph` 一直没被用过，
    罗马字形下照样输出阿拉伯数字。**把 SPEC 表格逐行写成断言**这个动作把它逼了出来 ——
    这也是为什么新功能要先写 SPEC 再写实现。

### 5.2 环境相关的坑（踩过了，记下来）

- **Windows 上 Chrome 无头窗口有最小宽度，实测 512px。**
  `--window-size=390` 拿到的是 512px 视口。必须用 CDP 的 `Emulation.setDeviceMetricsOverride`。
- **`file://` 页面是不透明源，`localStorage` 一碰就抛。**
  所以验证保存/恢复必须起一个 `http://127.0.0.1` 的静态服务器（`.verify/serve.mjs`）。
- **这台机器上 `bash` 的 PATH 是坏的**：`dirname` / `ls` / `grep` 全部 `command not found`，
  连 `cd` 都失败（shell 初始化脚本第一行就报错）。**阶段三全程只能用 PowerShell**。
- **PowerShell 里 `*>` 和 `Out-File` 默认写 UTF-16**，用 `Read` 读会当成二进制文件。
  必须显式 `Out-File -Encoding utf8`，而且**不要**用 `*>` 重定向。
- **PowerShell 捕获子进程输出会把中文变成乱码**（按本地代码页解码 UTF-8）。
  可靠做法是让结果**结构化落到 JSON 文件**，再写一个小脚本摘成 ASCII 数字 + 短文本。
  `.verify/summarize.mjs` 就是干这个的。
- **PowerShell 工具的 stdout 有时不回显**（`Command completed with exit code 0` 但无输出）。
  所以每一步都要把结果写到文件再读，不能靠回显判断成败。
- **不能用 `Start-Process` 之类的命令起图形进程**，浏览器由外部启动，脚本只连调试端口。
- **`.verify/` 下的文件删不掉**：删除走的是「移到回收站」机制，而它在本机直接失败
  （`SAFE_DELETE_FAIL_CLOSED` / `trash-failed`），与 Chrome 是否占用 profile 无关。
  没有绕过它（那是环境的安全机制，不该硬碰）。这些文件都在 `.gitignore` 内，
  需要时**手动删掉整个 `.verify/` 目录**即可。因此这一轮留下了一些一次性日志
  （约 130 KB），不影响任何交付物。

### 5.3 明确标为「未验证」的项

| 项 | 原因 |
| --- | --- |
| **真机** 390 / 768px | 只在桌面 Chrome 的设备模拟下测过，没用真实手机 / 平板 |
| 打印对话框的实际分页产出 | 验证了打印媒体下的 CSS 计算值，没真的走打印预览 |
| 「点下载后文件真的落盘」 | 验证了 PNG 数据合法，没验证下载动作 |
| 工程文件的文件选择器导入 | 同上，`<input type=file>` 的用户路径未走 |
| 曲库里的**多首歌切换**（界面点按） | 数据层有测试、存储里有 2 首歌，但没在界面上真点过切换按钮 |
| 文本输入面板的完整流程 | 解析器的错误定位有测试；界面上「点错误跳到对应位置」没真跑过 |
| 屏幕常亮（Wake Lock） | 需要安全上下文 + 用户手势，无头环境测不了 |
| 真机软键盘避让 | 桌面浏览器无法复现 |
| 6/8 拍号在界面上的呈现 | 数据层与提示文案有测试，界面未实际切换验证 |
| 小调级数显示 | 按 §6.5 明确拒绝，**不是没做完而是有意不做** |
| **小调时「级数行被跳过 + 出「级数不可用」角标」** | 界面里调式选择器是 `disabled` 的（只支持大调），**无法通过真实交互触发**；只有单测覆盖 |
| **小调时「数字级数 / 罗马数字」复选框置灰** | 同上，只有单测覆盖（`display-lines.test.js` 直接构造小调歌曲对象） |
| 显示行在**真实打印**下的排版 | 只验证了屏幕与 PNG；打印分页本身仍未验证（见上） |
| `Δ`（U+0394）与 `—`（U+2014）的 **Canvas 缺字检测** | 只验了 DOM 层码点。§4.10 给 `°` 做过真实字体栈的像素比对，这两个**没做** |
| `chordSymbols × accidentalGlyphs` 的 8 格组合 | 只验了 `jazz + ascii` 一格。两者作用面不重叠，漏格风险低 —— 但那是推理不是实测 |
| **文本导出符号跟随**（`chordSymbols` → `songToText`）的界面路径 | 只有单测；没在浏览器里真点一次「导出文本」再看产出内容 |
| `restText = 'R'` 这一档 | 只验了 `cn` 与 `dash`。`R` 是纯 ASCII，走同一条渲染路径 |
| `seventhSuffix = 'plain'` 这一档的**读屏发音** | 代码里有意不特殊处理（见 `chart.js` 注释：可见文字与音频都是「五十七」，两边一致不算错位）；界面未实测 |
| 新增四个风格字段在**工程文件导入导出**里的往返 | 单测覆盖了 `validateSongShape` 的容错与 `updateSongMeta` 的严格；没有端到端导入一份带这些字段的 `.json` |

---

## 6. 下一步（阶段四）

按需求文档，阶段四应做的事（**等你确认范围**）：

1. 把 §5.3 里那批「未验证」逐条变成已验证，尤其是**真机测试**和**打印实际产出**。
2. 导出能力的收尾：需不需要「导出为可直接双击打开的单文件 HTML」？
3. 需求文档里阶段四若有新功能（如更多和弦性质、移调），需要先改 SPEC 再改实现。
4. 阶段二遗留的 4 个未决问题（§7）越晚改成本越高，建议在这一阶段内定下来。

---

## 7. 待确认与已确认

### 7.1 已确认（2026-09-21）

| 问题 | 决定 | 落实 |
| --- | --- | --- |
| 属七和弦级数写 `57` / `5⁷` / `5(7)`？ | **右下角小角标**（`5` + 小 `7`），不是上标 | 已实现并实测，见 §4.8 |
| 小七 / 大七是否也做角标？ | **不做**，只有属七 | 测试逐条断言 |
| 「艺人」和「备注」两个字段还是一个？ | **保持两个**（`artist` + `notes`） | 无需改动 |
| 窄屏折行（390px 上 4 → 2 小节） | **保留** | 无需改动 |

### 7.1.1 已确认（2026-09-21，显示行这一轮）

| 问题 | 决定 | 落实 |
| --- | --- | --- |
| 记谱法放开到什么程度？ | **只放开两个「有争议」的点**：级数字形（阿拉伯 / 罗马）、显示行并行（1–3 行）。其余保留公认写法 | SPEC §11-9，见 §8.0 |
| 要不要 `displayMode: 'both'`？ | **不要这个枚举值**了，直接升级成 `displayLines` 数组，最多三行 | SPEC §8.1.1 |
| 显示行顺序能不能调？ | **不能**。固定 `chord → degree → roman` | 测试 + 浏览器实测（反着勾也按固定顺序） |
| 显示行存哪里？ | **跟歌走**，`song.layout.displayLines` | 本轮已定，见 §8.3 问题 2 |
| 打印能不能另选一套风格？ | **不能**，屏幕 / 打印 / PNG 共用同一份 | §8.3 问题 3 |
| 输入要不要接受 `Δ7` `-7` `°`？ | **不接受**，仍然只认一套写法。注意这只说**输入**；输出侧后来放开了 `°`，见 §7.1.2 | §8.3 问题 1 |
| schemaVersion 要不要升？ | **升到 2**（`displayMode` 字符串 → `displayLines` 数组）；v1 文件自动迁移，不拒绝 | `migrateSong` + SPEC §7.4 |

### 7.1.2 已确认（2026-09-22，减三后缀这一轮）

用户拍板原话：「**能加进来，设置里面也能改。**」

| 问题 | 决定 | 落实 |
| --- | --- | --- |
| 罗马级数里减三写 `viidim` 还是 `vii°`？ | **两种都支持，做成设置项** `layout.dimSuffix`，取 `'dim'`（缺省）或 `'°'` | SPEC §6.7.1 + 浏览器实测 §4.10 |
| `°` 只改罗马行，还是两行都改？ | **两行同时改**。共用一个值 —— 否则并排会出现 `7dim` 与 `vii°` 并存，像两个不同的和弦 | 测试逐条断言「两种字形必须一起变」 |
| `°` 要不要也改和弦名（`B°`）？ | **不改**。`°` 是**级数记法**的后缀，和弦名永远写 `Bdim`；改和弦名是另一件事（§8.2 决策点 A） | 测试 + 面板文案 + 浏览器实测三重钉住 |
| `°` 要不要画成角标？ | **不要**，全字号。角标规则只给属七的 `7` | 测试断言 `parts` 里两段 `script` 都是 `null` |
| 新增字段要不要升 schemaVersion？ | **不升，仍为 2**。立了一条判据（SPEC §7.4）：只有「老程序读新文件会得到不同结果」时才升 | SPEC §7.4 + §11-11 |
| `dimSuffix` 缺失算不算错？ | **不算**。可缺省字段，缺省等价于 `'dim'` | `library.js` 直接调 `validateSongShape` 不走迁移，设成必需会让用户已存的歌全被隔离 → 有专门回归测试 |

### 7.1.3 已确认（2026-09-22，记谱风格与输入别名这一轮）

用户拍板原话：「**继续放开记谱法剩下的决策点**」（对 §8.2 表里的 A / B / C / F / G / H / I）。

| 问题 | 决定 | 落实 |
| --- | --- | --- |
| 和弦性质符号体系（A） | **放开**：`common`（`Cmaj7` `Cm7` `Cm` `Cdim` `Caug`）↔ `jazz`（`CΔ7` `C-7` `C-` `C°` `C+`），缺省 `common` | `layout.chordSymbols`，SPEC §5.1.1 + 实测 §4.11 |
| 升降号字形（B） | **放开**：`glyph`（`♯ ♭`）↔ `ascii`（`# b`），缺省 `glyph` | `layout.accidentalGlyphs`，SPEC §5.1.2 |
| 升降号要不要也改级数行的 `#4` / `b7`？ | **不改**。那是**级数限定符**，属于级数记法本身，不是音名升降号 | 面板 hint + SPEC §5.1.2 明确写出边界 |
| 属七后缀位置（C） | **放开成四档**：`subscript`（缺省）/ `plain` / `superscript` / `parens` | `layout.seventhSuffix`，SPEC §6.6 |
| 四档里哪一档会改变文本内容？ | **只有 `parens`**（`5(7)`）。另三档只改画法，`value` 恒为 `57` | `parts` / `value` 不变式改为**结构上成立**（`value` 由 `parts` 拼出） |
| 休止符怎么写（F） | **放开**：`cn`（「休止」，缺省）/ `dash`（`—` U+2014）/ `R` | `layout.restText`，SPEC §8.1.2 |
| 休止符要不要加 `0` 这一档？ | **不加**。`0` 在文本语法里已经是**空白小节**的记号，同一个字形不能有两个意思 | SPEC §2.4 + 面板 hint 写明「这是刻意的」 |
| 输入写法（H） | **放开**：`°` `o` `+` `-` `M` `M7` `Maj7` `Δ` `Δ7` 等全部是**合法输入**，归一成同一份音乐事实 | SPEC §5.2.1 + 2 条新测试 + 实测 §4.11 |
| 放开输入会不会放宽支持的**和弦范围**？ | **不会**。放宽的是**写法**不是**和弦**：`Cø`（半减七）/ `C°7`（减七）/ `Cm9`（扩展音）仍然明确报错，且报的是**乐理范围** | SPEC §5.4 表变短，但「不支持」提示换成真·范围提示 |
| 文本导出用什么符号（I） | **部分跟随**：性质后缀跟随 `chordSymbols`；升/降号、`R`、`0` **不跟随** | SPEC §4.8 —— 后三者是**语法记号**，跟着变会让同一首歌导出两种语义 |
| 角标适用范围（G） | **仍不放开**。属七角标只对属七生效，小七 / 大七不跟着标 | `SEVENTH_QUALITY_IDS` 就是这条的落地点，**不是漏改** |
| 新增四个字段要不要升 schemaVersion？ | **不升，仍为 2**。判据复用 SPEC §7.4 | 同 §7.1.2 |
| 四个新字段缺失算不算错？ | **不算**。全部可缺省，缺省值逐一等于各自引入之前的观感 | `validateSongShape` 用 `optionalStyleFields` 表循环；`updateSongMeta` 用 `styleFields` 表循环 —— **两侧都用表，防止某次新增漏掉容错方向** |

### 7.2 仍未答复（都不阻塞任何工作）

| # | 问题 | 当前实现 | 要改的话动哪里 |
| --- | --- | --- | --- |
| 1 | 显示行跟歌走还是全局偏好？ | **已定：跟歌走**（`song.layout.displayLines`）。代价是分享文件时对方看到你的设置 | 要「按人长期生效」得另加一层全局默认，见 §8.3 问题 2 |
| 2 | 小调级数按自然小调还是和声小调推导？ | **未实现**，明确拒绝 | `degrees.js` 的 `resolveTonic` + §6.5 的规则 |

这两条现状都有测试固化（`degrees.test.js` / `edit.test.js` / `display-lines.test.js`），
改动成本小，且不回也不影响任何已交付的功能。

### 7.3 阶段四范围（**需要你定**）

按约定不自动进入阶段四，开始前需要一句话说清范围 —— 候选见上面的 §6。
其中**必须先定**的是「需求里有没有新功能」：有的话要先改 SPEC 再改实现，
否则实现又会跑到规范前面。

**用户已提出一项新功能需求**：把记谱法做成可配置（属七后缀放哪、样式可选可保存）。
完整提案见 **§8**。

---

## 8. 设计提案：可配置记谱法（**已落地一小部分，其余刻意不做**）

> **来源**：用户在阶段三交付后提出 ——「在设置里做很多记谱法，可以调这个七放在哪里，
> 设置里做多种管线，打印的时候也可以做出不同的样式，不确定的写法都可以在设置里
> 多种样式去选择，固定以后可以保存下来，方便不同人群去写自己的谱子。」
>
> **状态（2026-09-22 更新）**：用户先把范围**收窄**并拍板 ——
> 「对于少数有争议的可以做选择性的修改，**其他的就保留公认的想法**，
> 而且最好是罗马数字的这种，还有平时用的那种纯数字的。」
> 随后又拍板「**继续放开记谱法剩下的决策点**」。
>
> 于是分**三轮**落地，累计放开 9 个决策点，只剩 **G**（角标适用范围）保留公认写法。
> 见 §8.0。下面的 §8.1–§8.7 保留为原始分析与工程估算，
> **§8.3 的问题 1（输入要不要放开）已在第三轮拍板并落地**，其余仍作为参考。

### 8.0 实际落地了什么 / 刻意不做什么

实现前先改 SPEC，再动代码 —— 这条流程三轮都没变。**每一轮的缺省值都等于该轮引入之前的观感。**

| 轮次 | 项 | 决策点 | 落地形式 |
| --- | --- | --- | --- |
| 一（09-21） | 级数字形可切换：阿拉伯 / 罗马 | **D** | `displayLines` 里多一个 `'roman'` 取值 |
| 一（09-21） | 显示行并行：和弦名 / 数字级数 / 罗马级数，最多三行 | **E** | `displayMode` 字符串 → `displayLines` 数组；设置里三个复选框 |
| 二（09-22） | 减三和弦的级数后缀：`dim` / `°` | **J** | `layout.dimSuffix`；设置里一个下拉框 |
| 三（09-22） | 和弦性质符号体系：`common` / `jazz` | **A** | `layout.chordSymbols`（`Cmaj7` ↔ `CΔ7`） |
| 三（09-22） | 升降号字形：`♯♭` / `#b` | **B** | `layout.accidentalGlyphs`（只作用和弦名与调号） |
| 三（09-22） | 属七后缀位置：右下角 / 连写 / 右上角 / 括号 | **C** | `layout.seventhSuffix`（四档） |
| 三（09-22） | 休止符写法：`休止` / `—` / `R` | **F** | `layout.restText` |
| 三（09-22） | 输入写法放开（别名） | **H** | `CHORD_SUFFIX_ALIASES`；`CΔ7` `C-7` `C°` `C+` `CM7` `Co` 都收 |
| 三（09-22） | 文本导出符号跟随符号体系 | **I**（部分） | `songToText` 让**性质后缀**跟随 `chordSymbols`；升/降号与 `R` / `0` **不跟随**（语法记号） |
| 四（09-22） | 导出与打印统一成一个入口，能选页 | 新（§8.4） | `ui/export.js`：一个面板选 PDF / PNG / 打印，PDF 与 PNG 能勾选页 |
| 四（09-22） | 自造多页 PDF（不引依赖） | 新（§8.5） | `core/pdf.js`：若干张 JPEG + 页尺寸 → PDF 字节；位图化、文字不可选中 |
| 四（09-22） | 左栏信息分层：默认折叠曲库 / 文本 / 数据 | 新（§9.1） | `section()` 加 `collapsed`；「数据」区收纳导入导出 JSON 与导出打印 |
| 四（09-22） | 预览与演出分工：演出顶栏极简 | 新（§8.7） | 演出模式只留歌名，撤销 / 重做 / 保存状态收起 |

> **J 与 A 是两个独立开关，分在两轮放开 —— 这个顺序是刻意的。**
> J 管**级数记法**的后缀（`7dim` / `7°`），A 管**和弦名的性质符号**（`Bdim` / `B°`）。
> 字形相同、语义不同：第二轮放开 J 时 `B°` 还打不出来；第三轮放开 A 之后 `B°` 才出现
> （要把「和弦性质符号」选成爵士）。**并成一个开关会造出「我只想改级数行，和弦名却跟着变了」**
> —— 那正是「显示偏好渗进和弦数据」的反面教材。

**仍然刻意不做、保留公认写法的（只剩一项）：**

- **G：属七角标只对属七生效**，小七 / 大七不跟着标。
  `core/degrees.js` 的 `SEVENTH_QUALITY_IDS` 就是这一条的落地点，**不是漏改**。

**为什么分了三轮、而不是一次全做（重要，避免以后被当成「拖」）：**

选项越多，两两组合的验证量按平方增长，而**没人会用的组合等于把风险转给用户**。
更关键的是：决策点 **H（放开输入写法）与「只改显示」是两件不同性质的事** ——
放开输入会改**解析器的错误语义**（那一批「不支持」提示从**错误**降级为**别名**），
是一次独立的、更大的改动。它被单独放到第三轮，就是为了让「只改怎么画」和
「改能认什么」这两件事各自有独立的验证与文档，不互相掩护。

**第一轮顺手暴露并修掉的三个真问题**（都不是提案里预见的）：

1. `pitchToDegreeToken` 收了 `glyph` 参数却**从没用过** —— 罗马字形下会照样输出阿拉伯数字，
   等于「罗马行」和「数字行」长得一模一样。测试写出来才发现。
2. `deserializeSongText` 与 `importProject` 直接拿 `validateSongShape` 校验，
   而它要求 `schemaVersion === 2` —— **合法的 v1 老文件会被当成坏数据拒掉**，
   而不是迁移。SPEC §7.4 写的是「先迁移再校验」，代码没照做。已修，并补了回归测试。
3. 小调时级数行被**静默**丢掉（用户勾了「数字级数」，谱面上却一行都没有，还没理由）。
   已改成：跳行的同时给出原因（和弦块上的「级数不可用」角标）。

> 教训：**「一个参数被接受但从未被使用」和「先校验后迁移」这两类问题，
> 单看代码很难发现 —— 是「照 SPEC 把断言写出来」这个动作把它们逼出来的。**

**第三轮顺手暴露并修掉的三个问题**（也都不是本轮改动引入的，详见 §1.9）：

1. 两个验证脚本（`cdp-verify.mjs` / `cdp-check4.mjs`）还在用「显示行」那一轮就改名掉的
   `.ev__symbol`，**自那次改造起一直是坏的** —— 一个抛异常挂掉，一个静默报 7 项假失败。
2. 新写专项脚本时发现：`localStorage.clear()` + reload **无效**，
   因为应用在 `beforeunload` 里把内存整份曲库回写。
3. 同上的脚本还发现：「解析并应用」会先弹确认框，只点按钮不点「替换」不会真的应用
   —— 会产出"操作 ok 但数据没变"的假报告。

> 第二、三条的共性：**验证脚本的最常见失败不是"测出 bug"，而是"什么都没测到却报通过"。**
> 所以每一轮都要问一句「这份报告里，失败和通过分别意味着什么」。

### 8.1 核心原则：风格只改「怎么画」，永不改「存了什么」

这跟 SPEC §6.4（切换显示方式不改原始和弦数据）是同一条原则的延伸。
数据里永远只有**音乐事实**（`root` / `quality` / `bass` / `beats`），
字形、符号体系、角标位置全都属于**渲染参数**。

现有架构天然支持这条，不需要动数据层：`formatChordForDisplay()` 已经是
「数据 → 显示」的唯一关口，屏幕（`ui/chart.js`）和 PNG（`ui/png.js`）都从它取文字。
加一层风格参数即可 —— `core/edit.js`、`core/library.js`、`core/project.js`
里的数据逻辑**一行都不用改**。

### 8.2 代码里的 10 个记谱决策点

（逐个核过代码，不是凭印象列的。**三轮之后，除 G 之外全部放开**：A / B / C / D / E / F / H / I / J 已做成设置项，
只剩 **G** 仍按公认写法写死。）

| # | 决策点 | 现在写死在哪 | 现在的样子 | 现实中的人群差异 |
| --- | --- | --- | --- | --- |
| A | 和弦性质符号体系 | `core/constants.js` 的 `CHORD_QUALITIES[].symbol` / `[].jazzSymbol` | **已放开**：`common`（`maj7` `m7` `m` `dim` `aug` `sus2` `sus4`）/ `jazz`（`Δ7` `-7` `-` `°` `+` `sus2` `sus4`），缺省 `common` | 爵士圈写 `Δ7` `-7` `-` `°` `+`；也有人写 `M7` |
| B | 升降号字形 | `core/constants.js` 的 `ACCIDENTAL_GLYPH_STYLES` | **已放开**：`glyph`（`♯` `♭`）/ `ascii`（`#` `b`），缺省 `glyph`。**只作用于和弦名与调号**，级数行的 `#4` / `b7` 不跟着变 | 有人就要 ASCII 的 `#` `b` |
| C | 属七级数后缀位置 | `core/degrees.js` 的 `buildSeventhSuffixPart()` | **已放开**：`subscript`（缺省，右下角小字）/ `plain`（`57`）/ `superscript`（`5⁷`）/ `parens`（`5(7)`）。**只有 `parens` 会改变 `value`** | `57` 纯文本 / `5⁷` 上标 / `5(7)` 括号 / 角标 |
| D | 级数用阿拉伯数字还是罗马数字 | `core/degrees.js` 的 `pitchToDegreeToken()` / `chordToDegree()` 的 `glyph` 参数 | **已放开**：阿拉伯 `1 2 3 #4 b7` / 罗马 `I ii iii #IV bVII` 二选一（或并行显示） | 学院派 / 爵士常用罗马数字 |
| E | 显示模式 | `core/constants.js` 的 `DISPLAY_LINE_IDS` | **已放开**：`displayLines` 数组，`chord` / `degree` / `roman` 最多三行并行 | 有人想要两者并排（原来 SPEC §11-3 悬着的 `both`） |
| F | 休止符怎么写 | `core/constants.js` 的 `REST_TEXTS` + `getRestText()` | **已放开**：`cn`（「休止」，缺省）/ `dash`（`—` U+2014）/ `R`。**刻意没有 `0` 档** | `—` / `0` / `R` |
| G | 角标的适用范围 | `core/degrees.js` 的 `SEVENTH_QUALITY_IDS = Set(['7'])` | **仍写死：只属七** | 有人想小七 / 大七也统一标记 |
| H | **输入接受哪些写法** | `core/constants.js` 的 `CHORD_SUFFIX_ALIASES` | **已放开**：`°` `o` `+` `-` `M` `M7` `Maj7` `Δ` `Δ7` `maj` `min` 等都是**合法输入**，归一成同一份音乐事实。**放宽的是写法，不是和弦范围**（`Cø` / `C°7` / `Cm9` 仍报错） | 见 §8.3，这条最关键 |
| I | 文本导出用什么符号 | `core/parser.js` 的 `songToText()` | **部分放开**：**性质后缀**跟随 `chordSymbols`（爵士体系导出 `CΔ7`）；升/降号、`R`、`0` **不跟随** —— 它们是**语法记号**，跟着变会让同一首歌导出两种不同的文本语义 | 同 H |
| J | **级数记法里减三的后缀** | `core/degrees.js` 的 `chordToDegree()` 第四个参数 `dimSuffix` | **已放开**：`7dim` / `viidim`（缺省）或 `7°` / `vii°` | 学院派习惯 `°` |

> **J 和 A 长得像，但不是同一件事。** A 管的是**和弦名里的** `dim`（`Bdim` ↔ `B°`），
> J 管的是**级数后缀**（`7dim` ↔ `7°`）。两个开关独立、分在两轮放开：
> 第二轮只有 J 时 `B°` 打不出来；第三轮 A 放开后 `B°` 才出现（需选「和弦性质符号 = 爵士」）。
> **输入别名（H）又是第三件事** —— 它管「能打什么」，让 `C°` 能被解析成 `quality: 'dim'`。
> 三件事各有测试钉住，混在一起会让「显示偏好」渗进「和弦数据」。

### 8.3 三个必须你拍板的架构问题

#### 问题 1：输入要不要跟着放开？

这是「方便不同人群」的关键。**（原状）** `CΔ7`、`C-7`、`C°` 会**报错**。

- **不放开**：显示成 `CΔ7`，用户却只能输入 `Cmaj7` —— 看着一个、打着一个，很别扭。
- **放开**：解析层加别名表，各种体系的写法都能读进来，规范化成同一份音乐事实。

**最初推荐：放开。** 代价是 SPEC 要改 —— 那批「不支持」提示从**错误**降级为**别名**。

> **第一次拍板（2026-09-21）：暂不放开。** 用户当时明确「其他的就保留公认的想法」，
> 那一轮只动了「显示写成什么样」，输入仍然只认一套写法。

> **第二次拍板（2026-09-22）：放开。** 用户明确「继续放开记谱法剩下的决策点」，
> 于是加了 `CHORD_SUFFIX_ALIASES` 别名表，`CΔ7` / `C-7` / `C°` / `C+` / `CM7` / `Co`
> 现在都能打进来、并且**归一成同一份音乐事实**（SPEC §5.2.1）。
>
> **关键：这正是当初坚持把它单独放一轮的理由。** 放开输入改的是**解析器的错误语义**，
> 与「只改怎么画」性质不同 —— 它需要自己的 SPEC 章节、自己的测试（别名归一 + 别名不进数据）、
> 自己的端到端验证（§4.11 第五层）。如果和显示开关混在一轮里做，
> 两边的验证会互相掩护，出问题也说不清是哪一边。

> ⚠️ 注意区分：放开的是**写法**，不是**和弦种类**。半减七 `ø`、减七 `°7`、扩展音 `9/11/13`
> 仍然不在和弦表里 —— 那是「支持哪些和弦」的问题，与本次「怎么写」不是一回事。
> 这一轮**特意把 `UNSUPPORTED_CHORD_HINTS` 里那几条换成了真·乐理范围提示**
> （`Cø` / `C°7` / `Cm9`），就是为了让「不支持的写法」和「不支持的和弦」这两类报错
> 在文案上仍然分得开 —— 否则放开别名之后，用户会以为「连 `Cø` 都认了，那 `Cm9` 应该也行」。

#### 问题 2：风格存哪里？

| 方案 | 存哪 | 换歌要重设吗 | 分享工程文件 |
| --- | --- | --- | --- |
| A 全局偏好（跟人） | `chord-chart-workbench/v1/notation` | 不用 | 对方看到**他自己**的风格 |
| B 跟歌走 | `song.layout.notation` | 要 | 风格跟着文件走 |
| C 两层 | 全局默认 + 歌内可覆盖 | 不用 | 可跟可不跟 |

用户说「方便不同人群去写**自己的**谱子」，听起来是 **A**（按人，一次设定长期生效）；
但「打印也能出不同样式」又要求当场可切。

**推荐：A + 多套命名预设** —— 一份全局风格，另可存若干套命名风格
（如「我的流行谱」「爵士谱」「给学生的简谱」）随时切换。换歌不丢，换风格一键。

> **已拍板（2026-09-21）：B（跟歌走），即 `song.layout.displayLines`。**
> 和 `barsPerRow` / `fontScale` 一样放在 `layout` 里 —— 排版设置本来就都在那，
> 多开一个全局偏好层会让「这首歌怎么排」这件事出现两个来源。
> **代价（必须知道）**：分享工程文件时，对方看到的是**你的**显示行设置；
> 想按人长期生效的话，A 那套「全局默认」得以后再补。
> 判断依据：本轮只加了「显示哪几行」这一个维度，不值得为它引入第二套存储。

#### 问题 3：打印要不要能用另一套风格？

「打印的时候也可以做出不同的样式」有两种读法：

- **(a)** 打印效果跟随当前风格（同一套）—— 简单、可预期。
- **(b)** 打印时能**另选**一套（自己看用爵士、给学生印用简谱）—— 要维护
  「屏幕风格 / 打印风格」两个值，UI 也要多一层。

**推荐先做 (a)**，(b) 留作以后。理由：多一个维度就多一倍组合要验，
而这个需求还没被实际用过。

> **已按 (a) 落地（2026-09-21）**：屏幕与 PNG 读同一份 `layout.displayLines`，
> 没有「屏幕风格 / 打印风格」两个值。打印要另选一套的话，(b) 仍然摆在桌上。

### 8.4 一个不能忽略的副作用：文本往返会「变形」

`parseSongText` ↔ `songToText` 现在是一条往返链。放开输入符号后：

```
用户输入 CΔ7  →  解析成 {root:'C', quality:'maj7'}  →  导出文本时写成 ?
```

- 写 `Cmaj7`：**用户的输入被规范化了**（音乐事实没变，字变了）。
- 写 `CΔ7`（按当前风格）：闭环了，但**切换风格会改变文本输出**。

两种都不算错，但必须**明说**，不能让人以为「我打什么就存什么」。
**推荐后者**（序列化也按当前风格），并在 SPEC 写明「文本输出随风格变化，音乐事实不变」。

> **已按"后者"落地（2026-09-22）**：`songToText` 里**性质后缀**跟随 `layout.chordSymbols`
> —— 爵士体系下 `Cmaj7` 导出成 `CΔ7`。
>
> **但只跟随性质后缀，不跟随升降号 / `R` / `0`。** 这三类是**语法记号**：
> 同一首歌如果因为显示设置不同就导出成 `F♯m` / `F#m` 两份文本，那两份文本的**语义**
> 就不一样了（后者在别的工具里可能读不出来），而它们本应是同一首歌的两种写法。
> 判据：**跟着变会不会改变"这份文本能被什么解析器读进去"** —— 会，就不跟随。
>
> 另外，用户**打进来的写法不会被记下来**（`CΔ7` 与 `Cmaj7` 存下来都是
> `{root:'C', quality:'maj7'}`，导出的文本由**当前风格**决定，而不是回放用户的原文）。
> 这一条是**有意**的：数据里只留音乐事实，不留"用户当时怎么打的"。

### 8.5 工程量（按现有分层估）

| 层 | 要动的文件 | 说明 |
| --- | --- | --- |
| 常量 | `core/constants.js` | 定义风格枚举 + 各体系的符号别名表 |
| 解析 | `core/chord.js` | 别名表接入；`formatChordSymbol` 接受风格 |
| 级数 | `core/degrees.js` | 罗马数字；角标位置由风格决定 |
| 序列化 | `core/parser.js` | `songToText` 接受风格 |
| 屏幕 | `ui/chart.js` | `eventDisplayText` 接受风格 |
| PNG | `ui/png.js` | 跟随同一风格，逐段绘制要支持上标 / 括号 |
| 样式 | `styles.css` | 角标 / 上标 / 括号三种排版的 CSS |
| 设置 | `ui/panels.js` | 新增「记谱风格」面板（预览 + 预设选择 + 另存为） |
| 存储 | 新增 `core/notation.js`（或并入 `library.js`） | 全局风格读写、预设增删改、损坏保护 |
| 状态 | `ui/store.js` | 风格**不属于歌曲**，需要单独一条保存通道 |
| 测试 | `tests/` | 各体系符号的解析对齐、风格切换不改数据、序列化往返 |

> **三轮之后的实际落点**：上面这张表里唯一**没有**按原计划做的是
> 「新增 `core/notation.js` + 全局风格读写 + 预设增删改 + `store.js` 单独一条保存通道」。
> 原因见 §8.3 问题 2 的拍板：**风格跟歌走**（放进 `song.layout`），
> 于是复用已有的那条保存通道就够了 —— 不需要第二套存储、不需要第二套损坏保护、
> 也不会出现「全局默认」和「歌内覆盖」两个来源打架。**少一个模块，少一类 bug。**
>
> 另外「预设 / 另存为多套风格」这一项**没做**，因为拍板的结果是「跟歌走」；
> 真要按人长期生效，那才需要预设层（§8.3 问题 2 的 (b)/(C) 方案仍然摆在桌上）。

### 8.6 建议的落地顺序

1. **先定 SPEC**：把 §5（和弦）、§6（级数）、§8（谱面）里「固定的写法」
   改成「默认写法 + 可配置」。
2. 再动 `core/`（解析别名 + 风格参数）—— 此时**测试能独立跑**，不依赖界面。
3. 接 `ui/chart.js` 与 `ui/png.js`，三档视口 + 打印 + PNG 一起验。
4. 最后做设置界面与预设存储。

**不建议一上来就做 UI** —— 会像阶段三那样逻辑和界面同时变，出问题不好定位。

> 三轮都是**严格按这个顺序**走的（SPEC → core → ui → 验证）。事后看，
> 第 2 步的价值比预期还大：第三轮改的是 `core/` 里最核心的显示关口
> （`formatChordForDisplay` / `chordToDegree`），**280 条测试在接界面之前就把它们钉住了**，
> 所以后面浏览器验证只需要盯「画出来对不对」，不需要再怀疑逻辑。

### 8.7 风险提示

这个功能把 9 处「写死」变成「可配」，**选项越多，两两组合的验证量增长越快**。
建议每类只上少数几档（例如符号体系 2–3 套、角标位置 4 种），
**不要做成无限可调的编辑器** —— 那样每个组合都可能没人测过，等于把风险转给用户。

> **实际控制住了吗？基本控制住了，但有一处没穷举。**
> 三轮下来的档位总数：符号体系 2 × 升降号 2 × 属七后缀 4 × 休止符 3 × 减三后缀 2 × 显示行 7
> —— 全穷举是**不现实的**。所以采取的是「**缺省态 + 单变量切换**」的验证策略：
> 每个开关单独验一遍缺省与各档（§4.11），再看缺省态是否等于旧观感。
>
> **明确的缺口**（已记在 §4.11 末尾）：`chordSymbols × accidentalGlyphs` 只验了
> `jazz + ascii` 这一格。推理上两者作用面不重叠（一个管性质后缀、一个管音名升降号），
> 所以漏格风险低 —— 但那是推理，不是实测，写在这里免得以后被当成已验证。
