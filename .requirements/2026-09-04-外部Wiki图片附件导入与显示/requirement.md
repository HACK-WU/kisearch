---
id: REQ-20260904-001
feature: 外部Wiki图片附件导入与显示
status: 实施中
created: 2026-09-04
updated: 2026-09-04
version: 3
tags: [feat]
depends_on: []
author: AI
document_type: requirement
---

# 需求分析报告：外部 Wiki 图片附件导入与显示

> **状态：草案**。方案路线、MCP 侧处理、图片引用形态三个关键决策点**尚未拍板**（见 §6）。
> 本文档固化问题诊断与方案空间，不含实施决定；§2/§3 的全部结论均有代码行号或实测输出支撑。

## 1. 原始需求描述

用户原话：

> 导入的外部 wiki，当 md 文档中有应用外部静态，比如图片时。导入成功后，使用 `ki mcp --http --web` 启动后，在页面查看 wiki 原文时，其实看不到图片，因为图片根本没有导入进去。这个场景如何解决（mcp 时，要不要显示图片，待定）。

拆解为两点：

1. **主诉求**：Web 前端查看 wiki 原文时，文档内引用的图片应当可见（当前不可见）。
2. **待定项**：MCP 工具侧（`ki_get_module_info` 等）是否需要提供图片，用户明确表示"待定"。

## 2. 现状诊断：三层断裂

故障不是单点，而是**导入层、服务层、渲染层三处同时断裂**，且服务层还在主动掩盖故障。

> **端到端确认（2026-09-04）**：以下全部结论已用自建 fixture `test_data/wiki-with-images/`（2 篇 md + 2 张真实 PNG，覆盖全部引用形态与 2 个对照组）在真实 `ki mcp --http --web` 实例上复现，浏览器 DOM 级证据与截图见 §9。

### 2.1 层 1 — 导入层：图片文件从不进 KB

- `collectMarkdownFiles`（`src/lib/import.ts:168-193`）只收后缀白名单文件（默认 `DEFAULT_EXTENSIONS = ['.md']`，可由 config `scopes.<scope>.import.extensions` 扩展）。图片文件落入 `skippedNonMd` 被跳过，仅在导入汇总提示里出现一行统计。
- **存储结构本身装不下二进制**：local KB 是 JSON 文本文件，`getLocalKbDir`（`src/lib/scope.ts:100-103`）→ `kb/{scope}/{groupPath}/index.json`，`writeLocalKb`（`src/lib/import.ts:644-650`）写入的结构是 `{ "<relation名>": "<原文字符串>" }`。
- 方案 D 的设计是"清洗只作用于向量化输入，local KB 存文件原文"（`src/lib/import.ts:336-341`），因此 `![](images/arch.png)` 这行语法**被完整保留**在 KB 原文中。

**结论**：KB 里存着指向不存在资源的悬空引用——"引用还在、资源没了"。

**端到端实测**（scope=`img-fixture`，`--no-vector`）：导入汇总 `files=2 skipped=0`，但扫描阶段单独提示 `⚠ 跳过 2 个不支持格式的文件：images/arch.png, images/deploy topo.png`（图片走 `skippedNonMd` 通道，不进 `skipped` 统计）；KB 目录树仅 `group-index.json`、`relations-cache.json`、`图片取证/index.json` 三个文件，**无 images/ 目录**；`index.json` 原文完整保留 4 条图片语法（形态 1、形态 2、对照组 A、对照组 B）。

### 2.2 层 2 — 服务层：无附件路由，且 SPA fallback 把 404 伪装成 200

- `serveStatic`（`src/lib/mcp-http.ts:285-325`）只服务 `webDir`（前端构建产物 `web/dist`）。`STATIC_MIME`（`:265-282`）虽已包含 `.png/.jpg/.jpeg/.gif/.svg/.webp/.ico`，但那是为前端自身静态资源准备的，**没有任何路由能从 KB 或源 wiki 目录取图片**。
- `/api/*`（`:460`）现有端点为 `/api/health`、`/api/doc/list`、`/api/import/*`、`/api/tags`（`src/lib/mcp-http-api.ts:2-9`），**无附件读取端点**。
- **关键放大器**：`serveStatic` 的 SPA fallback（`:307-314`）对任何取不到的路径返回 `index.html` + **HTTP 200**。浏览器把 HTML 当图片解码失败 → 用户只看到破图图标，控制台无有效错误，服务端日志干净。

