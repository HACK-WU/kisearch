/**
 * event-ref-upload-ui.test.mjs —— 事件参考文档「上传文件」入口（REQ-20261118-001）
 *
 * web 单测不渲染 React（无 jsdom），按仓库既有做法做**源码契约断言**：
 * 把"入口存在 / 只收文件不收目录 / 单次 ≤10 不截断 / 名额先判 / 走哪个接口"钉住，防实现漂移。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(webRoot, '..');
const read = (rel) => fs.readFileSync(path.join(webRoot, rel), 'utf-8');

const page = read('src/pages/EventsPage.tsx');
const modal = read('src/components/governance/EventRefUploadModal.tsx');
const api = read('src/api/governanceApi.ts');
const httpApi = read('src/api/httpApi.ts');
/** 后端上限是唯一真源，前端常量必须与它同值 */
const refsService = fs.readFileSync(path.join(repoRoot, 'src/lib/events/refs-service.ts'), 'utf-8');
/** 后端接口（防前端自己拼错路径） */
const governanceHttp = fs.readFileSync(path.join(repoRoot, 'src/lib/governance-http.ts'), 'utf-8');

describe('① 卡头入口', () => {
  it('参考文档卡有「上传文件」，与「＋ 添加」同层级且只读账号禁用', () => {
    assert.match(page, />\s*上传文件\s*</);
    assert.match(page, /disabled=\{busy \|\| !canWrite\}[\s\S]{0,200}上传文件/);
  });

  it('切事件 / 切 scope 会关掉上传弹窗（避免把 A 的文件传进 B 事件）', () => {
    assert.match(page, /setUploadRefOpen\(false\)/);
  });

  it('弹窗挂载带 eventId / 当前篇数 / 上限，并声明完成后刷新', () => {
    assert.match(page, /<EventRefUploadModal/);
    assert.match(page, /eventId=\{active\.id\}/);
    assert.match(page, /refCount=\{refs\.length\}/);
    assert.match(page, /refLimit=\{REF_LIMIT\}/);
    assert.match(page, /void loadDetail\(active\.id\)/);
  });

  it('空态文案包含「上传文件」（不让用户去猜入口在哪）', () => {
    assert.match(page, /暂无参考文档：可用「AI 查找」、「＋ 添加」或「上传文件」/);
  });
});

describe('② 只收文件、不收目录', () => {
  it('文件选择器不带 webkitdirectory，也不调用目录选择 API', () => {
    // 只看真实代码（注释里会提到「绝不挂 webkitdirectory」，不能当证据）
    const codeOnly = modal.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    assert.doesNotMatch(codeOnly, /webkitdirectory/);
    assert.doesNotMatch(codeOnly, /showDirectoryPicker/);
    assert.match(codeOnly, /type="file"[\s\S]{0,120}multiple/);
  });

  it('带路径分隔符的文件名在本地就拦下（服务端另有同名判据）', () => {
    assert.match(modal, /文件名含路径分隔符/);
    assert.match(modal, /name\.includes\('\/'\)/);
  });
});

describe('③ 单次 ≤10：超了整体拒绝，不截断', () => {
  it('上限常量为 10，且超量时以「本次 N 个 / 已选 M 个」整体拒绝', () => {
    assert.match(modal, /const MAX_FILES = 10/);
    assert.match(modal, /rows\.length \+ incoming\.length > MAX_FILES/);
    assert.match(modal, /单次最多 \$\{MAX_FILES\} 个文件（本次 \$\{incoming\.length\} 个，已选 \$\{rows\.length\} 个），请分批上传/);
  });

  it('显示「已选 N / 10」而不是静默截断', () => {
    assert.match(modal, /已选 \{rows\.length\} \/ \{MAX_FILES\}/);
  });
});

describe('④ 名额预检（真正的拒绝仍在服务端）', () => {
  it('前端上限常量与后端 REF_LIMIT 同值', () => {
    const backend = refsService.match(/export const REF_LIMIT = (\d+)/);
    assert.ok(backend, '后端必须存在 REF_LIMIT');
    assert.match(api, new RegExp(`export const REF_LIMIT = ${backend[1]}`));
  });

  it('名额不足时禁用提交并说明还能加几篇', () => {
    assert.match(modal, /refLimit - refCount/);
    assert.match(modal, /本次最多还能加 \$\{remaining\} 篇/);
    assert.match(modal, /rows\.length <= remaining/);
  });
});

describe('⑤ 逐条错误 + 本地预检', () => {
  it('格式与大小在本地预检时就说清（不等服务端拒）', () => {
    assert.match(modal, /不支持的格式（仅 \$\{policy\.extensions\.join\(' \/ '\)\}）/);
    assert.match(modal, /超过单文件上限/);
  });

  it('服务端 rejected 逐条回显', () => {
    assert.match(modal, /resp\.rejected/);
    assert.match(modal, /未通过服务端校验/);
  });

  it('上传限制来自 /api/import/config（与服务端同一份口径）', () => {
    assert.match(modal, /getImportConfig\(scope\)/);
  });
});

