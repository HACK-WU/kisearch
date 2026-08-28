---
kind: dependency_management
name: 多语言多工作区依赖管理（npm + lockfile + Python pyproject）
category: dependency_management
scope:
    - '**'
source_files:
    - package.json
    - package-lock.json
    - web/package.json
    - web/package-lock.json
    - zvec-mcp-server/pyproject.toml
    - zvec-probe-node/package.json
---

## 1. 使用的系统/方法

仓库是一个多语言、多工作区的聚合项目，依赖管理按语言分别采用各自生态的标准方案：

- **Node.js / TypeScript**：使用 npm 包管理器，通过根目录 `package.json` 声明 CLI 与核心库的运行时依赖，并通过 `package-lock.json`（lockfileVersion 3）锁定精确版本；Web 前端位于独立子工作区 `web/`，拥有独立的 `web/package.json` 与 `web/package-lock.json`。
- **Python**：子模块 `zvec-mcp-server/` 使用基于 `hatchling` 的 `pyproject.toml` 声明依赖（`[project]` 下的 `dependencies`），构建后端为 `hatchling.build`，版本由 `hatch-vcs` 从 VCS 动态生成。
- **探针工具**：`zvec-probe-node/` 是独立的轻量 Node 工作区，仅依赖 `@zvec/zvec`，并自带自己的 `package.json`。

没有发现 vendoring（如 `vendor/` 或 `node_modules` 内联提交）策略；`node_modules/` 在根目录存在但为空，说明依赖在安装时按需拉取。未检出 `.npmrc`、`pnpm-lock.yaml`、`yarn.lock`、`go.mod`、`requirements.txt` 等其它格式文件，因此本仓库统一以 npm + lockfile 和 Python `pyproject.toml` 为主。

## 2. 关键文件

- `package.json`：根工作区入口，定义 `name: kisearch`、`bin: ki`、`engines.node >= 18.0.0`、运行时依赖（`@modelcontextprotocol/sdk`、`@zvec/zvec`、`commander`、`jiti`、`yaml`、`zod`）以及 devDependencies（`typescript`、`@types/node`）。
- `package-lock.json`：npm v3 锁文件，记录所有已解析依赖的精确版本、来源 registry（例如 `registry.npmmirror.com`）及 integrity hash。
- `web/package.json` + `web/package-lock.json`：Web UI 子工作区，依赖 React、Vite、Mermaid、React Router 等，与根工作区解耦。
- `zvec-mcp-server/pyproject.toml`：Python MCP Server 的依赖声明，要求 `requires-python >=3.10,<3.15`，运行时依赖包括 `zvec>=0.3.0`、`mcp>=1.1.2`、`pydantic>=2.0.0`、`openai>=2.24.0`，并提供 `dev` optional-dependencies（pytest、ruff 等）。
- `zvec-probe-node/package.json`：独立探针工具，仅依赖 `@zvec/zvec ^0.5.0`。

## 3. 架构与约定

- **多工作区隔离**：每个可独立安装/发布的组件（CLI、Web UI、Python MCP Server、探针）都有自己独立的依赖清单，避免跨组件污染。
- **版本范围策略**：所有依赖均使用 caret 范围（`^x.y.z`），允许小版本升级，配合 lockfile 保证可重复构建；Python 侧同样使用 `>=` 范围。
- **二进制暴露**：根 `package.json` 通过 `bin.ki` 将 `bin/ki.mjs` 暴露为全局命令，使 `kisearch` 作为 npm 包发布后可直接运行 `ki`。
- **构建/测试脚本**：根 `scripts` 大量使用 `npx jiti <file>.ts` 直接执行 TypeScript 源文件，无需预先编译即可运行测试与 CLI；`build` 则调用 `tsc -p tsconfig.src.json` 产出 `dist/`。
- **引擎约束**：通过 `engines.node >= 18.0.0` 强制 Node 版本下限；Python 侧通过 `requires-python` 限制 3.10–3.14。

## 4. 约定与约束

- **必须提交 lockfile**：根与 `web/` 均提交了对应的 `package-lock.json`，用于固定依赖树，确保 CI 与本地复现一致。
- **禁止裸 node_modules**：根 `node_modules/` 目录存在但为空，表明不应将依赖缓存提交进仓库；依赖应通过 `npm install` 从 registry 拉取。
- **Python 依赖集中声明**：`zvec-mcp-server` 的所有依赖集中在 `pyproject.toml` 的 `[project.dependencies]` 中，开发依赖放入 `[project.optional-dependencies].dev`，不混用 `requirements.txt`。
- **无私有 registry 配置**：未发现 `.npmrc`、`PIP_INDEX_URL`、`PYPI_MIRROR` 等自定义镜像配置；锁文件中出现 `registry.npmmirror.com` 表明可能使用了淘宝镜像进行解析，但这是环境级行为而非仓库内配置。
- **无 vendoring**：未发现任何第三方源码被拷贝到仓库内（无 `vendor/`、`third_party/` 等），全部通过包管理器远程获取。
- **版本上限约束**：Python 侧显式限定 `requires-python = ">=3.10,<3.15"`，对 Node 侧通过 `engines.node >= 18.0.0` 设定下限，形成明确的运行时兼容边界。