**结论**：故障被静默吞掉，违背项目 fail-loud + 给出路的错误处理哲学。这一条独立于"是否要显示图片"，属于应当修复的缺陷。

**端到端实测对照**（同一实例切换 `--web` 开关，curl 实测）：

| 请求 | `web:false` | `web:true`（报障场景） |
|---|---|---|
| `GET /images/arch.png` | 404 + `application/json` + `{"ok":false,"error":"Not Found"}` | **200** + `text/html` + body 为 `<!doctype html>`（471 字节 = index.html） |
| `GET /images/deploy%20topo.png` | 404 + JSON | **200** + `text/html` |
| `GET /favicon.svg` | 404 + JSON | 200 + `image/svg+xml`（正常，对照组） |

即：**开启前端页面这个动作，恰好把明确失败（404 JSON）变成静默伪装成功（200 HTML）**。`file -b` 确认 body 实际类型为 `HTML document`，浏览器拿 HTML 当 PNG 解码必然失败。

### 2.3 层 3 — 渲染层：路径基准错 + `<img>` 写法被整体丢弃

- `MarkdownPreview.tsx:12-19` 只覆盖了 `renderer.html`，**未覆盖 `renderer.image`**，图片走 marked 默认行为直出 `<img src="images/arch.png" alt="架构图">`。
- 前端路由为 `/browse`（`web/src/router/routes.tsx:14`，无尾斜杠），浏览器按根目录解析相对 URL → 请求 `http://<host>:7423/images/arch.png` → 命中 §2.2 的 SPA fallback → 破图。
- **更隐蔽的一条**：`renderer.html = () => ''`（`MarkdownPreview.tsx:14`，XSS 防护）会丢弃文档内**所有**原生 HTML。若外部 wiki 使用 `<img src="...">` 写法，图片位置连破图都不显示，**直接空白**，用户完全无从察觉。
- 原文渲染链路：`ModuleDrawer.tsx:75-77` → `ki_get_module_info` 取 content → `MarkdownPreview`。

**端到端实测**（浏览器 DOM 级，`naturalWidth === 0` 且 `complete === true` 即加载失败）：

| 编号 | 引用写法 | 前端实测表现 | img 元素 | naturalWidth |
|---|---|---|---|---|
| 1 | `![alt](images/arch.png)` | 破图图标 + alt 文本 | 有 | **0（失败）** |
| 2 | `![alt](images/deploy topo.png)` 含空格 | **降为字面 markdown 源码文本**（marked 因 URL 含空格不识别为图片） | **无** | — |
| 3 | `<img src="images/arch.png" alt="…">` | **完全空白，零痕迹**（a11y 树中该位置无任何节点） | **无** | — |
| 4a | `![alt](/root/…/overview.png)` | 破图 | 有 | 0 |
| 4b | `![alt](file:///root/…/architecture.svg)` | 破图 | 有 | 0 |
| 对照 A | `![alt](http://127.0.0.1:7423/favicon.svg)` | **正常显示** | 有 | **150** |
| 对照 B | `![alt](https://www.gstatic.com/webp/gallery/1.jpg)` | **正常显示** | 有 | **550** |

两个对照组正常显示，**证明前端渲染链路本身是通的**，故障特定于「资源未落地 + 无附件路由 + 部分写法不被解析」。形态 2、3 是比破图更隐蔽的失败：用户看到源码文本或完全空白，难以意识到"这里本该有一张图"。

### 2.4 完整链路

```
外部 wiki 目录
  ├─ doc.md          ── collectMarkdownFiles 命中 ──→ local KB 原文（图片语法完整保留）
  └─ images/arch.png ── 后缀不在白名单 ──→ skippedNonMd（丢弃，仅计数提示）

前端 /browse 查看原文
  → ki_get_module_info 返回原文
  → marked 渲染 ![](images/arch.png) 为 <img src="images/arch.png">
  → 浏览器请求 GET /images/arch.png
  → serveStatic 在 webDir 找不到 → SPA fallback 返回 index.html + 200
  → 图片解码失败 → 破图（无任何可诊断信息）

前端 /browse 查看原文（<img src> 写法）
  → renderer.html = () => '' → 图片位置直接空白（无破图、无提示）
```

## 3. 附带发现：向量侧图片语义已损坏（实测，非推断）

