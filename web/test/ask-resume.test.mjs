/**
 * ask-resume.test.mjs —— 追问「切页 / 刷新后接续」的接入契约（#82）
 *
 * 背景：追问是一条 SSE 流，进行中的那一轮原先只活在前端内存（`pending`/`steps`），
 * 服务端只在整轮结束才落库 —— 切页或刷新后那一轮从界面上消失。
 * 修复方式 = 服务端把运行态落盘 + GET 一并下发；前端回来先按运行态渲染并轮询到落库。
 *
 * 这个文件锁的是**前端那一半**（无 jsdom，沿用仓库既有做法做源码契约断言）：
 *   1) 读记录时把 `running` 接住，且只接「同一版结论」（runId 不一致不接）；
 *   2) 存在运行态时按 2s 轮询，直到 `running` 变 null（= 已落库）；
 *   3) 接续占位与本地流式互斥（两个都渲染会重复一遍）；
 *   4) 运行态期间不能再发 / 不能清空（避免并出两条追问、清掉正在写的那轮）。
 *
 * 运行：cd web && npm run test
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const webRoot = fileURLToPath(new URL('..', import.meta.url));
const read = (rel) => fs.readFileSync(path.join(webRoot, rel), 'utf-8');

const block = read('src/components/governance/event-detail/AskBlock.tsx');
const api = read('src/api/governanceApi.ts');
const contractWeb = read('src/api/governanceContract.ts');

describe('① 服务端运行态的下发与类型', () => {
  it('读记录的返回类型带 running（含 null）', () => {
    assert.match(api, /running: AnalysisAskRunningDto \| null;/);
  });

  it('契约里定义了运行态 DTO（question / runId / answer / steps）', () => {
    assert.match(contractWeb, /export interface AnalysisAskRunningDto \{/);
    for (const field of ['question', 'runId', 'startedAt', 'updatedAt', 'answer', 'steps']) {
      assert.match(contractWeb, new RegExp(`\\b${field}\\b`));
    }
  });
});

describe('② 只接「同一版结论」的运行态', () => {
  it('runId 不一致时丢弃（分析被重跑，半截答案是旧结论的）', () => {
    assert.match(block, /running\.runId && activeRunId && running\.runId !== activeRunId/);
    assert.match(block, /return null;/);
  });

  it('load 里统一走 shouldResume，不直接 setRemote(res.running)', () => {
    assert.match(block, /setRemote\(shouldResume\(res\.running \?\? null, activeRunId\)\)/);
  });
});

describe('③ 轮询到落库', () => {
  it('有固定轮询间隔常量（2s）', () => {
    assert.match(block, /const REMOTE_POLL_MS = 2000;/);
  });

  it('轮询在远程运行态存在时启动，卸载时清定时器', () => {
    assert.match(block, /const pollingRemote = remote !== null;/);
    assert.match(block, /window\.setInterval\([\s\S]{0,600}REMOTE_POLL_MS\)/);
    assert.match(block, /window\.clearInterval\(timer\)/);
  });

  it('轮询失败不清占位（否则看起来又丢了）', () => {
    assert.match(block, /轮询中保留占位，让下一轮再试/);
  });

  it('读记录带请求序号，晚到的旧响应被丢弃', () => {
    assert.match(block, /const loadSeqRef = useRef\(0\);/);
    assert.match(block, /if \(seq !== loadSeqRef\.current\) return;/);
  });

  it('轮询复用 refresh，不再内联一份重复的请求逻辑', () => {
    assert.match(block, /window\.setInterval\(\(\) => \{ void refresh\(\); \}, REMOTE_POLL_MS\)/);
  });
});

describe('④ 渲染与门禁', () => {
  it('接续占位与本地流式互斥（`remote && !pending`）', () => {
    assert.match(block, /\{remote && !pending \? \(/);
  });

  it('接续时展示问题 / 过程 / 半截答案', () => {
    assert.match(block, /<AskQuestion text=\{remote\.question\} \/>/);
    assert.match(block, /<AskProcess key="remote-proc" steps=\{remote\.steps\} running \/>/);
    assert.match(block, /\{remote\.answer \? <AskAnswer text=\{remote\.answer\} streaming \/> : null\}/);
  });

  it('运行态期间不能再次发送（避免并出两条追问）', () => {
    assert.match(block, /if \(!text \|\| asking \|\| !canAsk \|\| remote\) return;/);
    assert.match(block, /disabled=\{!canAsk \|\| asking \|\| Boolean\(remote\) \|\| !question\.trim\(\)\}/);
  });

  it('运行态期间不能清空记录', () => {
    assert.match(block, /disabled=\{clearing \|\| !canWrite \|\| turns\.length === 0 \|\| Boolean\(remote\)\}/);
  });

  it('清空入口除按钮禁用外还有函数级兜底', () => {
    assert.match(block, /if \(clearing \|\| !canWrite \|\| turns\.length === 0 \|\| remote\) return;/);
  });

  it('列表容器在只有运行态时也要渲染', () => {
    assert.match(block, /\{turns\.length > 0 \|\| pending \|\| remote \? \(/);
  });
});
