---
name: ki-client
description: 用 ki-client 从远端 ki 取回图片附件与文档正文、上传文档/目录、部署知识地图图集。触发："把图取下来"、"这张图画的是什么"、"下载那篇文档"、"传到远端 ki"、"把图集部署到生产"、"ki-client"。
---

# ki-client：跨机取件与上传

## 概述

**目的**：本仓 **MCP 工具面不提供取图工具**（2026-11-25 移除了 `ki_get_image`）——`ki_get_module_info` 只回答「这篇文档有哪些图、`ref` 是什么」，**字节要靠 HTTP 取**。`ki-client` 就是这条通道的命令行封装：一次命令把字节落到本地，打印**绝对路径 + sha256**，再交给读图能力或编辑器。

**功能**：`remote`（多源管理）、`ping`（连通 / 鉴权 / 能力自检）、`asset get`（附件落盘）、`doc get`（正文 + 文中附件还原）、`upload` / `upload-dir`（自动分批 + 文件级增量）、`atlas upload` / `atlas status`（图集远程部署）。

**使用场景**：
- 要看知识库里某张图的**像素内容**（MCP 只给清单，看不到图）
- 跨机把一篇文档的正文与全部附件取回本地
- 把本地文档 / 整个目录传到远端 ki（跨机场景 `ki import --source` 够不着）
- 把知识地图图集包装到远端库并核对基线
- **不适用**：单条知识读写 → `use_skill("ki-search")` 的 MCP 工具；文件已在 ki 同机 → `ki import --source`；只是想问问题 → `ki_ask`

**与产品内置 AI 对话的关系**：对话里的 `ki_get_image` **仍然存在**且返回真图片——那是服务端进程内直调，与「客户端命令行取件」是两条独立通道，不要混谈。

## 什么时候用哪条

| 要做的事 | 命令 |
|---|---|
| 只想知道有哪些图、ref 是什么 | MCP `ki_get_module_info`（看返回体 `images[]`） |
| 要**图的内容** | `ki-client asset get --scope --group --refs --out` |
| 要整篇正文 + 图 | `ki-client doc get --scope --group --relation --out` |
| 传单/多篇 markdown | `ki-client upload --scope <库> <文件...>` |
| 传整个目录 | `ki-client upload-dir --scope <库> <目录>` |
| 部署知识地图图集 | `ki-client atlas upload --scope <库> --file <zip>` |
| 不知道远端支持什么 | `ki-client ping --remote <源>` |

## 与 `ki-upload` 的分工（同一件事两条路，别随机选）

「本地文件 → 远端 ki」有两条 skill 通道，**都能干成，前提不同**：

| | 本 skill（`ki-client`） | `use_skill("ki-upload")` |
|---|---|---|
| 运行时 | Node ≥ 18，需 `npm i -g .` 安装子包 | Python + `httpflex`，**不需要装 ki** |
| 凭据 | 配置文件里的源（或 `KI_URL` + `KI_TOKEN`） | 环境变量 `KI_URL` + `KI_TOKEN` |
| 独有能力 | 取件 / 取正文 / 部署图集 / **文件级增量** / 自动分批 | 极简脚本化，只做上传 |
| 选它的时候 | 同一台机器既要上传又要取件，或要反复重跑增量 | 只上传，且不想为一个客户端装 Node 包（CI / 临时机器） |

> 两条路的服务端接口是同一套 `/open/v1`，产物一致；差异只在客户端形态。

## 前置自检（三步，别跳）

1. **装了吗**：`ki-client --version`；没有则进 `ki-client/` 执行 `npm install && npm run build && npm i -g .`（或在仓内临时跑 `node ki-client/dist/cli.js`）
2. **配源了吗**：`ki-client remote list`；没有则 `echo "$KI_TOKEN" | ki-client remote add <名> <地址> --token-stdin`（token 走 stdin，不进 shell history）
3. **通吗、远端开没开**：`ki-client ping --remote <名> --scope <目标库>` —— 它会回「授权库」清单、`capabilities` 与 `limits`（取件 / 上传 / 图集是否可用、请求体上限）。**`--scope` 别省**：不传时服务端按 `default` 库判权，Token 没授权 `default` 就直接 403 `OPEN_API_SCOPE_FORBIDDEN` —— 看起来像「token 无效」，实际只是没指明库。**还不知道库名时**先 `ki mcp token list` 看授权范围（或先不带 `--scope` 探一次，这次 403 不代表 token 坏了），拿到库名再带上