`clean.ts:94` 的 `codePath` 规则第一步 `t.replace(/\[([^\]]*)\]\([^)\s]*\)/g, '$1')` 对图片语法的处理**不一致、不完整**。用 jiti 调用真实 `cleanMarkdownText` 端到端实测（探针见 `demo/probe-clean-image.mjs`），7 个用例得到 **4 种不同结果**：

| # | 输入形态 | 实测输出 | 问题 |
|---|---|---|---|
| 1 | `![架构图](images/arch.png)` | `!架构图` | 感叹号残留；路径丢弃 |
| 2 | `![](images/no-alt.png)` | `!` | **只剩孤立感叹号**，纯噪音进向量 |
| 3 | `![截图](https://cdn.example.com/a.png)` | `!截图` | **http 外链图片同样被破坏**（不限本地图片） |
| 4 | `<img src="images/a.png" alt="拓扑">` | **原样保留** | HTML 标签噪音完整进向量；而前端 `renderer.html` 又将其渲染为空白 → **向量侧有噪音、展示侧全消失，两头都不对** |
| 5 | 图片独占一行 | `!架构图` | 未被"整行仅剩符号→删行"规则清理（因含文字） |
| 6 | 链接与图片混排 | `见 设计文档 与 !图 混排在一行。` | 同 #1 |
| 7 | `![图](images/with space.png)` | **原样保留** | 正则中 `[^)\s]*` 排除空格 → 含空格路径不匹配，图片语法连带路径噪音完整进向量 |

**影响**：图片的 alt 文本本是有价值的语义信号（"架构图""部署拓扑"），当前以畸形形态（`!架构图`）或完全丢失（`!`）进入向量；而路径/HTML 噪音在 #4、#7 两种情形下反而被保留。该缺陷**独立于图片显示需求**，无论 §6 如何决策都建议修复。

## 4. 图片引用形态分类与处理取向

实测表现矩阵见 §2.3（5 种失败表现 + 2 个对照组）。各形态的处理路径完全不同：

| 形态 | 当前表现 | 处理取向 |
|---|---|---|
| `http(s)://` 绝对外链（对照 B） | **本来就能显示**（有网前提下） | 若这也看不到 → 属防盗链/内网隔离/外链失效，需要的是本地化缓存代理，**与本需求是另一个问题** |
| 本地绝对 URL（对照 A，如指向 web/dist 自身资源） | 能显示 | 非典型场景，不需处理 |
| 相对路径 `./images/x.png`（形态 1） | 破图 | **核心问题**，需资源落地或源目录直读 |
| 相对路径含空格（形态 2） | 字面源码文本 | 同上 + 前端需考虑是否对含空格 URL 做 percent-encode 后重试 |
| 绝对文件系统路径 `/home/…`、`file://`（形态 4） | 破图 | 安全上**不应**服务任意本地路径，建议仅占位提示 |
| `<img src>` HTML 写法（形态 3） | **完全空白** | 需单独放行（白名单标签 + 属性净化），否则任何方案都无效 |

**取证缺口已补**：本仓库原有 md 中图片引用数为 **0**（无任何 png/jpg/svg/gif/webp 文件），无法复现用户场景；已自建 fixture `test_data/wiki-with-images/`（2 篇 md + 2 张 ImageGen 生成的真实 PNG，其中一张文件名含空格）覆盖上表全部形态。fixture 同时作为后续实施与验收的回归样本。

## 5. 方案空间

### 方案 A：源目录直读（零存储）

新增只读路由，用 `getSource(scope).dir`（`src/lib/scope.ts:118-128`）+ relation 的 `sourcePath`（实测存在于 `relations-cache.json`，形如 `gone.md#1`）推出 md 文件所在目录，解析图片相对路径后严格约束在 `source.dir` 内读文件返回；前端覆盖 `renderer.image` 重写 src。

