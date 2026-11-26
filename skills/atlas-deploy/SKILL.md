---
name: atlas-deploy
description: 把 project-atlas 生成的图集包部署进 kisearch：校验压缩包形状、用 ki atlas upload 装机、验完再收工。触发："部署图集"、"上传知识地图"、"把图集装进 kisearch"、"atlas deploy"、"ki atlas upload"。
---

# 图集部署（atlas-deploy）

> **一句话**：`project-atlas` 负责「画什么、怎么讲」，本 skill 负责「装进哪个库、怎么验、为什么装不上」。

## 概述（AI 说明层）

- **目的**：补上「图集画完了怎么装进 kisearch」这一步，避免 agent 自己拼命令、漏校验、装完不验。
- **功能**：包形状校验（唯一 html / baked / 无外链 / 体积）→ `ki atlas upload` 装机 → 三步入验证 → 按错误码排障 → 红线清单。
- **使用场景**：本地或远端 agent 拿到 `project-atlas` 产物后要上架；图集装不上要定位；回滚上一版。
- **不适用**：普通文档上传（用 `ki-upload`）、图集怎么画（用 `project-atlas`）。

## 0. 速览

```
有 atlas.zip 吗？
├─ 没有 → 先用 project-atlas 生成并打包（见 §2）
└─ 有
   ├─ ① 校验包形状（§2.2：根目录唯一 html、baked、无外链、体积）
   ├─ ② 选目标库（§1：存在、可写、非只读）
   ├─ ③ ki atlas upload --scope <库> --file <zip>   （§3.1）
   ├─ ④ export_markdown.py 导出 md 目录              （§2.3，需图集目录在手）
   ├─ ⑤ 导进同库的「知识地图」group                    （§3.2）
   ├─ ⑥ ki atlas status --json 核对 sha/基线          （§4.1）
   ├─ ⑦ 打开 /atlas 点一个节点，抽屉里有代码          （§4.2）
   ├─ ⑧ AI 检索命中一页 + 取回一张图                  （§4.4）
   └─ ⑨ 失败 → §5 排障表按错误码查
```

**只做四件事**：包形状、装哪、装完怎么验、**图集怎么让 AI 也读得到**。**不做**：策划视图、画图、判断图集内容对不对。

> **为什么多出 ④⑤**：图集在服务端是 `<库>/.atlas/atlas.html` 一个烘焙 HTML，点号目录被扫描跳过、不进索引，MCP 工具面也没有 atlas 工具 —— AI 只看得见人、看不见图。把 `export_markdown.py` 的产物导入同库的「知识地图」group，AI 才能用 `ki_recall` / `ki_search` 命中它。④⑤ 是**可选但推荐**：不做不影响人看图集，做了 AI 才能引用。

## 1. 前置检查（缺一项就先补，别硬上）

| 项 | 怎么查 | 缺了怎么办 |
|---|---|---|
| `ki` 可用 | `ki --version` | 装 CLI 或走项目 README |
| 目标库存在 | `ki scope list` | 先建库；**不要**随手用 `default` 顶替 |
| 目标库可写 | `ki scope list --json` 里该库的 `readonly` 字段（`false` = 可写） | 解除只读：`ki scope readonly <库> --off`（需用户拍板）。⚠️ 只读**只拦 §3.1**（`/api/atlas/package` 有显式只读拦截），而 `ki import` 是放行的 —— 在只读库上跑完 §3.2，会出现「md 已入库、图集没装成」，两边不一致 |
| 图集已打包 | 有 `dist/atlas.zip` | 走 §2 |
| 图集目录在手 | 有 `site.json` + `nav/` + `views/` | 想同步 AI 可读层（§2.3）就必须在生成侧做；部署机只有 zip 时，让生成侧把 `dist/atlas-md/` 一起带过来 |
| 有权限看结果 | 浏览器已登录该库 | 请求登录态；`/atlas` 页需要 `knowledge.read` |

## 2. 生成与打包（转 project-atlas，这里只强调形状）

