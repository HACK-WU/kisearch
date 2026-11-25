# ki-client

ki 的**远端取件客户端**：从远端 ki 上传文档、下载文档正文与附件（图片），支持多个源（类比 `git remote`）。

不依赖 ki 本体，**只需要 Node ≥ 18**（内置 `fetch`）；唯一第三方依赖是 YAML 解析。

## 为什么需要它

ki 的 MCP 工具能告诉模型「这篇文档有哪些图、各自的 ref 是什么」，但**多数 MCP 客户端显示不了图片内容**（会把图片数据当超长文本截断）。所以取件交给 HTTP：

- **MCP** 负责回答「图在哪」（清单与元数据）
- **本工具** 负责把字节拿下来，落到本地，输出**绝对路径 + sha256**，交给你的编辑器/读图能力

同样的通道也能取正文，用于跨机归档、外部系统集成。

## 仓库位置

本包位于主仓的 `ki-client/` 子目录：**源码同仓，发布物独立**——它有自己的 `package.json`、独立依赖（只有 `yaml`）、独立版本号，不被 kisearch 的构建与依赖树影响。这样既能单独安装/发布，又不必为一份 HTTP 契约维护两个仓库。

## 安装

```bash
# 正式方式：进子目录构建后本地全局安装
cd ki-client && npm install && npm run build
npm i -g .

# 临时用（不安装）
node /path/to/repo/ki-client/dist/cli.js --help
```

> **为什么不是 `npm i -g github:<org>/<repo>/ki-client`**：npm 不支持带子目录的 git 地址。
>
> **也刻意没有**把 `ki-client` 挂进主包 `bin`——那会让每次安装 `ki` 都多跑一次子包构建，把客户端的问题绑成主包的安装失败。客户端坏了不该挡住 `ki` 本身的安装。

## 快速开始

```bash
# 1. 配一个源（token 建议走 stdin，不进 shell history）
echo "$KI_TOKEN" | ki-client remote add prod http://127.0.0.1:7423 --token-stdin

# 2. 自检：地址通不通、token 有没有效、服务端有没有开取件
ki-client ping --remote prod

# 3. 看图：把附件落到本地（保留子路径），输出绝对路径与 sha256
ki-client asset get --remote prod \
  --scope img-demo --group demo \
  --refs shots/composer.png --out ./tmp
```

## 多个源

```bash
echo "$TOKEN_A" | ki-client remote add prod http://10.0.0.5:7423 --token-stdin
echo "$TOKEN_B" | ki-client remote add test http://10.0.0.7:233 --token-stdin

ki-client remote list
ki-client ping --remote test
```

**配置了多个源时，每次操作都必须 `--remote` 指定**——本工具刻意不设默认源：最常见的误操作是把测试库的东西传到生产。

只有一个源时可以省略 `--remote`。也可以在没有任何配置源时用环境变量做一次性调用：

```bash
KI_URL=http://127.0.0.1:7423 KI_TOKEN=ki_xxx ki-client ping
```

## 配置文件

`~/.ki-client/config.yaml`（目录 `0700`、文件 `0600`，含明文 token，**不要提交到仓库**）：

```yaml
version: 1
remotes:
  prod:
    url: "http://127.0.0.1:7423"
    token: "ki_xxxx"
  test:
    url: "http://10.0.0.7:233"
    token: "ki_yyyy"
```

- 路径优先级：`--config` > `KI_CLIENT_CONFIG` > `~/.ki-client/config.yaml`
- **不读取工作区里的配置文件**（避免 clone 别人的仓库连到他的源）
- 同名源改地址时会**清空旧 token**（防止把 A 环境的凭证发给 B 环境）
- token 优先级：`KI_TOKEN_<源名大写>` > 配置文件里的 `token` > （单源时）`KI_TOKEN`

## 命令

| 命令 | 作用 |
|---|---|
| `remote add <名字> <地址> [--token <t>\|--token-stdin]` | 新增/更新源 |
| `remote list` / `show <名字>` / `remove <名字>` | 列出 / 查看 / 删除 |
| `ping [--remote] [--scope] [--json]` | 连通性、鉴权、契约版本、取件能力自检 |
| `asset get --scope --group --refs --out` | 附件落盘（输出绝对路径 + sha256） |
| `doc get --scope --group --relation --out` | 正文还原成 `.md` + 文中附件按相对路径落盘（`--no-assets` 只取正文） |
| `upload --scope <库> <文件...>` | 上传 markdown（可带 `--group` / `--tags` / `--lifecycle` / `--ttl-days` / `--event`） |
| `upload-dir --scope <库> <目录>` | 上传整个目录（保留相对路径；只收 `.md` 与 `assets/` 下的图片；默认增量） |
| `atlas upload --scope <库> --file <zip>` | 把图集包装进远端库（`--title` 补标题 / `--force` 强制重传 / `--json`） |
| `atlas status --scope <库>` | 核对已部署图集的基线、体积、包指纹 |
| `status --task <id>` | 查一次导入进度（`upload --wait` 会自动轮询到终态） |

### 上传：两条通道、分批、增量

**通道**（自动选，也可 `--archive` 强制）：

- **multipart**：**只用于「根目录的纯 markdown」**，最快。
- **tar.gz**：`--archive`、单批 >32MB、**或批次里出现子目录 / 图片时自动**。纯 Node 打 ustar + gzip。