describe('⑥ 接口与轮询', () => {
  it('前端封装走 /governance/events/:id/refs/upload', () => {
    assert.match(api, /refs\/upload/);
    assert.match(api, /uploadEventRefDocs/);
    assert.match(api, /files, \.\.\.\(opts\.group/);
  });

  it('后端确实注册了该路由（前端不能凭空造端点）', () => {
    assert.match(governanceHttp, /segs\[3\] === 'upload'/);
    assert.match(governanceHttp, /uploadEventRefDocs/);
  });

  it('轮询导入状态，并在 done 后等 refsBinding（它晚于 state=done 写入）', () => {
    assert.match(modal, /getImportStatus\(result\.jobId\)/);
    assert.match(modal, /!next\.refsBinding && grace < graceLimit/);
    // 索引整理期（indexState=indexing）job 仍活着，宽限必须放宽，否则会误报"没挂上"
    assert.match(modal, /next\.indexState === 'indexing' \? BIND_GRACE_TICKS_INDEXING : BIND_GRACE_TICKS/);
    // 前端类型镜像必须有该字段，否则读不到
    assert.match(httpApi, /refsBinding\?:/);
  });

  it('后端在 status 里透出 refsBinding（手工挑字段的 handler，漏了前端永远是 undefined）', () => {
    assert.match(governanceHttp, /job\.refsBinding = \{ added, skipped: addedSkipped, skippedConflicts, failed, expected \}/);
    /** mcp-http-api 的 /api/import/status 是手工挑字段 */
    const mcpApi = fs.readFileSync(path.join(repoRoot, 'src/lib/mcp-http-api.ts'), 'utf-8');
    assert.match(mcpApi, /\.\.\.\(job\.refsBinding \? \{ refsBinding: job\.refsBinding \} : \{\}\)/);
  });
});

describe('⑦ 落点可见可改（R5/D1）', () => {
  it('弹窗里有 Group 选择器，留空由服务端算缺省值（只有一份推导）', () => {
    assert.match(modal, /<GroupPathSelect/);
    assert.match(modal, /onChange=\{setGroupDraft\}/);
    assert.match(modal, /留空 = /);
    // 提交时把选择传给后端；留空传 {}
    assert.match(modal, /groupDraft \? \{ group: groupDraft \} : \{\}/);
  });

  it('上传成功后显示服务端回执的真实落点', () => {
    assert.match(modal, /落点：\{result\.group\}/);
  });

  it('页面把缺省落点文案传进来（只做提示，不做推导）', () => {
    assert.match(page, /defaultGroupHint=\{`事件参考\/\$\{active\.shortId\}-\$\{active\.title\.slice\(0, 40\)\}`\}/);
  });
});

describe('⑧ 请求体体积预算（避免撞 16MB 硬闸）', () => {
  it('按 base64 估算总量，超预算禁用提交并说明分批', () => {
    assert.match(modal, /const UPLOAD_BODY_BUDGET_BYTES = 12 \* 1024 \* 1024/);
    assert.match(modal, /Math\.ceil\(r\.file\.size \/ 3\) \* 4/);
    assert.match(modal, /&& !tooLarge/);
    assert.match(modal, /超过单次上传上限（约 \{formatSize\(UPLOAD_BODY_BUDGET_BYTES\)\}），请分批上传/);
  });
});

describe('⑨ 同名未覆盖必须可见（R9）', () => {
  it('后端从导入结果里挑出 same-name 跳过项', () => {
    assert.match(governanceHttp, /c\.action === 'skip' && c\.skipReason === 'same-name'/);
    assert.match(governanceHttp, /skippedConflicts/);
  });

  it('前端同时展示在弹窗与父级提示里', () => {
    assert.match(modal, /skippedConflicts\.length/);
    assert.match(modal, /篇同名已存在未覆盖/);
    assert.match(httpApi, /skippedConflicts: string\[\]/);
  });
});

describe('⑩ 顺序约束（先校验后落盘）', () => {
  it('后端：导入 job 在校验与名额检查之后才创建', () => {
    const validateAt = governanceHttp.indexOf('所有文件都未通过校验');
    const jobAt = governanceHttp.indexOf("createJob(scope, 'import'");
    assert.ok(validateAt > 0 && jobAt > 0, '两段代码都必须存在');
    assert.ok(validateAt < jobAt, '校验必须发生在起 job 之前（否则产生孤儿文档）');
  });

  it('事件上传不写回 wiki（D3）', () => {
    assert.match(governanceHttp, /wikiWriteback: false/);
  });
});