### 2.1 生成

按 `use_skill("project-atlas")` 走：策划 → archify 出图 → 导 SVG → `collect_snippets.py` 抽快照。**先出「拟画清单」等用户确认再动笔**（那是该 skill 的红线，不要在这里绕开）。

### 2.2 打包（唯一正确姿势）

```bash
python3 <project-atlas>/scripts/pack_atlas.py <图集目录> dist/ --zip
```

产出的 `dist/atlas.zip` 必须满足：

| 约定 | 判据 | 不符合的后果 |
|---|---|---|
| 根目录**唯一** `.html` | 包内根层级只有一个 html | `ATLAS_ENTRY_NOT_FOUND`(1402) |
| 含 `baked: true` | 文件内出现 `"baked": true` | `ATLAS_PACKAGE_INVALID`(1401)：说明用的是 build 前的配置，运行时回去找 `atlas.config.json` 会 404 |
| 无外链资源 | 无 `src="http…"` / `href="http…"` / `url(http…` | `ATLAS_PACKAGE_INVALID`(1401) |
| zip ≤ 20 MB、解压总量 ≤ 50 MB、entry ≤ 10 MB | `du -h dist/atlas.zip` | `ATLAS_TOO_LARGE`(1403) |
| 条目 ≤ 50 个 | `unzip -l dist/atlas.zip` | `ATLAS_UNSUPPORTED_ZIP`(1407) |

> **不要手工 zip 一个目录**：`pack_atlas.py` 会做 build + check + 字体去重 + 内联，手工打包必然缺内联步骤。
>
> **不需要额外附 `meta.json`**：标题 / 分支 / 基线 commit / 生成时间由平台从烘焙产物内嵌的
> config（`<script id="demo-config">`）自动提取，比另带一份 meta.json 更可靠（不会与内容不同步）。
> 早期手工打包才需要 meta.json，现已不是必需。

### 2.3 导出 AI 可读的 Markdown

```bash
python3 <project-atlas>/scripts/export_markdown.py <图集目录> dist/atlas-md/ --clean
```

产物：`README.md` + `<分类>/<page>.md` + `<分类>/images/<page>.svg`。与页面「导出 ↓」逐字节一致（共用模板），但命令行能在 CI / agent 里跑。

三条硬约定：

| # | 约定 | 理由 |
|---|---|---|
| 1 | **不要加 `--no-images`** | 加了 md 连图引用都不写，人和 AI 都看不到图。带图的代价是本项目 8 页实测 32 KB 正文 + 1.4 MB 图 |
| 2 | **必须在生成侧执行** | 脚本读的是图集目录（`site.json` + `nav/` + `views/`）。部署机只有 `atlas.html` 单文件，跑不起来 → 把 `dist/atlas-md/` 和 `dist/atlas.zip` 一起交付 |
| 3 | **不要手工整形目录** | `images/` 不用改名为 `assets/`。ki-client 曾只收 `assets/` 目录导致静默丢图（事件 #101），2026-11-26 已修（`isWanted` 去目录判定 + `refCandidates` 相对解析 + 缺图 fail-loud 退出码 1） |

> ⚠️ `--clean` 会**先清空目标目录**再写。目标必须是专用空目录（`dist/atlas-md/`），别指向仓库根或已有内容的目录 —— 没有二次确认。

## 3. 上传

### 3.1 上传图集包

```bash
ki atlas upload --scope <库> --file dist/atlas.zip
```

成功输出（人读）：

```
校验通过：2 个条目 · entry atlas.html 249 KB
已安装到 <库>/.atlas/
  基线   master@1c3dabf（生成 2026-11-24）
  体积   249 KB（zip 108 KB）
  sha    9bad814a
上一版已归档到 archive/
```

给脚本 / agent 判定用 `--json`（与 `GET /api/atlas/status` 同构）：

```bash
ki atlas upload --scope <库> --file dist/atlas.zip --json
# {"ok":true,"scope":"kisearch","exists":true,"size":254753,"packageSize":108195,
#  "sha256":"9bad814a…","baseline":"1c3dabf","archived":true}
```