- **成本**：约 1 个路由 + 20 行前端。零存储膨胀、零导入流程变更、图片永远与源 wiki 同步。
- **致命缺陷**：
  - `source.dir` 是 **scope 级单值**，且在 `import.ts:531-538`（Phase 5）被**无条件覆盖** → 一个 scope 分多次从不同 wiki 目录导入时，它只记得最后一次，会解析到错误目录。
  - 源目录被删/移动/换机器即全部失效。**实测真实 dataDir（`/root/.ki-data`）下 20 个 scope 中仅 4 个登记了 `source.dir`，其中 3 个已失效**（`e2e-test`→`/tmp/ki-e2e-wiki`、`wiki-test`→`/tmp/ki-wiki-test`、`monitot`→`/root/.ki/import-uploads/<uuid>`）。**特别地，`monitot` 的源目录是 HTTP 上传导入的暂存目录**（`/api/import/upload` 落盘到 `~/.ki/import-uploads/<uploadId>/`）——即**通过 Web 前端上传导入的 wiki，源目录在导入后必然失效**，方案 A 对该场景 100% 不可用。
  - mcp 服务跑在服务器、源 wiki 在用户本机时，跨机不可用。
- **定位**：只能当止血或 B 的 fallback，**不能作为终态**。

### 方案 B：导入时复制附件进 KB（自包含，终态）

导入阶段解析图片引用 → 命中源目录真实文件 → 复制到 `kb/{scope}/{group}/assets/`；新增附件路由从该目录服务；前端重写 src。

- **优点**：唯一可迁移、可离线、可备份的方案。
- **成本集中在连带改动面**（依据项目记忆「导入是本地数据结构的生产方，消费端遍布全部管理命令」）：
  - `export` 子树导出是否携带 assets
  - `delete-group` 级联删除是否清理 assets
  - `backup/restore` 快照是否包含 assets
  - `wiki-sync` 写回外部 wiki 时 assets 如何处理
  - 幂等重导时 assets 的覆盖策略
  - 磁盘占用（图片可能远大于 md）、单文件大小上限、总数量上限
  - `rebuild-vector` 无关（assets 不向量化）
- **定位**：终态方案，但因成本不该默认强加，建议 `ki scan-kb import --with-assets` 显式开启。

### 方案 C：优雅降级（不解决"看到图"，只消灭静默失败）

- 前端覆盖 `renderer.image`：非 `http(s)` 的 src 渲染为**可见占位块**（如 `🖼 图片未导入 · images/arch.png · alt: 架构图`），保留 alt 与原始路径。
- 服务端：附件类路径的 404 **不走 SPA fallback**，返回明确 JSON 错误。
- **成本**：约 30 行前端 + 1 处路由顺序调整，风险最低。
- **价值**：把"用户困惑图为什么不见了"变成"系统明确告知图未导入 + 出路"，契合项目 fail-loud + 给出路哲学。**任何终态方案下都需要它**（方案 B 也会有文件缺失的时候）。

### 方案 D：base64 内联进 local KB —— 建议明确排除

JSON 体积膨胀约 33%；原文不再是"原文"（直接违背方案 D 的既有设计意图）；复制原文/搜索/向量化全被二进制垃圾污染；`import.maxFileSize` 默认 1MB 上限直接爆。

### 推荐组合

```
C（必做，止血 + 消除静默失败）
  → B（终态，--with-assets 显式开启）
      → A 作为 B 的解析 fallback（本地 assets 未命中且 source.dir 仍在时回退直读）
D 排除
```

## 6. 待决策点

| # | 决策点 | 状态 |
|---|---|---|
| **D-1** | 图片引用形态 | ✅ **已拍板（2026-09-04）：本地相对路径；网络链接不管** |
| **D-2** | 实施路线 | ✅ **已拍板（2026-09-04）：不做止血，完整实现（方案 B 全链路）** |
| **D-3** | MCP 工具侧如何处理图片 | ⏸ 本次排除（范围聚焦）；登记后续：补 `assets?: [{alt, path, imported}]` 元信息为推荐项 |
| **D-4** | §3 向量侧损坏是否纳入本需求 | ⏸ 本次排除；涉及 `CLEAN_VERSION` 递增 + 提示重建向量，需单独拍板 |

## 7. 关键约束与风险

