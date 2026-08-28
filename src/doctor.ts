#!/usr/bin/env node
/**
 * doctor.ts —— ki doctor 配置诊断命令（REQ-16）
 *
 * 一键诊断配置有效性：配置文件语法与字段（名称/类型/取值）/ 目录可写 / apiKey /
 * embedding 连通性 + 维度 / zvec collection / scopes.default，输出 ✅/⚠️/❌ 报告。
 *
 * 只读，不修改任何配置或数据。有失败项时退出码 1（供脚本 gate）。
 *
 * 用法：
 *   ki doctor
 *   ki --config <path> doctor
 */

import { loadConfig } from './lib/config.js';
import { runHealthCheck, renderHealthReport } from './lib/health-check.js';

async function main(): Promise<void> {
  // -h/--help：打印帮助后直接退出（不落入健康检查，避免无意义失败退出码 1）
  if (process.argv.slice(2).includes('-h') || process.argv.slice(2).includes('--help')) {
    console.log(`ki doctor - 配置与向量环境诊断

用法：
  ki doctor
  ki --config <path> doctor

说明：
  一键诊断配置文件（语法 + 字段名/类型/取值校验）/ 目录可写 / apiKey / embedding 连通性与维度 / zvec collection / scopes.default。
  字段名拼错、类型错误会在配置加载阶段直接报错（非预期字段附相近字段建议）。
  只读，不修改任何配置或数据；有失败项时退出码为 1（供脚本 gate）。
  -h, --help   显示帮助`);
    process.exit(0);
  }

  let report;
  try {
    const config = loadConfig();
    report = await runHealthCheck(config);
  } catch (err) {
    // loadConfig 失败：语法错误（配置文件解析失败）或字段错误（CONFIG_FIELD_INVALID，
    // 错误信息内已逐项列出字段路径与建议）
    console.error(`❌ 配置加载失败：${(err as Error).message}`);
    console.error('提示：字段含义与合法取值见 docs/configuration.md');
    process.exit(1);
    return;
  }

  console.log(renderHealthReport(report));

  // 有失败项 → 退出码 1
  process.exit(report.fail > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(`ki doctor 执行异常：${(err as Error).message}`);
  process.exit(1);
});