**重传语义**：同 scope 再传即覆盖，旧包进 `archive/`（保留 1 版）。**先比 sha 再传**——内容没变就别重复上传。

### 3.2 同步 AI 可读层（导入「知识地图」group）

```bash
# 远端（ki-client，自动分批 + 文件级增量）
ki-client upload-dir dist/atlas-md/ --scope <库> --group 知识地图 --remote <源名> --wait

# 同机（ki CLI，语义等价）
ki import --scope <库> --source dist/atlas-md --group 知识地图
```

落库形状（2026-11-26 实测）：

```
<库>/知识地图/
├── index.json
├── 01-架构总览/{index.json, assets/images/runtime.svg}
├── 02-核心链路/{index.json, assets/images/search.svg, …}
└── …                          ← 源目录的分类目录会拼进 group 名
```

**文档数按「页数 + 1」核对**：根目录的 `README.md` 也会导入，落到 `知识地图` 根 group。8 页的图集实际是 **9 篇**（`createdTotal: 9`），别按页数认为多导了。

> `ki-client upload-dir` 走 tar.gz 通道（含子目录或图片时自动切换），本次只做了代码核对、**未实测**；同机场景优先用 `ki import`（两条命令底层都是 `resolveGroupForSource`，group 拼接规则一致）。

五条纪律：

| # | 纪律 | 理由 |
|---|---|---|
| 1 | **落点 = 图集所在 scope** | `ki import --scope` 必须与 `ki atlas upload --scope` **同值**（2026-11-26 拍板）。图集和它的文字层分居两库，卸载、权限、检索会各管一份，没有一处能回答「这份图集现在是什么版本」 |
| 2 | group 名**固定 `知识地图`** | 「本库图集的 AI 可读副本」唯一落点。跟着图集标题改名字，换一次标题就多一份副本，AI 会命中两份 |
| 3 | **不用先建 group** | 导入时自动建（含父路径） |
| 4 | **保留分类子目录** | 子目录变成子 group（`知识地图/02-核心链路`），图片才落在该子 group 自己的 `assets/` 下，正文 `./images/x.svg` 才对得上。拍平反而要改 md |
| 5 | **幂等，可重复跑** | 同内容重导 `created=0 / modified=0`，不产生重复文档 |

⚠️ 两个会写错地方的坑（都会静默成功）：

- **`--scope` 省略 = 写进 `default` 兜底库**（与 `ki group delete` 漏 `-s` 同源）。命令里必须显式给，别指望它记得上次用的是哪个库。
- **目标库开了 wiki-sync 时，导入会连带把正文写回它的 wiki 目录**（`src/lib/import.ts:431`：导入成功后按 wiki 格式写回 `wikiSync.sourceDir`；`ki scope list --json` 里 `wikiSync.enabled` 为 `true` 即开启，目录通常就在仓库内、直接进 git）。图集 md 不该进这类库；本项目 `default` 未开，`kisearch-memory` 已开。

落点一致性自查（做完 §3.1 + §3.2 各跑一次）：

```bash
ki atlas status --scope <库> --json | grep -o '"exists":[a-z]*'   # 图集在不在这个库
ls /root/.ki-data/<库>/知识地图/                                   # md 在不在同一个库（KB 根以 config 的 kbDir 为准）
```

> **视图（view）不是落点**：`/open/v1/atlas/*` 与 `/api/atlas/package` 显式拒绝视图名——视图下看图集是「从成员库里挑一份」（`web/src/lib/atlasTargets.ts:9-12`）。`--scope` 一律用真实库名。
>
> **检索口径要看视图成员**：若图集所在库不在 AI 常用视图里（本项目图集在 `default`，而 `kisearch-docs` 成员只有 `kisearch-memory` + `kisearch-xperts`），用视图名检索就命中不到，需显式叠加 `scope: "kisearch-docs,default"`。这是使用侧口径，不是导入失败。