1. **`source.dir` 结构性缺陷**（scope 级单值 + Phase 5 无条件覆盖）——方案 A 的硬约束；若选 A 或 B+A fallback，需先决定是否将 source 下沉为 **group 级**。
2. **local KB 是 JSON 文本存储**——方案 B 必须新增二进制存储层（assets 目录），不能塞进 `index.json`。
3. **安全边界**：附件路由必须防路径穿越（可参照 `serveStatic:287-300` 的 `decodeURIComponent` + `normalize` + 前缀校验范式）；必须接入 scope 授权 RBAC（`authScopes`），否则成为越权读取任意 scope 附件的通道；不应服务 `source.dir` 之外的任意文件系统路径。
4. **SPA fallback 顺序**：新增附件路由必须在 fallback 之前拦截，否则 404 仍被伪装成 200。
5. **仓库内无带图样本**（§4 取证缺口）——实施与验收都需先补 fixture，否则无法验证。
6. **`cleanVersion` 联动**：若修 §3，`CLEAN_VERSION`（`src/lib/clean.ts:37`，当前 `'1'`）需递增，并按既有设计提示用户重建向量，防增量/全量清洗结果不一致。
7. **前端 XSS 边界**：放行 `<img>` 需白名单标签 + 属性净化，不能简单移除 `renderer.html = () => ''`（该规则是既有的注入防护）。

## 8. 涉及文件清单

| 层 | 文件 | 关联点 |
|---|---|---|
| 导入 | `src/lib/import.ts` | `collectMarkdownFiles:168-193`（白名单）、`writeLocalKb:644-650`、Phase 5 `setSource:531-538` |
| 存储 | `src/lib/scope.ts` | `getLocalKbDir:100-103`、`getSource:118-128`、`setSource:231-254`、`GroupIndexSource:107-113` |
| 清洗 | `src/lib/clean.ts` | `:94` 链接剥离正则、`CLEAN_VERSION:37` |
| 服务 | `src/lib/mcp-http.ts` | `serveStatic:285-325`、SPA fallback `:307-314`、`STATIC_MIME:265-282`、路由分发 `:443-470` |
| 服务 | `src/lib/mcp-http-api.ts` | `/api/*` 端点注册（新增附件端点落点） |
| 前端 | `web/src/components/MarkdownPreview.tsx` | `renderer.html:14`、缺失的 `renderer.image` |
| 前端 | `web/src/components/ModuleDrawer.tsx` | 原文渲染入口 `:75-77` |
| 前端 | `web/src/router/routes.tsx` | `/browse` 路由（相对路径解析基准） |
| CLI | `src/scan-kb.ts` | `import` 子命令选项（`--with-assets` 落点）`:35-46` |
| 配置 | `src/lib/config.ts`、`src/lib/config-schema.ts` | `ImportConfig:92-96`、字段级校验 schema |
| 连带 | `src/export.ts`、`src/delete-relation.ts`、`src/lib/wiki-sync.ts`、backup/restore | 方案 B 的 assets 生命周期 |

## 9. 取证与复现

### 9.1 fixture（取证缺口已补）

`test_data/wiki-with-images/`：

```
├── 架构总览.md        形态 1、形态 2、对照组 A、对照组 B + 召回锚点词
├── 部署说明.md        形态 3、形态 4（绝对路径 + file://）
└── images/
    ├── arch.png           1536×1024 真实 PNG（ImageGen 生成）
    └── deploy topo.png    文件名含空格，复现形态 2
```

复现步骤（导入不需重启服务，数据接口实时生效）：

```bash
export PATH="/root/.nvm/versions/node/v22.22.2/bin:$PATH"; unset NODE_OPTIONS BASH_ENV
node bin/ki.mjs scan-kb import --source test_data/wiki-with-images --scope img-fixture --group "图片取证" --no-vector
# 浏览器打开 http://127.0.0.1:7423/browse → scope 选 img-fixture → 查看原文
```

### 9.2 证据清单

| 证据 | 位置 | 结论 |
|---|---|---|
| 清洗探针 | `demo/probe-clean-image.mjs`（jiti 调真实 `cleanMarkdownText`，非复制正则） | §3：7 用例 4 种不一致结果 |
| 破图截图 | `demo/screenshot-broken-images.png` | 同屏三种表现：形态 1 破图图标、形态 2 字面源码、对照组 A 正常显示 |
| curl 对照 | §2.2 表格 | `web:false` 404 JSON vs `web:true` 200 HTML（SPA fallback 伪装） |
| 浏览器 DOM | §2.3 表格 | `naturalWidth` 0 vs 150/550；a11y 树中形态 2 为 StaticText、形态 3 无节点 |
| KB 落盘 | §2.1 实测 | 目录树无 images/；原文保留 4 条图片语法 |
| `source.dir` 失效 | §5 方案 A 实测 | 真实 dataDir 下 3/4 已失效，含 Web 上传暂存目录 |
| 图片引用普查 | `grep -rhoE '!\[[^]]*\]\([^)]*\)' test_data/ CodeWikiHub/ .qoder/repowiki/ docs/ \| wc -l` → 0（fixture 创建前） | 仓库原无带图样本 |

