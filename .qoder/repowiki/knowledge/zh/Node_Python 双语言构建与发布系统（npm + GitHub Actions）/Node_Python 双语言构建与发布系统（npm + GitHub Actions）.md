---
kind: build_system
name: Node/Python 双语言构建与发布系统（npm + GitHub Actions）
category: build_system
scope:
    - '**'
source_files:
    - package.json
    - bin/ki.mjs
    - tsconfig.src.json
    - scripts/release.sh
    - scripts/install-latest.sh
    - web/package.json
    - web/vite.config.ts
    - zvec-mcp-server/pyproject.toml
    - zvec-mcp-server/.github/workflows/ci.yml
    - zvec-mcp-server/.github/workflows/release.yml
---

## 1. 使用的系统与工具

本仓库是一个多子项目工程，包含两个独立可发布的产物：
- **主包 `kisearch`**（Node.js / TypeScript CLI 工具，入口 `bin/ki.mjs`）
- **Python MCP Server `zvec-mcp-server`**（Python 包，入口 `src/zvec_mcp/__main__.py`）

构建与发布采用以下工具链：
- Node 侧：`typescript` (`tsc`) 编译、`jiti` 直接运行 `.ts` 脚本（CLI 通过 `spawn('npx', ['jiti', ...])` 动态加载）、`npm pack` 打包、`package.json scripts` 管理任务。
- Python 侧：`uv` 作为依赖与虚拟环境管理器、`python -m build` 构建源码分发、`twine check` 校验、`pytest` 测试、`ruff` 做 lint/format。
- CI/CD：GitHub Actions（`.github/workflows/`），触发条件为 push PR/main/master 或 tag `v*`。
- Web UI（`web/` 子目录）：基于 Vite + React + TypeScript，独立 `package.json`，构建命令 `vite build`。

## 2. 关键文件

| 文件 | 作用 |
|---|---|
| `package.json` | 根 npm 包定义，声明 `bin/ki.mjs` 全局命令、`scripts`（build/test/e2e）、`files` 发布清单、`engines.node >= 18` |
| `bin/ki.mjs` | CLI 路由入口，将 `ki <cmd>` 转发到 `src/*.ts` 并通过 `jiti` 执行；支持 `--daemon` 后台模式、信号透传、`--config` 全局参数 |
| `tsconfig.json` / `tsconfig.src.json` | TypeScript 编译配置（`build` 使用 `tsconfig.src.json`） |
| `scripts/release.sh` | 本地发布脚本：校验版本一致性 → 检查工作区干净 → 运行 `npm test` → `npm pack` → 打 git tag → 调用 `gh release create` 上传 tarball |
| `scripts/install-latest.sh` | 用户安装器：通过 GitHub API / gh CLI / 页面重定向三种方式获取最新 tgz 并 `npm install -g` |
| `web/package.json` + `web/vite.config.ts` | Web 前端独立构建（dev/build/preview/typecheck） |
| `zvec-mcp-server/pyproject.toml` | Python 包元数据（由 `build` 读取） |
| `zvec-mcp-server/.github/workflows/ci.yml` | CI：矩阵测试（ubuntu/macos × Python 3.10–3.14），运行 ruff + pytest，上传 codecov |
| `zvec-mcp-server/.github/workflows/release.yml` | Release：tag `v*` 触发，`uv venv` + `python -m build` + `twine check` + 发布 PyPI |

## 3. 架构与约定

### Node 包（kisearch）
- **运行时不预编译**：CLI 通过 `spawn('npx', ['jiti', scriptPath, ...args])` 在运行时即时编译 `.ts`，因此 `npm pack` 的 `files` 字段必须包含 `src/**/*`，否则生产环境无法运行。
- **命令注册集中化**：所有 `ki <command>` 子命令在 `bin/ki.mjs` 的 `COMMANDS` 映射中声明，新增命令需同时添加映射。
- **发布产物**：仅通过 `npm pack` 生成 tarball，不产出 `dist/` 二进制；`package.json.files` 控制打包内容（`bin/**`, `src/**`, `_template/**`, `scripts/*.sh`, `README.md`, `LICENSE` 等）。
- **版本来源单一**：版本号来自 `package.json.version`，`release.sh` 强制要求传入版本与之一致。

### Python 包（zvec-mcp-server）
- **标准 PEP 517 构建**：使用 `python -m build` 生成 sdist/wheel，`twine check` 校验后再发布。
- **CI 矩阵覆盖多 Python 版本**：3.10–3.14 全部测试，但仅用 3.11 上传 coverage。
- **Release 触发**：仅当 push tag 匹配 `v*` 时触发 PyPI 发布。

### Web 前端（web/）
- 独立于根包的 Vite 应用，构建流程为 `tsc --noEmit && vite build`，不纳入根包发布。

## 4. 约定与约束

- **Node 版本约束**：`package.json.engines.node >= 18.0.0`，运行环境必须满足。
- **发布前必须通过测试**：`scripts/release.sh` 显式执行 `npm test`，失败则中止发布。
- **工作区必须干净**：`release.sh` 使用 `git diff-index --quiet HEAD` 检查未提交变更，有差异即拒绝发布。
- **关键文件存在性校验**：`release.sh` 在打包前检查 `bin/ki.mjs`、`src/mcp-server.ts`、`README.md`、`package.json` 是否存在。
- **Git Tag 命名规范**：Release 使用 `v${VERSION}` 格式 tag（如 `v0.2.0`），PyPI 发布也仅在 `refs/tags/v*` 时触发。
- **CI 分支策略**：CI 对 `main`、`master` 分支的 push 和 PR 均触发。
- **Python 依赖管理**：统一使用 `uv`（`astral-sh/setup-uv@v3`）创建 venv 并安装依赖，不再使用 pip/venv 原生命令。
- **Web 构建与 Node 包解耦**：`web/` 子项目拥有独立 `package.json` 和构建脚本，不参与根包发布。
- **CLI 守护进程约定**：`ki mcp --http --daemon` 模式下，父进程会进行 3 秒存活探测，子进程早期失败会被捕获并返回非零退出码。