> 没有配置任何源时可用环境变量做一次性调用：`KI_URL=... KI_TOKEN=... ki-client ping`。

## 取件：asset get / doc get

```bash
# 单张或多张（1~3 张，逗号分隔）
ki-client asset get --remote prod --scope kb --group wiki/部署 --refs shots/a.png --out ./tmp
# 整篇正文 + 文中附件
ki-client doc get --remote prod --scope kb --group wiki/部署 --relation 上线手册 --out ./tmp
```

口径：
- `ref` 直接用 `ki_get_module_info` 的 `images[].ref`（或 `doc get` 返回的 `images[].ref`）**原样传**，不要自己拼路径
- 落盘**保留 ref 的相对子路径**（`shots/a.png` → `<out>/shots/a.png`），拍平会让正文里的图片引用全断
- **`--scope` / `--group` 必须与库内落点完全一致**（`doc get` 还有 `--relation`），服务端只做精确匹配（无模糊匹配、无向量兜底），不一致一律 404 `OPEN_API_NOT_FOUND`
- **`--relation` 是落库的文件名去掉 `.md`，不是正文里的 H1 / 文档标题**（中文文件名合法，所以中文 relation 也可能对——判据是「文件名」而不是「中文/英文」）。撞名走了后缀策略时会带后缀 → 以导入结果回显的 `relation` 或 `ki_get_module_info` 的返回为准
- **默认不覆盖**已有文件，确认要覆盖加 `--overwrite`；`--json` 拿机器可读结果
- 单张失败不中断其余，最后统一报告并返回非 0 → **不要因为退出码非 0 就认为全失败，读输出**
- 输出里的 **绝对路径**就是交给读图能力的入参；**sha256** 是「拿到的确实是库里那份」的凭据

`doc get` 的额外口径（**正文与附件是两件事**）：
- **正文先落盘、附件逐个取**：退出码 1 只表示「有附件没取到」，正文通常已经完整保存
- 外链图片（`https://…` 等外部地址，或服务端标记不可取）**必然取不到**，属正常现象，不要据此判定整体失败
- 只要正文用 `--no-assets`（退出码即 0）；脚本判定看 `--json` 的 `markdown.file` 与 `failed`，别拿退出码当整体成败

## 上传：upload / upload-dir

```bash
ki-client upload --scope kb --group wiki/部署 ./a.md ./b.md
ki-client upload-dir --scope kb ./docs --batch-bytes 33554432
```

- **通道自动选**：根目录纯 markdown 走 multipart（最快）；**批次里出现子目录或图片时自动走 tar.gz**——multipart 通道不落盘附件（服务端已知缺陷：md 导入成功、`errors:0`，但 `assets/` 是空的，图变死链、不报错）。可用 `--archive` 强制
- **超大目录靠分批不靠压缩**：默认读 `ping` 回的 `limits.maxRequestBody`，你给的 `--batch-bytes` 超了会自动收窄并提示一次
- **增量是文件级**：每个文件传成功后立刻记进 `~/.ki-client/state/<key>.json`（按「源 + 库 + 组 + 目录」派生），重跑同一条命令只补没记过或内容变了的；`--force` 全重传、`--no-state` 不读不写状态
- **失败的批次不写状态**，重跑同一条命令即可补齐
- **图片不限目录**：`.md` + 后缀白名单里的图片（`images/`、`screenshots/`、`assets/` 都行），只要正文引用路径与目录结构对得上；其它后缀跳过并报个数
- **缺图默认算失败**：正文引用了但包里没有的图，服务端不会报错（md 成功、图变死链）→ 客户端逐条列出并按退出码 1 返回；确认不需要这些图时加 `--allow-missing-assets` 降级为警告。看到退出码 1 先看是不是这一类，别当成网络失败