### 3.3 重部署与卸载的清理

导入**从不删除**旧文档，所以三条清理纪律：

| 场景 | 做法 |
|---|---|
| 图集内容变了（页数不变） | 直接重导，同名覆盖 |
| 图集**少了页面** | 先 `ki group delete "知识地图" -s <库> --yes` 再重导；否则已下线的那页仍留在库里被 AI 检索到 |
| **卸载图集** | ① 页面顶栏「卸载图集」（或 `DELETE /api/atlas/package?scope=<库>`）；② `ki group delete "知识地图" -s <库> --yes`（**级联**子组 + KB + assets + 向量）。**两步都要做**——卸载图集包不会动 group |
| **换库（迁移）** | 新库按 §3.1 + §3.2 重做一遍，再回旧库走上一行的卸载清理。只做前一半 = 两个库各有一份，版本迟早不一致 |

> 🔴 **`-s <库>` 不能省**：`ki group delete` 的 scope 是**选项**不是位置参数，漏了就用 `default` 库——会在毫不相干的库里删掉同名组。同理 `ki import --scope` 也必须显式给。

⚠️ 两条边界：

- **级联删 group 只有同机 CLI 能做**：MCP 的 `ki_group_delete_empty` 只删空叶子组；HTTP / open-api 没有 group 删除接口。远端 agent 做不了卸载清理，须回同机执行。
- **删 group 会进回收站**（`KI_TRASH_DISABLED=1` 才硬删），彻底清零要等过期或走治理页 purge。

## 4. 验证（§4.1 + §4.2 必做；做了 §3.2 还要过 §4.4）

### 4.1 状态对得上

```bash
ki atlas status --scope <库> --json
```

核对：`exists: true`、`size` 与本地 entry 一致、`baseline` 是这次生成的 commit。

### 4.2 页面真能看

1. 打开 `http://127.0.0.1:<port>/atlas`，切到该库；
2. 状态栏显示基线/生成时间/体积（**必须与 §4.1 一致**）；
3. 点一个带代码的节点 → 右侧抽屉出现 `路径:行号` 与代码。

三条任一不成立 → 不算部署成功，按 §5 查。

### 4.3 回滚（上传了错的包时）

`.atlas/archive/` 里有上一版 zip：

```bash
ki atlas upload --scope <库> --file /root/.ki-data/<库>/.atlas/archive/<ts>.zip
```

### 4.4 AI 真的读得到（做了 §3.2 才验）

```bash
# ① 语义检索能命中某一页
ki search --scope <库> --query "<某页摘要里的一句话>" --limit 3

# ② 图能按 group 取回（端口按 daemon 实际值，默认 7423）
curl -sG 'http://127.0.0.1:7423/api/asset' \
  --data-urlencode 'scope=<库>' \
  --data-urlencode 'group=知识地图/02-核心链路' \
  --data-urlencode 'path=./images/search.svg' \
  -o /tmp/probe.svg -w '%{http_code} %{size_download}\n'
```

判定（三条缺一不可）：

0. **导入结果本身没失败**：输出须为 `ok: true`、`errors: []`、`partial: false`，且 `createdTruncated` / `modifiedTruncated` 都为 `false`。任一项不满足说明有页面没进去 —— 先修，别急着往下验检索（缺页的图集比没同步更糟：AI 会以为某页不存在）
1. 命中结果的 `group` 是 `知识地图/<分类>`、`relation` 是页面 id（如 `search`）
2. 返回 `200` 且字节数 > 0

⚠️ **检索片段与正文不一样，这不是失败**：`ki_search` 返回的 chunk 过了数据清洗——`file:line` 会被 `codePath` 规则抹掉、图片引用只剩 `!标题`；而 `ki_get_module_info` 读到的 KB 原文是完整的（位置列、图片引用都在）。所以 AI 的正确姿势是**先 search 定位、再 get 读全文拿行号**。

## 5. 排障表

