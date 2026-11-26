# ki-client：从远端 ki 取回正文和图片

MCP 只能告诉模型「这篇文档有哪些图、各自的 ref 是什么」，**图片内容本身多数 MCP 客户端显示不了**（会被当成长文本截断）。取字节这件事交给 `ki-client`：它把图片或正文下载到本地，输出绝对路径与 sha256，直接交给编辑器或读图能力。

反过来也能传：把本地 Markdown 目录、或者打包好的知识地图，推到另一台机器上的 ki。

一句话分工：

| 我想… | 用什么 |
|---|---|
| 知道文档里有哪些图、ref 是什么 | MCP 的 `ki_get_module_info`（返回 `images[]`） |
| 把图真正拿到本地 | `ki-client asset get` |
| 把整篇正文连图一起拿走 | `ki-client doc get` |
| 把一组 Markdown 传到远端 | `ki-client upload-dir` |
| 把知识地图装到远端 | `ki-client atlas upload` |

前提：远端那台机器上的 ki 已开启 HTTP 服务（`ki mcp --http`；要在浏览器里看页面再加 `--web`），并且你有可用的 Token。Token 的签发见 [cli.md 的 `mcp token` 章节](./cli.md#mcp)。

---

## 安装

### 方式一：从 Release 附件装（不需要仓库源码）

```bash
# 最新正式版
npm install -g https://github.com/HACK-WU/kisearch/releases/latest/download/ki-client.tgz

# 指定版本（只有预发布版时 latest 不指向它，把 <主包tag> 换成具体值，例如 v1.2.0-beta）
npm install -g https://github.com/HACK-WU/kisearch/releases/download/<主包tag>/ki-client.tgz
```

### 方式二：源码安装

```bash
git clone git@github.com:HACK-WU/kisearch.git
cd kisearch/ki-client
npm install
npm run build
npm i -g .
```

两点容易踩：

- **必须在 `ki-client` 目录里执行 `npm i -g .`**。在仓库根执行装的是主包 `ki`，不是客户端。
- 装完 `ki-client` 就是一个独立命令，以后升级它不影响 `ki`，反过来也一样。

### 方式三：不安装，直接跑

```bash
node /path/to/kisearch/ki-client/dist/cli.js --help
```

### 装完确认

```bash
ki-client --version    # 输出形如 0.1.0
ki-client --help       # 命令总览
```

需要 **Node ≥ 18**（主包 `ki` 要 ≥ 22.20，两者要求不同）。

---

## 配一个源

源 = 一个远端 ki（地址 + Token），类比 `git remote`。

```bash
# Token 走 stdin：不会进 shell history，也不会出现在 ps 里
echo "$KI_TOKEN" | ki-client remote add prod http://10.0.0.5:7423 --token-stdin

ki-client remote list          # 有哪些源
ki-client remote show prod     # 单个源的详情
ki-client remote remove prod   # 删掉
```

几个行为要知道：

- **配了多个源时，每条命令都必须带 `--remote <名字>`**。这是刻意不设默认源——最常见的误操作是把测试库的东西传到生产。
- 只有一个源时可以省略 `--remote`；也可以用 `KI_REMOTE=prod` 指定默认源。
- 完全没配源时，可以用环境变量做一次性调用：`KI_URL=http://127.0.0.1:7423 KI_TOKEN=ki_xxx ki-client ping`。
- 同名源换地址会**清空旧 Token**，避免把 A 环境的凭据发给 B 环境。换完记得重新配 Token。

---

## 自检：ping

```bash
ki-client ping --remote prod --scope kb
```

它回答四件事：地址通不通、Token 有没有效、服务端是哪一版契约、**取件与上传能力是否开启**（以及单次请求体、单张附件的上限），并列出当前 Token 能访问的库（「授权库」一行）。

- Token **只授权了部分库时必须带 `--scope`**：不带时服务端按 `default` 库判断权限，Token 没授权 `default` 就直接报 403 `OPEN_API_SCOPE_FORBIDDEN` —— 看着像 Token 失效，其实只是没指明库，补 `--scope <你的库>` 即可。
- 想确认自己到底能访问哪些库，就看 ping 成功时的「授权库」一行；ping 本身 403 时响应不含这份清单，只能在 ki 所在机器执行 `ki mcp token list` 查看。

配完源先跑一次；升级服务端或换机器之后也跑一次。报 `CONTRACT_TOO_OLD` 时，原因就在这四项里。

---

## 取图：asset get

```bash
ki-client asset get --remote prod \
  --scope img-demo --group demo \
  --refs shots/composer.png --out ./tmp
```

| 参数 | 说明 |
|---|---|
| `--scope` | 图所在的知识库 |
| `--group` | 图所在文档的 Group（与读文档时一致） |
| `--refs` | 一个或多个 ref，逗号分隔；**一次 1~3 张** |
| `--out` | 落盘目录 |
| `--overwrite` | 允许覆盖已存在的同名文件（默认不覆盖） |
| `--json` | 机器可读输出 |

`ref` 从哪来：`ki_get_module_info` 返回的 `images[].ref`，或 `doc get` 取回的正文里的相对路径。

口径：

- **落盘保留 ref 的相对子路径**：`shots/a.png` → `<out>/shots/a.png`。拍平会让正文里的图片引用全部失效。
- 输出**绝对路径 + sha256**，可直接喂给编辑器或读图工具。
- 单张失败不中断其余，最后统一报告，并以非 0 退出。
- `ref` 如果越出 `--out` 目录（例如被手工写成 `../../etc/passwd`），本地就会拒绝，不会写到别处去。

---

## 取正文：doc get

```bash
ki-client doc get --remote prod \
  --scope wiki --group 部署运维 --relation 灰度发布流程 --out ./docs
```

- 正文还原成 `<out>/<文档名>.md`，文中引用的附件按相对路径一并落盘（目录结构保持原样）。
- **`--relation` 填文档在库里的名字**（导入时的文件名去掉 `.md`），不是正文里的标题；`--group` 也要与库里一致。两者对不上会提示 `OPEN_API_NOT_FOUND`，先用 `ki_get_module_info` 核对再取。同名冲突后来加了后缀的，以导入结果里显示的名字为准。
- **正文与附件分开处理**：正文先保存，附件再逐个取。文中引用的**外链图片取不到属正常现象**（它们不是库内附件），这时退出码会是非 0，但正文已经完整落盘 —— 不要据此判定整体失败。
- `--no-assets` 只取正文、完全不取图（正文里会留下指向缺失图片的引用），此时退出码为 0。
- `--overwrite` 允许覆盖已存在文件。

适合跨机归档、把知识库内容接到别的系统里。

---

## 上传：upload / upload-dir

```bash
ki-client upload --scope kb ./note.md --group wiki --wait     # 单个文件
ki-client upload-dir --scope kb ./docs --group wiki           # 整个目录，保留相对路径
```

只收两类文件：`.md`，以及图片（`.png` / `.jpg` / `.jpeg` / `.gif` / `.svg` / `.webp` / `.ico` / `.bmp` / `.avif`）。**图片放在哪个目录都可以**——`images/`、`screenshots/`、`assets/` 都行，只要正文里的引用路径与它对应得上。其它后缀的文件会被跳过，并告诉你跳过了多少个。

两种上传方式都**保留目录结构**：`upload docs/a.md` 落成 group 下的 `docs/a.md`，`upload-dir ./docs` 同样保留相对层级。这不是装饰——正文里 `./images/x.svg` 这类引用只有在结构完整时才对得上，图片才能跟着落库。

常用参数：

| 参数 | 说明 |
|---|---|
| `--group` | 落点 Group，不存在时自动创建 |
| `--tags` | 逗号分隔的标签 |
| `--lifecycle` / `--ttl-days` | 文档分类与保留期 |
| `--event` | 把上传的文档挂到某个事件上 |
| `--wait` | 传完等导入跑完再返回（并据此判断成功与否） |
| `--batch-bytes` | 每批上限，默认 64MB（单批超 32MB 时改用打包通道） |
| `--archive` | 强制走打包通道 |
| `--force` / `--no-state` | 忽略增量状态全传 / 不读不写状态 |
| `--allow-missing-assets` | 正文引用的图片没随包上传时，默认按失败返回；加上它降级为警告 |
| `--prune` | 传完列出「远端库里有、这次目录里已经没有」的文档（只列不删，见下） |

四条机制，不必记，但要知道会怎样：

- **通道自动选择**：根目录的纯 Markdown 走 multipart（最快）；出现子目录或图片、或单批过大时自动改用 tar.gz。历史上 multipart 传图会静默丢附件（服务端已修，现在两条通道都收图片），客户端仍按这个规则选——一次请求带上完整目录层级、少一轮往返。你不用判断。
- **超大批次靠分批**：每批大小受服务端 `mcp.http.uploadMaxBytes` 约束。你给的 `--batch-bytes` 超过服务端上限时，会自动收窄并提示一次。
- **增量是文件级的**：每个文件传成功后立刻记进 `~/.ki-client/state/`，下次只补没记过或内容变了的。**失败的批次不写状态**，重跑同一条命令即可补齐。
- **缺图默认算失败**：正文引用了某张图、但上传的文件里没有它时，服务端不会报错（导入成功、图变死链），所以客户端替你兜住——逐条列出缺失、并按退出码 1 返回。确认这些图本来就不需要，加 `--allow-missing-assets` 即可降级为警告。

### 同步清理：`--prune`

本地删掉的文档，远端库里还留着——`--prune` 在传完之后把这类文档列出来：

```bash
ki-client upload-dir --scope kb ./docs --group wiki --prune
```

- **只列不删**：远端 Token 通道没有删除权限。`--prune` 只打印候选清单和每条的原因，不改动任何文档。
- **什么时候用**：目录长期增量同步（比如知识地图导出后反复推）、库里攒了本地早就不存在的旧文档。
- **目录里什么都没变也能用**：全部文件都没变化时不会重传，但差异照样算一遍。
- **危险情况不会给候选**：一次会删掉库里八成以上的文档、或者你给的路径与库里现有文档重合不到八成时，它只说明原因、不给清单——通常意味着目录选错了一层。
- **怎么删**：到 Web「写入 → 目录同步清理」勾选确认；或在远端那台机器上执行 `ki import --source <同一目录> --group <组> --prune --yes`（不带 `--yes` 只预览）。
- 服务端太旧（不支持这个查询）会报 `CONTRACT_TOO_OLD`，不会甩一个 404 让你猜。

---

## 部署知识地图：atlas upload / status

图集是「单页 HTML 的 zip」（由 `project-atlas` 之类流程打包出来）。

```bash
ki-client atlas upload --remote prod --scope prod --file dist/atlas.zip
ki-client atlas status --remote prod --scope prod
```

- **重复执行是安全的**：先比对服务端已装包的指纹，一致就跳过（输出「已是最新」、退出码 0）；`--force` 才无条件重传。这条不依赖本地状态，别人传过一版也不会误跳。
- **一次一整包，不支持分片**。包上限读 `ping` 回显（当前 20MB），超了本地就报错，不会白传一遍。
- **装完页面立刻可见**：Web 的「知识地图」页读的就是这份数据，不用重启。
- **两个指纹别搞混**：`sha` 是图集 HTML 的指纹，`包指纹` 才是你传的那个 zip 的 sha256（可用 `sha256sum dist/atlas.zip` 核对）。
- **回滚**：重新上传上一版包即可，服务端保留一版在 `archive/`。
- 服务端太旧（不支持图集远程部署）会报 `CONTRACT_TOO_OLD` 并提示升级，不会甩一个 404 让你猜。

---

## 配置文件与凭据

`~/.ki-client/config.yaml`（目录权限 `0700`、文件 `0600`），**里面有明文 Token，不要提交到仓库**：

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
- **不读取工作区里的配置文件**——避免 clone 别人的仓库后连到对方的源。
- Token 优先级：`KI_TOKEN_<源名大写>` > 配置文件里的 `token` > （仅单源时）`KI_TOKEN`

---

## 出错了怎么补救

| 提示 | 含义与出路 |
|---|---|
| `NO_REMOTE_SPECIFIED` | 配了多个源但没指定用哪个 → 加 `--remote`，或设 `KI_REMOTE` |
| `UNKNOWN_REMOTE` | 源名不存在 → `ki-client remote list` 看可用源 |
| `TOKEN_MISSING` | 该源没有可用 Token → `echo "$T" \| ki-client remote add ... --token-stdin`，或设 `KI_TOKEN_<源名>` |
| `REMOTE_UNREACHABLE` | 连不上 → 先 `ping`；跨机检查防火墙与端口 |
| `CONTRACT_TOO_OLD` | 服务端缺能力：没开取件接口、没开上传接口、或不支持图集远程部署 → 升级服务端，或请运维打开对应开关 |
| `FILE_EXISTS` | 目标文件已存在 → 加 `--overwrite` |
| `CONFIG_INVALID` | 配置文件解析或结构不对 → 按提示修正；未知配置项不会被静默忽略 |
| `OPEN_API_SCOPE_FORBIDDEN` | Token 未被授权访问这个库。**最常见的原因是命令里根本没带 `--scope`**（服务端按 `default` 库判断权限）→ 补上 `--scope <你的库>` 重试；403 时的响应不含授权清单，要看清单得在 ki 所在机器执行 `ki mcp token list` |
| `OPEN_API_NOT_FOUND` | 取件时 `--group` / `--relation` 与库里的落点对不上（`--relation` 是文档名，不是正文标题）；上传时路径或接口不对 |
| `OPEN_API_TOKEN_READONLY` | 用的是只读 Token，不能上传 → 换读写 Token，或让管理员执行 `ki mcp token update <id> --read-write` |
| `OPEN_API_SCOPE_READONLY` | 目标库被设成只读 → 让管理员执行 `ki scope readonly <库名> --off` |
| `SERVER_ERROR` | 服务端返回非 2xx → 输出里带具体错误码与出路 |

更细的服务端错误码见 [open-api.md](./open-api.md)。

---

## 限制与前提

- 远端必须开启 HTTP 服务；取件与上传是**两个独立开关**（`mcp.http.downloadApi` / `mcp.http.uploadApi`，默认都开）。运维可能只关其中一侧：例如只关上传（防止外部写入污染库），取件仍然可用。
- 关闭时对应端点直接 404，`ki-client` 会报 `CONTRACT_TOO_OLD` 而不是让你以为是路径写错。
- 一次取图最多 3 张；图集包最大 20MB；单次上传批次受服务端请求体上限约束。
- 客户端不设默认源，也不猜测你想连哪台机器。

---

## 相关文档

- [open-api.md](./open-api.md) —— 底层 HTTP 契约（`/open/v1/*`），不想装客户端时用 `curl` 也能做完同样的事
- [mcp-tools.md](./mcp-tools.md) —— `ki_get_module_info` 如何返回 `images[]` 与 `ref`
- [cli.md](./cli.md#mcp) —— 签发 Token、查看 MCP 服务状态
- [ki-client/README.md](../ki-client/README.md) —— 子包自述（开发向：构建、测试、实现取舍）