## 图集部署：atlas upload / status

```bash
ki-client atlas upload --remote prod --scope kb --file dist/atlas.zip
ki-client atlas status --remote prod --scope kb
```

- **重复执行安全**：先比服务端 `packageSha256`，一致就跳过（退出码 0），加 `--force` 才无条件重传
- 一次一整包、不分片；超 `capabilities.atlas.maxPackageSize` 时**本地就报错**
- 装完 Web「知识地图」页立刻可见；回滚 = 重传上一版包（服务端保留一版在 `archive/`）
- 回显里 `sha` 是图集 HTML 指纹，`包指纹` 才是 zip 的 sha256，别搞混

## 常见错误码 → 出路

| code | 出路 |
|---|---|
| `NO_REMOTE_SPECIFIED` | 配了多个源必须 `--remote`（或设 `KI_REMOTE`） |
| `UNKNOWN_REMOTE` | `remote list` 看可用源 |
| `TOKEN_MISSING` | 设 `KI_TOKEN_<源名大写>` 或 `remote add --token-stdin` |
| `REMOTE_UNREACHABLE` | 先 `ping`；跨机查防火墙与端口 |
| `CONTRACT_TOO_OLD` | 服务端缺能力（取件接口 / `downloadApi` 关闭 / 不支持图集）→ 升级服务端或请运维开启 |
| `FILE_EXISTS` | 加 `--overwrite` |
| `CONFIG_INVALID` | 配置文件形状不对，按提示改；未知配置项不会被静默忽略 |
| `OPEN_API_SCOPE_FORBIDDEN` | Token 未授权该库。**最常见成因是根本没传 `--scope`**（服务端缺省判 `default` 库）→ 显式补 `--scope <已授权库>` 再试。403 响应刻意不回显授权清单（防跨租户枚举库名），要看清单只能靠 ping 成功时的「授权库」行，或去 ki 所在机器跑 `ki mcp token list` |
| `OPEN_API_NOT_FOUND` | 取件：`group` + `relation` 与库内落点不一致（`relation` = 落库文件名去 `.md`，不是标题；撞名可能带后缀）；上传：路径/端点不对，或接口被关闭 |
| `OPEN_API_TOKEN_READONLY` | 只读 Token 不能上传 → 换读写 Token 或 `ki mcp token update <id> --read-write` |
| `OPEN_API_SCOPE_READONLY` | 目标库被设为只读 → `ki scope readonly <库名> --off` |
| `SERVER_ERROR` | 输出里带 `OPEN_API_*` 码与出路，照着走 |

## 禁忌

1. **不要凭 ref 猜 scope / group**：`ref` 是指向 `{group}/assets/` 的相对路径，scope 与 group 必须与读文档时一致（换库/换组就取不到）
2. **不要在有多个源时省略 `--remote`**：配置文件里刻意不设隐式默认源（`KI_REMOTE` 可用但属于显式指定）——最常见的误操作是把测试库的东西传进生产
3. **不要把 token 写进命令行参数**（会进 shell history 与 `ps`）→ 用 `--token-stdin` 或环境变量
4. **不要提交 `~/.ki-client/config.yaml`**：里面有明文 token（目录 `0700` / 文件 `0600`）
5. **不要用 `ki-client` 做单条知识读写**：那是 MCP 工具的活，用 `use_skill("ki-search")`
6. **不要因为退出码非 0 就整批重传**：先读输出分清「哪些失败、为什么」（`FILE_EXISTS` 与网络错的处理方式完全不同）
7. **不要假设 multipart 带图能成功**：客户端已自动改走 tar.gz，但手工构造 HTTP 上传时必须自己避开

## 相关文档

- 用户向手册（安装三方式 / 逐步操作 / 排障）：`docs/ki-client.md`
- 包说明与开发：`ki-client/README.md`
- 服务端契约（`/open/v1` 取件与上传）：`docs/open-api.md`
