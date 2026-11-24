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
   ├─ ③ ki atlas upload --scope <库> --file <zip>   （§3）
   ├─ ④ ki atlas status --json 核对 sha/基线        （§4.1）
   ├─ ⑤ 打开 /atlas 点一个节点，抽屉里有代码        （§4.2）
   └─ ⑥ 失败 → §5 排障表按错误码查
```

**只做三件事**：包形状、装哪、装完怎么验。**不做**：策划视图、画图、判断图集内容对不对。

## 1. 前置检查（缺一项就先补，别硬上）

| 项 | 怎么查 | 缺了怎么办 |
|---|---|---|
| `ki` 可用 | `ki --version` | 装 CLI 或走项目 README |
| 目标库存在 | `ki scope list` | 先建库；**不要**随手用 `default` 顶替 |
| 目标库可写 | `ki config get scopes.<库>.readonly`（无该项=可写） | 只读库只能看，换库或先解除只读（需用户拍板） |
| 图集已打包 | 有 `dist/atlas.zip` | 走 §2 |
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

## 3. 上传

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

## 4. 验证（做完这三步才算交付）

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
ki atlas upload --scope <库> --file <kb>/<库>/.atlas/archive/<ts>.zip
```

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

## 6. 红线

| # | 红线 |
|---|---|
| 🔴 1 | **不手改 `.atlas/` 下的文件**（不是配置文件，是产物；改完与 meta 的 sha 不一致，页面会判损坏） |
| 🔴 2 | **不绕过 `ki atlas upload` 直接写盘**（校验链在 CLI 里，绕过等于装一个未校验的包） |
| 🔴 3 | **不把图集塞进 group / assets**（它在 scope 根的 `.atlas/`，进 group 会被当文档扫进索引） |
| 🔴 4 | **不上传未变更的包**（先比 sha；重复上传会无意义地刷掉 archive） |
| 🔴 5 | **不在图集里放外链**（部署包必须离线自包含，这是它能装进容器的前提） |
| 🔴 5.1 | **只装你自己生成的包**：图集 HTML 在页面里是 `sandbox="allow-scripts allow-same-origin"`，等同「可执行代码」，能读同源 Cookie 调本机 API。它不是数据文件，别接收来源不明的 zip |
| 🔴 6 | **不宣称"已部署"却没做 §4**（状态对得上 + 页面点得开，两条缺一不可） |

## 7. 与相邻 skill 的分工

```
project-atlas  → 画什么、怎么讲（生成侧，本仓外）
atlas-deploy   → 装哪个库、怎么验、为什么装不上（本 skill）
ki-upload      → 普通文档上传进 KB（与图集无关）
module-teach   → 讲一个模块怎么实现（长文，不是图集）
```

> 一期只有 CLI 上传；页面上传是二期。用户问「能不能在网页上传」时，如实回答还没做，不要编入口。
