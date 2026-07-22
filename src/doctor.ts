#!/usr/bin/env node
/**
 * doctor.ts —— ki doctor 配置诊断命令（REQ-16）
 *
 * 一键诊断配置有效性：配置文件 / 目录可写 / apiKey / embedding 连通性 + 维度 /
 * zvec collection / scopes.default，输出 ✅/⚠️/❌ 报告。
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
  let report;
  try {
    const config = loadConfig();
    report = await runHealthCheck(config);
  } catch (err) {
    // loadConfig 解析失败（配置文件语法错误等）
    console.error(`❌ 配置加载失败：${(err as Error).message}`);
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