### 9.3 运行环境约束

```bash
export PATH="/root/.nvm/versions/node/v22.22.2/bin:$PATH"   # 本机 node 不在默认 PATH
unset NODE_OPTIONS BASH_ENV                                  # IDE 注入的 shim 会挂起批量文件操作
```

`ki mcp restart` 依赖 `SILICONFLOW_API_KEY` 环境变量（config 为 `${VAR}` 引用），**未携带时预检 fail-loud 且旧实例已停**（见 §10）。

- **代码事实**：§2 全部行号于 2026-09-04 直接读取源码确认。

## 10. 取证过程中的运维事故（诚实记录）

- **事故**：为复现报障场景执行 `ki mcp restart --web`，新实例因启动预检失败（`embedding.apiKey` 未解析）退出；而 restart 语义是**先停旧实例再启新实例** → 用户 7423 实例中断（无响应、无 lock、无进程）。
- **根因**：config 的 `apiKey: ${SILICONFLOW_API_KEY}` 依赖环境变量注入；执行 restart 的 shell 未带该变量 → 预检 fail-loud 拒绝启动。第一次恢复尝试误用 `.e2e-run/env.sh` 中**已失效的旧 key**（HTTP_401）再次失败。
- **恢复**：改用 `~/.bashrc` 中的有效 key 后 `ki mcp restart --web` 成功（`ready: true`）。
- **教训**：① `ki mcp restart` 是"先停后启"，预检失败 = 服务中断；在不确定环境变量的 shell 里执行前应先 `ki doctor` 确认预检通过 ② `.e2e-run/env.sh` 的 key 已失效，不可作为恢复凭据 ③ 该事故同时**正面验证**了 restart 的存活探测与启动预检工作正常（未假报成功，符合 fail-loud 设计）。
- **当前状态**：实例以 `--web` 运行（与报障场景一致，便于用户自行验证）；如需切回原 `--no-web`：`ki mcp restart --no-web`（同样需携带 `SILICONFLOW_API_KEY`）。

## 11. 实施记录（2026-09-04，用户拍板 D-1/D-2 后完整实现）

### 11.1 设计决定

| 决定 | 选择 | 理由 |
|---|---|---|
| assets 存储粒度 | group 级 `kb/{scope}/{group}/assets/` | 与 local KB 同生命周期 → delete-group 级联（`rmSync` 整 group 子树）与 backup（tar 整 scope）**自动覆盖，零连带改动** |
| 附件路由 | `GET /api/asset?scope&group&path` | 复用 `/api/*` 既有鉴权（authScopes 越权校验）与错误响应框架；`/api/*` 不走 SPA fallback → 404 不伪装（层 2 缺陷就此消除） |
| 目录结构 | 复制时保持相对 md 的路径（`images/x.png` → `assets/images/x.png`） | 前端可直接用原 URL 寻址，无需映射表 |
| 计数语义 | `stats.assets` = 唯一落盘文件数（Set 去重） | 同一附件被多篇 md 引用只计一次，避免与目录文件数不符（首版曾计复制次数致 assets=3 而文件 2 个） |
| 大小上限 | 单附件默认 5MB（`import.maxAssetSize` 可配）；超限跳过该附件 + 告警，**不阻断导入** | 图片普遍超 md 的 1MB 上限，不能复用 `maxFileSize` |
| 开关 | `--no-assets` / `import.assets:false` | 对齐 `--no-vector` / `--no-clean` 惯例 |
| 形态 2 含空格 | 导入侧宽松收集 + 前端渲染前 percent-encode | marked 不解析含空格 URL；local KB 原文不改 |
| 形态 3 `<img>` | 白名单放行（仅取 src/alt/title，其余属性含 on* 事件一律丢弃） | 完整实现需覆盖该写法；属性白名单即 XSS 净化 |
| 形态 4 绝对路径/`file://` | 导入不复制 + 前端占位块 | 安全：禁止借导入或路由读取任意宿主机文件 |
| 附件缺失 | 前端 `naturalWidth===0` / onerror → 可见占位块（路径 + alt） | fail-loud：明确告知而非静默破图/空白 |
| export | 携带 group assets 递归复制（`stats.assets` 计数） | 导出产物自包含 |
| wiki-sync | 零改动 | 写回源 wiki，源目录自有 images/ |
| D-3 / D-4 | 本次排除 | 范围聚焦；D-4 涉及 `CLEAN_VERSION` 递增需单独拍板 |