| 现象 | 错误码 / 退出码 | 原因 | 下一步 |
|---|---|---|---|
| 包内找不到 html | `1402` ATLAS_ENTRY_NOT_FOUND | 打成了「目录包」，html 在子目录里 | 用 `pack_atlas.py … --zip` 重打 |
| 提示缺 `baked` | `1401` | 用了未烘焙的产物 | 同上；`build` 产物不能上传 |
| 提示含外链 | `1401` | 图集里引了 CDN 字体/图片 | 重跑 `check_atlas.py`；offline 化后重打 |
| 提示条目不安全 | `1404` | 条目含 `../` 或符号链接 | 不要手工改包，重打 |
| 体积超限 | `1403` | 视图太多 | 先减视图（6~8 页预算），不要靠删快照瘦身 |
| 不支持的 zip | `1407` | zip64 / 加密 / 非常规压缩 | 用 `pack_atlas.py` 产出的原始包 |
| scope 不存在 / 只读 | 退出码 2 | 库名写错，或库是只读 | `ki scope list` 核对；只读库需用户拍板 |
| 页面空白无图 | — | 浏览器没登录，或 `view` 被拒 | 看状态栏是否显示错误态；直接访问 `/api/atlas/view?scope=<库>` 看返回 JSON |
| 有图但节点点不开 | — | 快照没抽（`collect_snippets.py` 没跑） | 回到生成侧补快照并重打 |
| 图与代码不符 | — | 图集过期 | 顶栏基线 commit 与当前 HEAD 比对，重跑生成 |
| AI 检索命中不到图集内容 | — | 没做 §3.2，或 group 名不是 `知识地图` | 按 §3.2 重导；`ki search --scope <库>` 确认命中 |
| 文档里图裂 | — | 图片没随包上传，或 group 路径对不上 | 查 `{group}/assets/images/` 是否有文件；远端上传时看缺图 fail-loud 报错（退出码 1） |
| 检索片段里没有 `file:line` | — | 正常现象：chunk 被 `codePath` 清洗 | 用 `ki_get_module_info` 读全文，位置列在 |
| 图集改版后 AI 仍引旧页 | — | 导入不删除，下线页残留 | 按 §3.3 先删 group 再重导 |

## 6. 红线

| # | 红线 |
|---|---|
| 🔴 1 | **不手改 `.atlas/` 下的文件**（不是配置文件，是产物；改完与 meta 的 sha 不一致，页面会判损坏） |
| 🔴 2 | **不绕过 `ki atlas upload` 直接写盘**（校验链在 CLI 里，绕过等于装一个未校验的包） |
| 🔴 3 | **图集包本体不进 group**：`atlas.html` / `package.zip` 留在 scope 根的 `.atlas/`，不许搬进 group。**唯一允许进 group 的是 §2.3 导出的 md 目录**，且只能落 `知识地图`（§3.2）——它本就是给人读的文本，进索引是目的、不是副作用 |
| 🔴 4 | **不上传未变更的包**（先比 sha；重复上传会无意义地刷掉 archive） |
| 🔴 5 | **不在图集里放外链**（部署包必须离线自包含，这是它能装进容器的前提） |
| 🔴 5.1 | **只装你自己生成的包**：图集 HTML 在页面里是 `sandbox="allow-scripts allow-same-origin"`，等同「可执行代码」，能读同源 Cookie 调本机 API。它不是数据文件，别接收来源不明的 zip |
| 🔴 6 | **不宣称"已部署"却没做 §4**（状态对得上 + 页面点得开，两条缺一不可） |

## 7. 与相邻 skill 的分工

```
project-atlas  → 画什么、怎么讲（生成侧，本仓外）
atlas-deploy   → 装哪个库、怎么验、为什么装不上（本 skill）
ki-upload      → 普通文档上传进 KB；图集的 md 副本也能用它传，但 group 落点按 §3.2
module-teach   → 讲一个模块怎么实现（长文，不是图集）
```

> 一期只有 CLI 上传；页面上传是二期。用户问「能不能在网页上传」时，如实回答还没做，不要编入口。
