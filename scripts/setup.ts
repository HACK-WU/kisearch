#!/usr/bin/env node
/**
 * setup.ts - 从 GitHub 下载 Skills / Rules 到目标项目目录
 *
 * 用法:
 *   ki setup --skills                          # 读 ~/.ki-targets，安装到所有目录
 *   ki setup --rules                           # 读 ~/.ki-targets，安装到所有目录
 *   ki setup --skills -t ~/project-a -t ~/project-b
 *   ki setup --rules --file ~/my-targets.txt
 *   ki setup --skills -n codekb-skill,memory-skill -t ~/project-a
 */

import { Command } from 'commander';
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';

// ─── 常量 ───

const GITHUB_REPO = 'HACK-WU/KiSearch';
const GITHUB_BRANCH = 'master';
const RAW_BASE = `https://raw.githubusercontent.com/${GITHUB_REPO}/${GITHUB_BRANCH}`;

const DEFAULT_TARGETS_FILE = path.join(os.homedir(), '.ki-targets');

// ─── gh CLI 工具函数 ───

/** 通过 gh CLI 调用 GitHub API */
function ghApi(...args: string[]): string {
  try {
    return execSync(`gh api ${args.join(' ')}`, {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch {
    console.error('错误：gh CLI 调用失败，请确认 gh 已安装并登录');
    console.error('  brew install gh && gh auth login');
    process.exit(1);
  }
}

/** 动态列出 skills/ 下所有有效 skill（排除 .gitkeep 等非目录） */
function listSkills(): string[] {
  const items = ghApi(
    `repos/${GITHUB_REPO}/contents/skills`,
    '--jq', "'.[] | select(.type==\"dir\") | .name'",
  );
  return items.split('\n').filter(Boolean);
}

/** 动态列出 rules/ 下所有 .md 文件 */
function listRules(): string[] {
  const items = ghApi(
    `repos/${GITHUB_REPO}/contents/rules`,
    '--jq', "'.[] | select(.name | endswith(\".md\")) | .name'",
  );
  return items.split('\n').filter(Boolean);
}

// ─── 工具函数 ───

/**
 * 从 GitHub raw 下载文件
 */
async function downloadFile(url: string, dest: string): Promise<boolean> {
  try {
    const dir = path.dirname(dest);
    fs.mkdirSync(dir, { recursive: true });

    const res = await fetch(url, { redirect: 'follow' });
    if (!res.ok) return false;

    const body = await res.text();
    fs.writeFileSync(dest, body, 'utf-8');
    return true;
  } catch {
    return false;
  }
}

/**
 * 获取用户的原始工作目录（ki.mjs 会将子进程 cwd 设为 PROJECT_ROOT）
 */
function getOriginalCwd(): string {
  return process.env.KI_ORIGINAL_CWD || process.cwd();
}

/**
 * 解析目标目录列表
 * 优先级：-t > --file > ~/.ki-targets
 * -t 和 --file 互斥
 */
function resolveTargets(targets: string[] | undefined, file: string | undefined): { dirs: string[]; source: string } {
  // 互斥检查
  if (targets && targets.length > 0 && file) {
    console.error('错误：-t 和 --file 不能同时使用');
    process.exit(1);
  }

  const originalCwd = getOriginalCwd();

  // 1. 命令行 -t 指定（相对路径基于用户原始 CWD 解析）
  if (targets && targets.length > 0) {
    const dirs = targets.map((t) => path.resolve(originalCwd, t));
    return { dirs, source: `命令行参数 (-t × ${dirs.length})` };
  }

  // 2. --file 指定配置文件
  if (file) {
    return { dirs: readTargetsFile(file), source: `配置文件: ${file}` };
  }

  // 3. 默认 ~/.ki-targets
  if (fs.existsSync(DEFAULT_TARGETS_FILE)) {
    return { dirs: readTargetsFile(DEFAULT_TARGETS_FILE), source: `默认配置: ${DEFAULT_TARGETS_FILE}` };
  }

  // 4. 都没有 → 报错
  console.error('错误：未指定目标目录');
  console.error('');
  console.error('请通过以下方式之一指定目标目录：');
  console.error('  ki setup --skills -t <目标目录>');
  console.error('  ki setup --skills --file <配置文件>');
  console.error('  创建默认配置文件: ~/.ki-targets（每行一个目录路径）');
  process.exit(1);
}

/**
 * 读取 targets 配置文件
 * - 每行一个绝对路径
 * - 空行和 # 开头的注释行忽略
 */
function readTargetsFile(filePath: string): string[] {
  if (!fs.existsSync(filePath)) {
    console.error(`错误：配置文件不存在: ${filePath}`);
    process.exit(1);
  }

  const content = fs.readFileSync(filePath, 'utf-8');
  const dirs: string[] = [];

  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    // 跳过空行和注释
    if (!trimmed || trimmed.startsWith('#')) continue;
    dirs.push(path.resolve(trimmed));
  }

  if (dirs.length === 0) {
    console.error(`错误：配置文件为空: ${filePath}`);
    process.exit(1);
  }

  return dirs;
}

/**
 * 按名称过滤列表，返回过滤后的结果
 * 未匹配的名称会输出警告
 */
function filterByName(available: string[], nameFilter: string[] | null, typeLabel: string): string[] {
  if (!nameFilter || nameFilter.length === 0) return available;

  const availableSet = new Set(available);
  const matched: string[] = [];

  for (const name of nameFilter) {
    if (availableSet.has(name)) {
      matched.push(name);
    } else {
      console.warn(`⚠️  未找到${typeLabel}: ${name}（跳过）`);
    }
  }

  return matched;
}

/**
 * 安装 Skills 到目标目录（动态发现 skill 列表）
 */
async function installSkills(targetDir: string, nameFilter: string[] | null = null): Promise<{ ok: number; fail: number; total: number }> {
  const destBase = path.basename(targetDir) === 'skills'
    ? targetDir
    : path.join(targetDir, 'skills');

  fs.mkdirSync(destBase, { recursive: true });

  const allSkills = listSkills();
  const skills = filterByName(allSkills, nameFilter, 'skill');
  const skipped = allSkills.length - skills.length;

  let ok = 0;
  let fail = 0;

  for (const name of skills) {
    const filePath = `${name}/SKILL.md`;
    const url = `${RAW_BASE}/skills/${filePath}`;
    const dest = path.join(destBase, filePath);
    if (await downloadFile(url, dest)) {
      console.log(`  [OK] ${filePath}`);
      ok++;
    } else {
      console.log(`  [FAIL] ${filePath}`);
      fail++;
    }
  }

  if (skipped > 0) console.log(`  跳过: ${skipped} 个未匹配的 skill`);

  return { ok, fail, total: skills.length };
}

/**
 * 安装 Rules 到目标目录（动态发现 rule 列表）
 */
async function installRules(targetDir: string, nameFilter: string[] | null = null): Promise<{ ok: number; fail: number; total: number }> {
  const destBase = path.basename(targetDir) === 'rules'
    ? targetDir
    : path.join(targetDir, 'rules');

  fs.mkdirSync(destBase, { recursive: true });

  const allRules = listRules();
  const rules = filterByName(allRules, nameFilter, 'rule');
  const skipped = allRules.length - rules.length;

  let ok = 0;
  let fail = 0;

  for (const name of rules) {
    const url = `${RAW_BASE}/rules/${name}`;
    const dest = path.join(destBase, name);
    if (await downloadFile(url, dest)) {
      console.log(`  [OK] ${name}`);
      ok++;
    } else {
      console.log(`  [FAIL] ${name}`);
      fail++;
    }
  }

  if (skipped > 0) console.log(`  跳过: ${skipped} 个未匹配的 rule`);

  return { ok, fail, total: rules.length };
}

// ─── CLI 定义 ───

const program = new Command();

program
  .name('setup')
  .description('从 GitHub 下载 Skills / Rules 到目标项目目录')
  .option('--skills', '安装 AI Agent Skills')
  .option('--rules', '安装加载引导规则')
  .option('-n, --names <names>', '指定要安装的 skill/rule 名称（逗号分隔）')
  .option('-t, --target <path...>', '指定目标目录（可多次使用）')
  .option('--file <path>', '指定目标目录配置文件')
  .action(async (opts) => {
    try {
      const { skills, rules, target, file, names } = opts;

      // 解析名称过滤器
      const nameFilter: string[] | null = names
        ? names.split(',').map((n: string) => n.trim()).filter(Boolean)
        : null;

      // 1. 校验模式参数：必须且只能指定 --skills 或 --rules
      if (skills && rules) {
        console.error('错误：--skills 和 --rules 不能同时使用');
        process.exit(1);
      }
      if (!skills && !rules) {
        console.error('错误：请指定 --skills 或 --rules');
        process.exit(1);
      }

      // 2. 解析目标目录
      const { dirs, source } = resolveTargets(target, file);

      const mode = skills ? '--skills' : '--rules';
      const nameDesc = nameFilter ? ` [${nameFilter.join(', ')}]` : '';
      console.log(`🚀 ki setup ${mode}${nameDesc}`);
      console.log(`   目标来源: ${source}`);
      console.log(`   目标数量: ${dirs.length}`);
      if (nameFilter) console.log(`   名称过滤: ${nameFilter.join(', ')}`);
      console.log('');

      let totalOk = 0;
      let totalFail = 0;
      let totalItems = 0;

      // 3. 遍历目标目录安装
      for (let i = 0; i < dirs.length; i++) {
        const dir = dirs[i];
        const label = `[${i + 1}/${dirs.length}]`;

        if (skills) {
          console.log(`${label} 🧠 安装 Skills → ${dir}`);
          const result = await installSkills(dir, nameFilter);
          totalOk += result.ok;
          totalFail += result.fail;
          totalItems += result.total;
        } else {
          console.log(`${label} 📋 安装 Rules → ${dir}`);
          const result = await installRules(dir, nameFilter);
          totalOk += result.ok;
          totalFail += result.fail;
          totalItems += result.total;
        }
        console.log('');
      }

      // 4. 输出汇总
      if (totalItems === 0) {
        console.log('⚠️ 未找到匹配的项，请检查名称是否正确');
        const listPath = skills ? 'skills' : 'rules';
        console.log(`   可用名称可通过以下方式查看：`);
        console.log(`   gh api repos/HACK-WU/KiSearch/contents/${listPath} --jq '[].name'`);
        process.exit(1);
      }
      if (totalFail === 0) {
        console.log(`✅ 完成: ${totalOk}/${totalItems} 个 ${skills ? 'skill' : 'rule'} 安装成功`);
      } else {
        console.log(`⚠️ 完成: ${totalOk}/${totalItems} 个 ${skills ? 'skill' : 'rule'} 成功, ${totalFail} 失败`);
        process.exit(1);
      }
    } catch (err) {
      console.error(`错误: ${(err as Error).message}`);
      process.exit(1);
    }
  });

// 仅在直接运行时解析参数（被 import 时不执行）
const _isMain = (() => {
  try {
    const entry = process.argv[1];
    if (!entry || !import.meta.url) return false;
    return import.meta.url.endsWith(entry.replace(/\\/g, '/'));
  } catch { return false; }
})();
if (_isMain) program.parse();