> **为什么带图必须走 tar.gz**：当前服务端版本的 multipart 通道**不会落盘附件**——md 导入成功、`errors: 0`，但 `{group}/assets/` 是空的，文档里的图全部变成死链（静默，不报错）。同一份内容改用 tar.gz 就正常。客户端已自动规避，不需要你手动判断。

两条通道都受服务端 `mcp.http.uploadMaxBytes` 约束，所以**超大目录靠分批**，不是靠压缩：

```bash
ki-client upload-dir --scope kb --batch-bytes 33554432 ./docs   # 每批 ≤32MB
```

客户端会读 `ping` 回的 `limits.maxRequestBody`，若你给的 `--batch-bytes` 超过它，会按服务端上限自动收窄并提示一次。

**增量与断点续传**：HTTP 没有分片协议，中断就是整批丢，所以续传粒度是**文件级**——每个文件传成功后立刻记进 `~/.ki-client/state/<key>.json`（按「源 + 库 + 组 + 目录」派生），下次只补没记过或内容变了的文件。

```bash
ki-client upload-dir --scope kb ./docs          # 第二次跑：自动跳过未变化的
ki-client upload-dir --scope kb ./docs --force  # 强制全部重传
ki-client upload-dir --scope kb ./docs --no-state  # 不读不写状态文件
```

失败的批次**不写状态**，重跑同一条命令即可补齐。

全局参数：`--remote`、`--config`、`--json`、`--help`、`--version`。

`asset get` 的口径：

- 一次 1~3 张（`--refs a.png,b.png`），单张失败不中断其余，最后统一报告并返回非 0
- 落盘**保留 ref 的相对子路径**（`shots/a.png` → `<out>/shots/a.png`），拍平会让正文里的图片引用全断
- **默认不覆盖**已有文件，确认要覆盖加 `--overwrite`
- `ref` 越出输出目录会被本地拦下（不依赖服务端兜底）

## 部署图集（知识地图）

图集是一个单页 HTML 的 zip（由 `project-atlas` 生成）。`ki atlas upload` 只能装**本机**的 ki，
跨机就用这两条：

```bash
ki-client atlas upload --scope prod --file dist/atlas.zip
ki-client atlas status --scope prod
```

```
via remote=prod (http://10.0.0.7:7423)
已安装到 prod/.atlas/
  标题   订单链路
  基线   master@1c3dabf（生成 2026-11-24）
  条目   2 个 · entry atlas.html
  体积   248.8KB（zip 105.7KB）
  sha    9bad814a
  包指纹 3f21c0de4a1b
上一版已归档到 archive/
```

口径：

- **重复执行是安全的**：先查服务端 `packageSha256`，与本地算的一致就跳过（输出「已是最新」、退出码 0）。
  加 `--force` 才无条件重传。这条比 `upload-dir` 的增量更硬——它不依赖本地状态文件，
  所以别人（Web 页、另一台机器）传过一版也不会误跳。
- **一次一整包**，不分片。包上限读 `ping` 的 `capabilities.atlas.maxPackageSize`（服务端 20MB），
  超过时**本地就报错**，不会白传一遍。
- **装完页面立刻可见**：图集落在该库的 `.atlas/`，Web 的「知识地图」页读同一份数据，不用重启。
- **两个指纹别搞混**：回显里的 `sha` 是图集 HTML 的指纹，`包指纹` 才是你传的 zip 的 sha256
  （可用 `sha256sum dist/atlas.zip` 核对）。上传后客户端会自己比一次，不一致直接失败。
- **回滚**：重新上传上一版包即可（服务端保留一版在 `archive/`）。取回上一版包的能力尚未提供。
- 服务端太旧（不支持图集远程部署）会报 `CONTRACT_TOO_OLD` 并指向升级，不会抛一个 404 让你猜。

## 错误码

| code | 含义与出路 |
|---|---|
| `NO_REMOTE_SPECIFIED` | 配了多个源但没指定用哪个 → 加 `--remote` 或设 `KI_REMOTE` |
| `UNKNOWN_REMOTE` | 源名不存在 → `remote list` 看可用源 |
| `TOKEN_MISSING` | 该源没有可用 token → 设 `KI_TOKEN_<源名>` 或 `remote add --token-stdin` |
| `REMOTE_UNREACHABLE` | 连不上 → 先 `ping`；跨机检查防火墙与端口 |
| `CONTRACT_TOO_OLD` | 服务端缺能力：没有取件接口（或 `downloadApi` 关闭）、`uploadApi` 关闭、或不支持图集远程部署 → 升级服务端 / 请运维开启 |
| `FILE_EXISTS` | 目标文件已存在 → 加 `--overwrite` |
| `CONFIG_INVALID` | 配置文件解析或形状不对 → 按提示修正；未知配置项不会被静默忽略 |
| `SERVER_ERROR` | 服务端非 2xx，输出里带 `OPEN_API_*` 码与出路 |

## 开发

```bash
npm install
npm run build       # tsc → dist/
npm run typecheck
npm test            # 先 build，再跑 node:test（84 例：参数解析 / URL 拼接 / 文件名净化 /
                    #   配置读写 / 源解析 / ustar 打包（含真 tar 解包校验）/ HTTP 层 /
                    #   分批与通道选择 / md+附件分组 / 图集远程部署）
node dist/cli.js --help
```

单测跑的是 `dist/`（`node --test test/*.test.mjs`），所以不额外维护第二套 TS 构建配置；代价是测试本身不做类型检查。

## 不在本版范围

- 真机联调（当前全部验证打的是 mock `/open/v1`）