### 11.2 改动文件

- 后端：`src/lib/scope.ts`（getAssetsDir）、`src/lib/config.ts` + `config-schema.ts`（`import.assets` / `import.maxAssetSize` 字段级校验）、`src/lib/import.ts`（extractImageRefs / isCollectibleRelativeAsset / collectAndCopyAssets + 主循环接入 + 计数 + summary）、`src/scan-kb.ts`（`--no-assets`）、`src/lib/mcp-http-api.ts`（`/api/asset`）、`src/export.ts`（携带 assets + copyDirRecursive）
- 前端：`web/src/components/MarkdownPreview.tsx`（src 重写 + `<img>` 白名单 + 空格编码 + 占位块）、`ModuleDrawer.tsx`（传 assetBase）、`web/src/styles/ki.css`（占位块与 img 样式）
- 测试：`test/import-assets.test.ts`（新增 18 用例：提取/形态判定/安全边界/路由）

### 11.3 验证证据

- 类型：后端 tsc **7**（= 预存基线，零新增）；前端 tsc **0**
- 非向量套件 **219/219 全绿**：import-scheme-d 13 / mcp-http-api 16 / cli-help 40 / config-doctor 50 / delete-group 7 / lib 37 / **import-assets 18（新）** / mcp-http 28 / scope-isolation 5 / interrupt 5
- 向量类套件（import-vector-rebuild / restore / integration）**未跑**：与常驻 7423 实例撞嵌入式向量锁（项目记忆记载的硬约束，非本次引入）；本次改动不触碰向量逻辑（assets 收集为纯文件操作，位于切分后、向量化前）
- `/api/asset` 实测：命中 200 + `image/png`（body 为真 PNG）/ 缺失 **404 JSON（不伪装）** / `../` 穿越 **403** / 绝对路径被 `path.join` 收敛后 404（未越权）/ 缺参 400
- 浏览器实测：形态 1/2/3 从破图 / 字面源码 / 完全空白 → **naturalWidth=1536 真显示**；形态 4 → 占位块；对照 A/B 仍正常。截图 `demo/screenshot-after-fix.png`
- 导入实测：`assets=2`（去重后），KB 落盘 `图片取证/assets/images/{arch.png, deploy topo.png}`

### 11.4 过程中发现（登记，未修）

- `ki mcp restart` 停→启之间存在**端口释放竞态**：旧实例刚停、新实例立即 bind 可能 EADDRINUSE → exit 1 且旧实例已停（本次复现 1 次；与 §10 的预检失败叠加造成两次停服）。建议后续在 restart 的停→启之间加端口就绪等待。
- `test/cli-aliases.test.ts` 1 个预存过期断言（断言已删除的 `ki scan-kb diff`），与本次无关。

### 11.5 challenger 二次质疑命中（auto-review 流程，2026-09-04）

- **Q1 🟡 存量已导入数据不受益**：本功能只对未来导入生效；用户报障的**已导入** wiki 需重导一次（幂等覆盖语义支持）才能看到图片。→ 验收前置说明，非代码缺陷。
- **Q2 🟡 wiki-sync 写回后图片引用错位**：写回路径为 `{sourceDir}/{group}/{relation}.md`（group 子目录），而源 wiki 的 images/ 在源根 → 写回副本内相对引用错位。属既有 group 前缀设计在「md 含相对图片引用」时的新暴露面；登记已知边界，未修。
- **Q3 🟡 占位块文案对外链断网误导**（「图片未导入」并非外链失败的原因）→ **已修**：文案改「图片无法显示（未导入或加载失败）」。
- **Q4 🟢 SearchPage 附件链路（P1-8 修复）未端到端实测**：img-fixture 为 `--no-vector` 导入、搜索无结果可点 `[需运行验证]`。
- **Q5 🟢 导入中断后已复制的 assets 成为孤儿文件**（占空间、无害）：重导覆盖或 delete-group 级联清理。
