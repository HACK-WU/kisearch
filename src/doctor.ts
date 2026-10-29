#!/usr/bin/env node
/**
 * doctor.ts —— ki doctor 配置诊断命令（REQ-16）
 *
 * 一键诊断配置有效性：配置文件语法与字段（名称/类型/取值）/ 目录可写 / apiKey /
 * embedding 连通性 + 维度 + 单请求批大小 / zvec collection 存在性 / scopes.default，
 * 输出 ✅/⚠️/❌ 报告。
 *
 * 默认只做**配置级（O(1)）检查**：`--dimensions` 才追加逐 scope 维度诊断——
 * 后者是 O(scope) 操作（每个 scope 开一次 Collection，被占用时还要等探测超时），
 * 放进默认路径会让 1000 个 scope 的实例"诊断到天亮"；而维度冲突在写入/检索时
 * 已经会按需拦截并给出 `ki restore <scope> --rebuild-vector` 指引。
 *
 * 只读，不修改任何配置或数据。有失败项时退出码 1（供脚本 gate）。
 *
 * 用法：
 *   ki doctor
 *   ki doctor --dimensions          # 追加逐 scope 维度诊断（抽样，见报告说明）
 *   ki --config <path> doctor
 */

import { loadConfig } from './lib/config.js';
import { runHealthCheck, renderHealthReport } from './lib/health-check.js';

/** 逐 scope 维度诊断的抽样上限（--dimensions）；O(scope) 操作必须设界 */
const DIMENSION_SAMPLE_LIMIT = 20;

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  // -h/--help：打印帮助后直接退出（不落入健康检查，避免无意义失败退出码 1）
  if (argv.includes('-h') || argv.includes('--help')) {
    console.log(`ki doctor - 配置诊断

用法：
  ki doctor                     # 配置级检查（快，O(1)）
  ki doctor --dimensions        # 追加逐 scope 向量集合维度诊断（O(scope)，抽样 ${DIMENSION_SAMPLE_LIMIT} 个）
  ki --config <path> doctor

说明：
  配置级检查：配置文件（语法 + 字段名/类型/取值校验）/ 目录可写 / apiKey /
    embedding 连通性、密钥有效性、维度匹配、单请求批大小 / zvec collection 存在性 / scopes.default。
  字段名拼错、类型错误会在配置加载阶段直接报错（非预期字段附相近字段建议）。
  --dimensions 追加逐 scope 维度诊断：向量集合维度与当前 embedding 不一致时给出
    ki restore <scope> --rebuild-vector --yes 指引；该检查需逐个打开 Collection，
    数量随 scope 增长（故默认不跑、且运行时抽样上限 ${DIMENSION_SAMPLE_LIMIT} 个）。
    日常无需它：写入/检索命中维度冲突时会直接返回该指引（前端导入页/检索页同款提示）。
  只读，不修改任何配置或数据；有失败项时退出码为 1（供脚本 gate）。
  -h, --help   显示帮助`);
    process.exit(0);
  }

  const withDimensions = argv.includes('--dimensions') || argv.includes('--deep');

  let report;
  try {
    const config = loadConfig();
    // 进度可见：embedding 探测与（--dimensions 时的）逐 scope 诊断都可能耗时，
    // 静默会让用户以为命令卡死（实测旧版逐个 scope 白等重试，8 个 scope 就刷 2 分钟）。
    report = await runHealthCheck(config, {
      // 默认不打开 Collection；仅 --dimensions 时抽样诊断（O(scope) 必须设界）
      ...(withDimensions
        ? { collectionDimensionScopeLimit: DIMENSION_SAMPLE_LIMIT }
        : { checkCollectionDimensions: false }),
      onProgress: (done, total, label) => {
        if (total <= 0 || !process.stderr.isTTY) return;
        process.stderr.write(`\r  [${done}/${total}] ${label}`.padEnd(78).slice(0, 78));
      },
    });
    if (process.stderr.isTTY) process.stderr.write(`\r${' '.repeat(78)}\r`);
  } catch (err) {
    // loadConfig 失败：语法错误（配置文件解析失败）或字段错误（CONFIG_FIELD_INVALID，
    // 错误信息内已逐项列出字段路径与建议）
    console.error(`❌ 配置加载失败：${(err as Error).message}`);
    console.error('提示：字段含义与合法取值见 docs/configuration.md');
    process.exit(1);
    return;
  }

  console.log(renderHealthReport(report));
  if (!withDimensions) {
    console.log(
      '\n提示：以上为配置级检查。如需逐 scope 的向量集合维度诊断（O(scope)，可能较慢），'
      + `执行 ki doctor --dimensions（抽样 ${DIMENSION_SAMPLE_LIMIT} 个）。`,
    );
  }

  // 有失败项 → 退出码 1
  process.exit(report.fail > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(`ki doctor 执行异常：${(err as Error).message}`);
  process.exit(1);
});
