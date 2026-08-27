---
kind: build_system
name: 多语言 Monorepo 构建与发布体系（ki CLI / zvec-studio / zvec-mcp-server）
category: build_system
scope:
    - '**'
source_files:
    - package.json
    - tsconfig.json
    - tsconfig.src.json
    - scripts/release.sh
    - scripts/install-latest.sh
    - web/package.json
    - zvec-studio/Makefile
    - zvec-studio/.github/workflows/ci.yml
    - zvec-studio/.github/workflows/release.yml
    - zvec-studio/scripts/build_sidecar.py
    - zvec-mcp-server/.github/workflows/ci.yml
    - zvec-mcp-server/.github/workflows/release.yml
---

## 1. 整体方案

本仓库是一个多语言 Monorepo，包含三个独立可发布的产物：
- **ki CLI**（Node/TypeScript，npm 包 `kisearch`）
- **zvec-studio**（Python FastAPI + React + Tauri Desktop，pnpm workspace + Makefile）
- **zvec-mcp-server**（Python FastMCP，PyPI 包）

每个子项目各自维护独立的构建、测试、打包与发布流程，通过 GitHub Actions 在 CI 中串联。根目录没有统一的顶层 Makefile，而是按子模块组织。

## 2. 核心文件与入口

- **ki CLI**
  - `package.json`：定义 `bin.ki = ./bin/ki.mjs`，版本 `0.2.0-beta`，`engines.node >= 18`。
  - `tsconfig.json`：编译 `src/**/*.ts` 到 `dist/`，目标 ES2022，moduleResolution=bundler。
  - `tsconfig.src.json`：单独编译 `src/zvec-engine/**` 到 `dist/zvec-engine/`，生成声明与 source map。
  - `scripts/release.sh`：本地发布脚本，校验版本号、工作区干净、运行 `npm test`、`npm pack`、打 tag、用 `gh release create` 上传 tarball。
  - `scripts/install-latest.sh`：用户侧安装器，通过 GitHub API / gh CLI / 页面重定向三种方式探测最新版本并 `npm install -g`。
  - 测试：`test/*.test.ts` 通过 `npx jiti` 直接运行；`test/e2e/*.mjs` 通过 `node --test` 运行。

- **zvec-studio**（Monorepo）
  - `zvec-studio/Makefile`：统一编排 pnpm workspace（frontend/desktop/api-client）、Python backend（uv sync）、Tauri desktop 的 build/lint/test/package。
  - `zvec-studio/.github/workflows/ci.yml`：对 Python 3.10–3.12 矩阵跑 ruff/mypy/pytest（unit/integration/contract），覆盖率门限 60%；前端 Node 20/22 矩阵跑 lint/typecheck/unit；Desktop 走 cargo fmt/clippy/test；E2E 用 Playwright；安全审计 pip-audit/pnpm audit/cargo-audit；DCO Signed-off-by 检查。
  - `zvec-studio/.github/workflows/release.yml`：触发条件 `v*` tag，四平台并行（macOS ARM64 / Linux x86_64 & ARM64 / Windows x64），步骤：PyInstaller 冻结 sidecar → pnpm frontend build → 注入 git tag 到 tauri.conf.json → `tauri build` → macOS ad-hoc 签名 → 安装后 smoke test → 收集 .deb/.AppImage/.dmg/.exe/.msi 等 artifact → 创建 GitHub Release → 另起 job 将前端内嵌的 wheel 发布到 PyPI。
  - `zvec-studio/scripts/build_sidecar.py`：把 FastAPI sidecar 冻结为单文件二进制。

- **zvec-mcp-server**
  - `zvec-mcp-server/.github/workflows/ci.yml`：5 个 Python 版本（3.10–3.14）× 双 OS 矩阵，ruff check/format + pytest，覆盖率上报 Codecov。
  - `zvec-mcp-server/.github/workflows/release.yml`：tag 触发，`python -m build` + `twine check` + `pypa/gh-action-pypi-publish` 发布到 PyPI。

## 3. 架构与约定

- **构建工具分层**：Node 侧用 `tsc` + `vite` + `pnpm workspace`；Python 侧用 `uv` 管理虚拟环境与依赖，`build`/`wheel` 打包；桌面端用 Tauri v2 原生打包。
- **版本来源**：ki CLI 版本来自 `package.json`；zvec-studio 版本从 git tag 注入到 `apps/backend/pyproject.toml` 和 `apps/desktop/src-tauri/tauri.conf.json`；zvec-mcp-server 由 pyproject 管理。
- **发布产物**：ki CLI 产出 npm tarball (`kisearch-<version>.tgz`)；zvec-studio 产出多平台桌面安装包 + PyPI wheel；zvec-mcp-server 产出标准 Python sdist/wheel。
- **CI 门禁**：所有 PR/Push 都经过 lint → typecheck → unit → integration → contract → coverage gate → e2e → security audit 的流水线；release 仅在 `v*` tag 上触发。
- **开发体验**：`make dev` 同时启动 backend (uvicorn) 与 frontend (Vite)；`make verify` 是完整任务级门禁；`make verify.fast` 跳过慢路径；`make package` 完成 sidecar + Tauri bundle。

## 4. 约定与约束

- ki CLI 要求 Node ≥ 18（`package.json.engines`），运行时通过 `jiti` 直接执行 `.ts` 源码，无需预编译即可运行命令。
- 发布前必须满足：`package.json` 版本与传入参数一致、工作区无未提交变更、关键文件存在、`npm test` 全部通过（`scripts/release.sh` 强制退出）。
- zvec-studio 后端单元测试覆盖率必须 ≥ 60%（`--cov-fail-under=60`），否则 CI 失败。
- Desktop 构建需要 Rust toolchain（clippy/fmt），Linux 需安装 WebKit/GTK 系统依赖，Windows 需 Edge WebDriver。
- CI 对所有 PR 强制 DCO Signed-off-by 检查（`git log ... | grep 'Signed-off-by:'`）。
- 所有构建产物输出到 `artifacts/` 目录，失败时通过 `actions/upload-artifact` 保留诊断 XML/报告。
- 安装器 `scripts/install-latest.sh` 优先使用 GitHub API，回退到 `gh CLI`，再回退到 `/releases/latest` 重定向解析，确保离线环境也能安装。
