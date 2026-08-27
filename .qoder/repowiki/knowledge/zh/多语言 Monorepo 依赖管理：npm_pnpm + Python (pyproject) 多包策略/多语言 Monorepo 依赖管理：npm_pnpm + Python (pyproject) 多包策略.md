---
kind: dependency_management
name: 多语言 Monorepo 依赖管理：npm/pnpm + Python (pyproject) 多包策略
category: dependency_management
scope:
    - '**'
source_files:
    - package.json
    - package-lock.json
    - web/package.json
    - web/package-lock.json
    - zvec-studio/package.json
    - zvec-studio/pnpm-workspace.yaml
    - zvec-studio/apps/backend/pyproject.toml
    - zvec-studio/apps/backend/uv.lock
    - zvec-studio/apps/frontend/package.json
    - zvec-studio/packages/api-client/package.json
    - zvec-mcp-server/pyproject.toml
    - zvec-studio/apps/desktop/src-tauri/Cargo.toml
---

## 1. 使用的系统/工具

本仓库是一个跨语言的 Monorepo，按子模块分别采用各自生态的标准依赖管理方案：

- **Node.js 核心工程（ki CLI、web 前端）**：使用 `package.json` + `package-lock.json`（npm lockfile v3），通过 npm 解析依赖。
- **zvec-studio 子仓库**：使用 pnpm workspace 进行多包管理，根目录的 `package.json` 声明 `pnpm-workspace.yaml` 与 `packageManager: "pnpm@9.12.0"`，并通过 `pnpm -r` / `--filter` 在 workspace 内统一编排脚本；其内部 `apps/backend` 使用独立的 `pyproject.toml` + `uv.lock`（Python），`apps/frontend` 使用独立 `package.json` 作为 workspace 成员。
- **zvec-mcp-server（Python MCP 服务）**：使用 `pyproject.toml`（hatchling 构建后端）声明依赖，未检出 `requirements.txt`，依赖版本以 `>=` 宽松区间声明。
- **zvec-studio/apps/backend（Python FastAPI 后端）**：同样使用 `pyproject.toml`（setuptools 构建后端），并附带 `uv.lock` 锁定文件。

未发现 Go（`go.mod`）、Rust Cargo（除 zvec-studio desktop Tauri 子 crate 自带 `Cargo.toml`/`Cargo.lock` 外）等其它语言依赖清单。

## 2. 关键文件

| 位置 | 作用 |
|---|---|
| `package.json`、`package-lock.json` | ki CLI 主工程的 Node 依赖与锁文件 |
| `web/package.json`、`web/package-lock.json` | Web 前端（React+Vite）依赖 |
| `zvec-studio/package.json`、`zvec-studio/pnpm-workspace.yaml`、`zvec-studio/pnpm-lock.yaml` | Studio 多包工作区定义与锁文件 |
| `zvec-studio/apps/backend/pyproject.toml`、`zvec-studio/apps/backend/uv.lock` | Studio 后端 Python 依赖及锁定 |
| `zvec-studio/apps/frontend/package.json` | Studio 前端依赖，引用 workspace 包 `@zvec-studio/api-client` |
| `zvec-studio/packages/api-client/package.json` | 由 OpenAPI 自动生成的 TypeScript 客户端包 |
| `zvec-mcp-server/pyproject.toml` | Zvec MCP Server Python 依赖 |
| `zvec-studio/apps/desktop/src-tauri/Cargo.toml`、`Cargo.lock` | Tauri 桌面壳 Rust 依赖（独立于主仓库） |

## 3. 架构与约定

- **按子模块隔离依赖**：每个可独立发布的子项目（ki、web、zvec-studio、zvec-mcp-server）都拥有自己的依赖清单，不存在跨包的共享 `node_modules` 或全局 `requirements.txt`。
- **Workspace 内包引用**：zvec-studio 通过 pnpm workspace 机制，在 `apps/frontend/package.json` 中以 `workspace:0.1.0-dev` 引用同仓库的 `packages/api-client`，实现类型安全的本地包复用。
- **依赖版本策略**：
  - Node 侧普遍使用 `^` 前缀（如 `commander ^14.0.0`、`react ^18.3.1`），允许次级/补丁升级，具体版本由 lockfile 固化。
  - Python 侧对关键库采用“宽松下限 + 严格上限”的区间写法（如 `fastapi >=0.115,<0.120`、`zvec >=0.5,<0.6`、`numpy >=1.23,<2.5`），避免破坏性升级。
- **引擎/运行时约束**：通过 `engines` 字段声明最低 Node 版本（根 `>=18.0.0`，zvec-studio `>=20`），Python 通过 `requires-python` 限制 `>=3.10,<3.15`。
- **构建产物中的依赖**：根 `package.json` 的 `files` 字段显式声明发布时包含 `bin/**`、`src/**`、`dist/zvec-engine/**`、`src/zvec-engine/**` 等，确保 CLI 与内置 zvec-engine 源码随包分发。

## 4. 约定与约束

- **Lockfile 必须提交**：所有 Node 子工程均提交了对应的 `package-lock.json`，pnpm workspace 也提交 `pnpm-lock.yaml`，Python 后端提交 `uv.lock`，保证安装可复现。
- **禁止裸 `pip install`**：zvec-studio 后端明确使用 `uv.lock`，应通过 uv 或 pip 基于该 lockfile 安装，而非自由升级依赖。
- **可选依赖分离**：AI 相关能力（sentence-transformers、dashtext、dashscope、openai 等）被放入 `optional-dependencies` 的 `ai` 组，默认不安装，代码中通过 `ImportError` 优雅降级返回 HTTP 503，避免非 AI 场景的安装失败。
- **包管理器锁定**：zvec-studio 通过 `packageManager: "pnpm@9.12.0"` 强制使用指定版本的 pnpm，避免不同开发者环境差异。
- **无 vendoring**：未发现 `vendor/`、`third_party/` 等第三方源码内联目录；所有依赖均通过包管理器从公共注册表（npm registry、PyPI）拉取。
- **私有注册表/GOPRIVATE**：当前仓库未检出 `.npmrc`、`.pypirc`、`GOPRIVATE` 等私有源配置；依赖来源均为公开注册表。