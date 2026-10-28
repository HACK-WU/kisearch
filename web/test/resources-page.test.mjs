/**
 * 「资源」页纯逻辑单测（2026-10-27）
 *
 * 锁住：
 *   1) 回环判定与默认 tab；
 *   2) MCP 端点由 origin/port 推导（不硬编码 7423）；
 *   3) 三份配置都是合法 JSON，且远程配置带 Authorization、Token 只出现占位符；
 *   4) Skill 命令集中生成，agent 标识正确；通用脚本带 --repo 与 -t。
 *
 * 运行：cd web && npm run test
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const webRoot = fileURLToPath(new URL('..', import.meta.url));
const vite = await createServer({
  configFile: path.join(webRoot, 'vite.config.ts'),
  root: webRoot,
  server: { middlewareMode: true },
  appType: 'custom',
  logLevel: 'silent',
});
const {
  buildConcurrencyConfigSnippet,
  buildLlmConfigSnippet,
  buildLocalMcpConfig,
  buildMcpEndpoint,
  buildRemoteMcpConfig,
  buildRemoteMcpEndpoint,
  buildScopeConfigSnippet,
  buildStdioMcpConfig,
  chooseDefaultMcpTab,
  cliDocUrl,
  CONCURRENCY_CONFIG_NOTES,
  configDocUrl,
  describeLlmStatus,
  describeWikiSync,
  GENERIC_INSTALL_COMMAND,
  GROUP_LABEL,
  isLoopbackHost,
  MEMORY_RULE_FILE,
  MCP_TOOL_COUNT,
  MCP_TOOLS,
  MCP_TOOLS_NOTE,
  mcpToolsDocUrl,
  MEMORY_SKILLS,
  LLM_FIELD_NOTES,
  LLM_PROTOCOL_NOTE,
  MORE_SKILL_TOOLS,
  PRIMARY_SKILL_TOOLS,
  REPO_DOCS_BASE,
  RESOURCE_TOPICS,
  resolveTopic,
  SCOPE_CONFIG_BENEFITS,
  SCOPE_CONFIG_NOTES,
  SKILL_AGENT_COUNT_HINT,
  SKILL_ITEMS,
  SKILL_TOOLS,
  skillInstallCommand,
  STATUS_COMMAND,
  TOKEN_COMMAND,
  TOPIC_GROUPS,
  topicExamples,
  topicsByGroup,
} = await vite.ssrLoadModule('/src/lib/resourcesPage.ts');
after(async () => vite.close());

describe('isLoopbackHost / chooseDefaultMcpTab', () => {
  it('识别本机回环地址', () => {
    for (const host of ['127.0.0.1', 'localhost', '::1', '[::1]', ' LocalHost ']) {
      assert.equal(isLoopbackHost(host), true, host);
    }
    for (const host of ['192.168.1.10', 'example.com', '10.0.0.2', '']) {
      assert.equal(isLoopbackHost(host), false, host);
    }
  });

  it('本机访问默认本机 tab，其他设备默认远程 tab', () => {
    assert.equal(chooseDefaultMcpTab('127.0.0.1'), 'local');
    assert.equal(chooseDefaultMcpTab('192.168.1.10'), 'remote');
  });
});

describe('MCP 端点推导', () => {
  it('当前端点为 origin + /mcp，并去掉尾随斜杠', () => {
    assert.equal(buildMcpEndpoint('http://127.0.0.1:7423'), 'http://127.0.0.1:7423/mcp');
    assert.equal(buildMcpEndpoint('http://127.0.0.1:7423/'), 'http://127.0.0.1:7423/mcp');
    assert.equal(buildMcpEndpoint('http://127.0.0.1:8765'), 'http://127.0.0.1:8765/mcp');
  });

  it('远程端点端口跟随当前页面，主机为占位符', () => {
    assert.equal(buildRemoteMcpEndpoint('http:', '7423'), 'http://<服务器IP>:7423/mcp');
    assert.equal(buildRemoteMcpEndpoint('http:', '8765'), 'http://<服务器IP>:8765/mcp');
    assert.equal(buildRemoteMcpEndpoint('https:', ''), 'https://<服务器IP>/mcp');
    assert.equal(buildRemoteMcpEndpoint('http', '8000'), 'http://<服务器IP>:8000/mcp');
  });
});

describe('配置 JSON', () => {
  it('本机配置是合法 JSON 且包含当前端点', () => {
    const text = buildLocalMcpConfig('http://127.0.0.1:8765/mcp');
    const parsed = JSON.parse(text);
    assert.equal(parsed.mcpServers.ki.url, 'http://127.0.0.1:8765/mcp');
    assert.equal(parsed.mcpServers.ki.headers, undefined);
  });

  it('远程配置是合法 JSON，带 Authorization，Token 只出现占位符', () => {
    const text = buildRemoteMcpConfig('http://<服务器IP>:8765/mcp');
    const parsed = JSON.parse(text);
    assert.equal(parsed.mcpServers.ki.url, 'http://<服务器IP>:8765/mcp');
    assert.equal(parsed.mcpServers.ki.headers.Authorization, 'Bearer <你的Token>');
    assert.equal(text.includes('Bearer  '), false);
  });

  it('stdio 配置是合法 JSON，command 为 ki，args 为 mcp', () => {
    const text = buildStdioMcpConfig();
    const parsed = JSON.parse(text);
    assert.equal(parsed.mcpServers.ki.command, 'ki');
    assert.deepEqual(parsed.mcpServers.ki.args, ['mcp']);
  });

  it('★ stdio 不带 env / 密钥（桥接 daemon，密钥在 daemon 侧）', () => {
    const text = buildStdioMcpConfig();
    const parsed = JSON.parse(text);
    assert.equal(parsed.mcpServers.ki.env, undefined);
    assert.equal(text.includes('API Key'), false);
    assert.equal(/SILICONFLOW_API_KEY|Bearer/.test(text), false);
  });

  it('URL 中的引号会被正确转义（不破坏 JSON）', () => {
    const text = buildLocalMcpConfig('http://example.com/a"b/mcp');
    assert.equal(JSON.parse(text).mcpServers.ki.url, 'http://example.com/a"b/mcp');
  });
});

describe('命令常量', () => {
  it('常见工具直出 4 个（含 CodeBuddy），其余进更多工具', () => {
    assert.deepEqual(
      PRIMARY_SKILL_TOOLS.map((tool) => tool.agent),
      ['claude-code', 'codex', 'opencode', 'codebuddy'],
    );
    assert.deepEqual(
      MORE_SKILL_TOOLS.map((tool) => tool.agent),
      ['cursor', 'qoder', 'qoder-cn', 'trae', 'trae-cn'],
    );
  });

  it('★ Trae / Trae CN 的 agent 标识与官方表一致（字节，国际版 / 国内版）', () => {
    assert.equal(SKILL_TOOLS.find((t) => t.id === 'trae').agent, 'trae');
    assert.equal(SKILL_TOOLS.find((t) => t.id === 'trae-cn').agent, 'trae-cn');
    assert.equal(skillInstallCommand('trae-cn'), 'npx skills add HACK-WU/kisearch -a trae-cn');
  });

  it('★ CodeBuddy 的 agent 标识为 codebuddy（与 skills 官方 agent 表一致）', () => {
    const cb = SKILL_TOOLS.find((tool) => tool.id === 'codebuddy');
    assert.equal(cb.agent, 'codebuddy');
    assert.equal(skillInstallCommand(cb.agent), 'npx skills add HACK-WU/kisearch -a codebuddy');
  });

  it('Skill 安装命令使用 npx skills + 对应 agent', () => {
    assert.equal(skillInstallCommand('claude-code'), 'npx skills add HACK-WU/kisearch -a claude-code');
    assert.equal(skillInstallCommand('qoder-cn'), 'npx skills add HACK-WU/kisearch -a qoder-cn');
  });

  it('Token / 状态 / 通用安装命令包含关键参数', () => {
    assert.equal(TOKEN_COMMAND, 'ki mcp token generate --scope all');
    assert.equal(STATUS_COMMAND, 'ki mcp --status');
    assert.equal(GENERIC_INSTALL_COMMAND.includes('--repo HACK-WU/kisearch'), true);
    assert.equal(GENERIC_INSTALL_COMMAND.includes('-t /path/to/your-project'), true);
    assert.equal(GENERIC_INSTALL_COMMAND.includes('skill-install.sh'), true);
  });
});

// ─── v2：双栏目录 + 功能示例 + LLM / wikiSync 文案 ───────────────────────

describe('目录定义（左栏）', () => {
  it('分三组：接入 3 + 功能 8 + 配置 4', () => {
    assert.deepEqual(TOPIC_GROUPS, ['access', 'feature', 'config']);
    assert.deepEqual(topicsByGroup('access').map((t) => t.id), ['mcp', 'skill', 'llm']);
    assert.deepEqual(
      topicsByGroup('feature').map((t) => t.id),
      ['import', 'datasource', 'search', 'backup', 'export', 'rebuild', 'group', 'deleteDoc', 'scopeOps'],
    );
    assert.deepEqual(
      topicsByGroup('config').map((t) => t.id),
      ['scope', 'token', 'doctor', 'concurrency'],
    );
    assert.equal(RESOURCE_TOPICS.length, 16);
    assert.deepEqual(GROUP_LABEL, { access: '接入', feature: '功能', config: '配置' });
  });

  it('id 唯一；每项都有锚点（命令 → cli.md，配置 → configuration.md）', () => {
    const ids = RESOURCE_TOPICS.map((t) => t.id);
    assert.equal(new Set(ids).size, ids.length);
    for (const topic of RESOURCE_TOPICS) {
      if (topic.group === 'access') continue;
      assert.ok(
        typeof topic.docAnchor === 'string' || typeof topic.configAnchor === 'string',
        `${topic.id} 缺文档锚点`,
      );
      assert.ok(topic.title.length > 0);
      assert.ok(topic.kicker.length > 0);
    }
  });

  it('不收录 Agent 侧的写入/底层命令（人类用 Web 写入页，避免误操作）', () => {
    const ids = RESOURCE_TOPICS.map((t) => t.id);
    for (const excluded of ['store', 'syncRelation', 'editRelation', 'deleteRelation', 'docDelete']) {
      assert.equal(ids.includes(excluded), false, `${excluded} 不应出现在目录里`);
    }
  });

  it('未知 topic 回退默认项（刷新/手改 URL 不白屏）', () => {
    assert.equal(resolveTopic(undefined).id, 'mcp');
    assert.equal(resolveTopic('not-a-topic').id, 'mcp');
    assert.equal(resolveTopic('import').id, 'import');
    assert.equal(resolveTopic('token').id, 'token');
  });
});

describe('功能示例（scope 实填）', () => {
  it('★ 所有示例都不留占位符，且需要 scope 的命令已实填当前 scope', () => {
    const scope = 'my-project';
    const ids = topicsByGroup('feature').map((t) => t.id);
    /** `ki scope list` / `ki doctor` 这类命令本身不接收 scope 参数，不做"必须含 scope"要求 */
    const NO_SCOPE_ARG = new Set(['scope']);
    for (const id of ids) {
      const examples = topicExamples(id, scope);
      assert.ok(examples.length > 0, `${id} 应至少有一条示例`);
      // 至少一条演示了 scope 实填（`ki datasource list --json` 这类单条命令也不带 scope）
      if (!NO_SCOPE_ARG.has(id)) {
        assert.ok(
          examples.some((example) => example.command.includes(scope)),
          `${id}: 至少一条示例应带当前 scope`,
        );
      }
      for (const example of examples) {
        assert.ok(example.command.startsWith('ki '), `${id}: 命令必须以 ki 开头`);
        assert.equal(example.command.includes('<scope>'), false, `${id}: 不得留 <scope> 占位符`);
        assert.equal(example.command.includes('<s>'), false, `${id}: 不得留 <s> 占位符`);
        assert.equal(/--scope\s+<[^>]+>/.test(example.command), false, `${id}: --scope 不得是占位符`);
        assert.ok(example.label.length > 0);
      }
    }
  });

  it('scope 为空时回退 default（与 CLI 一致）', () => {
    const [first] = topicExamples('import', '   ');
    assert.ok(first.command.includes('default'));
  });

  it('命令只使用 docs/cli.md 记载的子命令', () => {
    const allowed = new Set([
      'import', 'datasource', 'group', 'scope', 'backup', 'restore', 'export', 'index-optimize', 'doctor', 'search', 'mcp', 'delete-relation', 'doc',
    ]);
    for (const id of topicsByGroup('feature').map((t) => t.id)) {
      for (const example of topicExamples(id, 'demo')) {
        const verb = example.command.split(/\s+/)[1];
        assert.ok(allowed.has(verb), `${id}: 未知子命令 ${verb}`);
      }
    }
  });
});

describe('功能项的参数说明', () => {
  it('功能组每项都有 params（至少 3 条），flag 与 desc 都非空', () => {
    for (const topic of topicsByGroup('feature')) {
      assert.ok(Array.isArray(topic.params), `${topic.id} 缺参数说明`);
      assert.ok(topic.params.length >= 3, `${topic.id} 参数太少`);
      for (const param of topic.params) {
        assert.ok(param.flag.length > 0, `${topic.id} 有空的 flag`);
        assert.ok(param.desc.length >= 6, `${topic.id} 的 ${param.flag} 说明过短`);
      }
    }
  });

  it('接入组的 MCP / Skill 不需要 params（内容在各自面板）', () => {
    for (const topic of topicsByGroup('access')) {
      if (topic.id === 'llm') continue;  // LLM 走配置示例 + 字段口径
      assert.equal(topic.params, undefined, `${topic.id} 不该有 params`);
    }
  });

  it('★ --conflict-mode 的默认值写成 incremental（不能写成"跳过同名"）', () => {
    const imp = RESOURCE_TOPICS.find((t) => t.id === 'import');
    const param = imp.params.find((p) => p.flag === '--conflict-mode');
    assert.ok(param.desc.includes('incremental'));
    assert.equal(imp.summary.includes('同名不同来源跳过'), false, 'summary 不得写"跳过"（默认是覆盖）');
    assert.ok(imp.summary.includes('覆盖'));
  });
});

describe('文档外链（页面内唯一允许的 GitHub 链接）', () => {
  it('cliDocUrl 指向 docs/cli.md，可带锚点', () => {
    assert.equal(REPO_DOCS_BASE, 'https://github.com/HACK-WU/kisearch/blob/master/docs');
    assert.equal(cliDocUrl(), `${REPO_DOCS_BASE}/cli.md`);
    assert.equal(cliDocUrl('import'), `${REPO_DOCS_BASE}/cli.md#import`);
  });

  it('锚点与 docs/cli.md 的章节名同形（小写 / 连字符）', () => {
    for (const topic of topicsByGroup('feature')) {
      assert.match(topic.docAnchor, /^[a-z][a-z-]*$/, `${topic.id} 锚点格式异常`);
    }
  });
});

describe('MCP 工具清单（接入后能用什么）', () => {
  it('13 个工具分三组：读 5 / 写 5 / 组织与删除 3', () => {
    assert.equal(MCP_TOOL_COUNT, 13);
    assert.deepEqual(MCP_TOOLS.map((g) => g.label), ['读', '写', '组织与删除']);
    assert.deepEqual(MCP_TOOLS.map((g) => g.items.length), [5, 5, 3]);
  });

  it('★ 工具名与 docs/mcp-tools.md 的清单逐条一致（防文档漂移）', () => {
    const docText = fs.readFileSync(path.join(webRoot, '..', 'docs', 'mcp-tools.md'), 'utf-8');
    // 只取表格里 `| \`ki_xxx\` |` 形式出现的工具名
    const docNames = [...docText.matchAll(/^\|\s*`(ki_[a-z_]+)`/gm)].map((m) => m[1]).sort();
    const pageNames = MCP_TOOLS.flatMap((g) => g.items.map((i) => i.name)).sort();
    assert.deepEqual(pageNames, docNames, '页面工具名必须与 docs/mcp-tools.md 完全一致');
  });

  it('工具名唯一，每条都有作用说明', () => {
    const names = MCP_TOOLS.flatMap((g) => g.items.map((i) => i.name));
    assert.equal(new Set(names).size, names.length);
    for (const group of MCP_TOOLS) {
      for (const item of group.items) {
        assert.ok(item.purpose.length >= 6, `${item.name} 缺少作用说明`);
      }
    }
  });

  it('外链指向 docs/mcp-tools.md，边界说明点明不暴露级联删除', () => {
    assert.equal(mcpToolsDocUrl(), `${REPO_DOCS_BASE}/mcp-tools.md`);
    assert.ok(MCP_TOOLS_NOTE.includes('刻意不暴露'));
    assert.ok(MCP_TOOLS_NOTE.includes('CLI'));
  });
});

describe('并发与资源（纯配置项）', () => {
  it('片段只给最常调的四个旋钮，不罗列全部字段', () => {
    const text = buildConcurrencyConfigSnippet();
    assert.ok(text.includes('scheduler:'));
    assert.ok(text.includes('maxConcurrency:'));
    assert.ok(text.includes('batchSize:'));
    assert.ok(text.includes('maxOpenCollections:'));
    assert.ok(text.includes('optimize:'));
    assert.equal(text.includes('maxBufferedVectorBytes'), false, '不该罗列全部调度字段');
  });

  it('该目录项没有命令示例（走配置片段分支）', () => {
    assert.deepEqual(topicExamples('concurrency', 'demo'), []);
  });

  it('口径提醒点明"不是越大越快"', () => {
    assert.ok(CONCURRENCY_CONFIG_NOTES.length >= 3);
    assert.ok(CONCURRENCY_CONFIG_NOTES.some((note) => note.includes('不一定更快')));
    assert.ok(CONCURRENCY_CONFIG_NOTES.some((note) => note.includes('optimize.concurrency')));
  });
});

describe('注册 scope：好处与配置方式', () => {
  it('目录项叫「注册 scope」，副标题指向配置文档', () => {
    const scope = RESOURCE_TOPICS.find((t) => t.id === 'scope');
    assert.equal(scope.label, '注册 scope');
    assert.equal(scope.configAnchor, 'scopes');
    assert.equal(
      configDocUrl(scope.configAnchor),
      `${REPO_DOCS_BASE}/configuration.md#scopes`,
    );
  });

  it('配置片段用当前 scope，含 kbDir / wikiSync.sourceDir / autoBackfill', () => {
    const text = buildScopeConfigSnippet('monitor');
    assert.ok(text.startsWith('scopes:'));
    assert.ok(text.includes('\n  monitor:'), '应把 scope 名实填进 scopes 段');
    assert.ok(text.includes('kbDir:'));
    assert.ok(text.includes('wikiSync:'));
    assert.ok(text.includes('sourceDir:'));
    assert.ok(text.includes('autoBackfill:'));
    // 用户 2026-10-28：enabled 那行要写明它开的是「wiki 回写」，不能只写「开关」
    assert.ok(/enabled: true\s+#\s*开启 wiki 回写/.test(text), 'enabled 注释要写明开启 wiki 回写');
  });

  it('★ 片段不使用已废弃的顶层 scopes.<scope>.sourceDir', () => {
    const text = buildScopeConfigSnippet('demo');
    // 只允许出现在 wikiSync 段里（缩进 6 空格）
    const matches = text.match(/sourceDir/g) ?? [];
    assert.equal(matches.length, 1, 'sourceDir 只应出现一次（在 wikiSync 下）');
    assert.ok(/\n {6}sourceDir:/.test(text), 'sourceDir 必须缩进在 wikiSync 段内');
  });

  it('空 scope 名回退占位名，不产生空 key', () => {
    const text = buildScopeConfigSnippet('   ');
    assert.ok(text.includes('my-project'));
    assert.equal(/\n {2}:\n/.test(text), false);
  });

  it('好处与口径提醒都有内容（页面不出现空列表）', () => {
    assert.ok(SCOPE_CONFIG_BENEFITS.length >= 3);
    for (const benefit of SCOPE_CONFIG_BENEFITS) {
      assert.ok(benefit.title.length > 0);
      assert.ok(benefit.detail.length > 0);
    }
    assert.ok(SCOPE_CONFIG_NOTES.length >= 2);
    // 已废弃字段必须在提醒里点名，否则用户会继续写旧写法
    assert.ok(SCOPE_CONFIG_NOTES.some((note) => note.includes('废弃')));
  });
});

describe('Agent Skill 说明', () => {
  it('列出仓库内的 2 个 Skill，且 agents-md-init 标为手动触发', () => {
    assert.deepEqual(SKILL_ITEMS.map((s) => s.name), ['ki-search', 'agents-md-init']);
    const manual = SKILL_ITEMS.find((s) => s.name === 'agents-md-init');
    assert.equal(manual.activation, 'manual');
    assert.equal(manual.activationLabel, '需手动触发');
    assert.equal(SKILL_ITEMS.find((s) => s.name === 'ki-search').activation, 'auto');
  });

  it('记忆闭环清单与规则文件路径不为空（安装器不装 Rules）', () => {
    assert.deepEqual(MEMORY_SKILLS, ['ki-search-first', 'ki-memory-lookup', 'ki-memory-write']);
    assert.equal(MEMORY_RULE_FILE, 'rules/ai-codekb-memory.md');
  });
});

describe('LLM 配置文案', () => {
  it('片段用环境变量引用，不含明文密钥', () => {
    const snippet = buildLlmConfigSnippet();
    assert.ok(snippet.startsWith('llm:'));
    assert.ok(snippet.includes('baseURL:'));
    assert.ok(snippet.includes('model:'));
    assert.ok(snippet.includes('${KI_LLM_API_KEY}'));
    assert.equal(/sk-[A-Za-z0-9]/.test(snippet), false);
  });

  it('★ 片段含常用可选字段与 OpenAI 协议说明', () => {
    const snippet = buildLlmConfigSnippet();
    for (const key of ['contextChars', 'requestTimeoutMs', 'maxTokens', 'temperature', 'supportsTools']) {
      assert.ok(snippet.includes(key), `片段缺 ${key}`);
    }
    assert.ok(snippet.includes('chat/completions'), '片段要说明只支持 OpenAI 协议');
    assert.ok(LLM_PROTOCOL_NOTE.includes('OpenAI'));
    assert.ok(LLM_PROTOCOL_NOTE.includes('chat/completions'));
  });

  it('★ contextChars 的口径被明确写成「分母」而非上限', () => {
    assert.ok(LLM_FIELD_NOTES.some((n) => n.includes('分母') && n.includes('不截断')));
    assert.ok(LLM_FIELD_NOTES.some((n) => n.includes('maxTokens')));
  });

  it('未配置 → warn 且透出后端原因；已配置 → ok 带 model@host', () => {
    const missing = describeLlmStatus({ enabled: false, reason: '未配置模型：请在配置文件的 llm 段填写 baseURL / model / apiKey' });
    assert.equal(missing.tone, 'warn');
    assert.equal(missing.title, '未配置');
    assert.ok(missing.detail.includes('llm'));

    const ready = describeLlmStatus({ enabled: true, model: 'qwen-max', baseURLHost: 'dashscope.aliyuncs.com', ackRequired: false });
    assert.equal(ready.tone, 'ok');
    assert.equal(ready.title, 'qwen-max @ dashscope.aliyuncs.com');
    assert.ok(ready.detail.includes('可用'));
  });

  it('已配置但未确认隐私 → 提示确认后才检索', () => {
    const needAck = describeLlmStatus({ enabled: true, model: 'm', baseURLHost: 'h', ackRequired: true });
    assert.equal(needAck.tone, 'ok');
    assert.ok(needAck.detail.includes('确认'));
  });

  it('取不到配置 → warn「状态未知」，不伪装成已配置', () => {
    const unknown = describeLlmStatus(null);
    assert.equal(unknown.tone, 'warn');
    assert.equal(unknown.title, '状态未知');
  });
});

describe('wikiSync 文案（开关 ≠ 可用）', () => {
  it('有可用目录 → ok，并区分来源', () => {
    const viaSource = describeWikiSync({ enabled: false, writableDir: '/w', writableFrom: 'source' });
    assert.equal(viaSource.tone, 'ok');
    assert.ok(viaSource.title.includes('导入源'));
    const viaConfig = describeWikiSync({ enabled: true, writableDir: '/w', writableFrom: 'wiki-sync' });
    assert.equal(viaConfig.tone, 'ok');
    assert.ok(viaConfig.title.includes('wikiSync.sourceDir'));
  });

  it('★ 已开启但无可用目录 → warn，不能说「已开启」了事', () => {
    const broken = describeWikiSync({ enabled: true, writableDir: null, writableFrom: null, rejectReason: 'source 指向的是文件' });
    assert.equal(broken.tone, 'warn');
    assert.ok(broken.label.includes('无可用目录'));
    assert.ok(broken.title.includes('source 指向的是文件'));
  });

  it('未开启且无原因 → muted；旧 daemon 无该字段 → muted', () => {
    assert.equal(describeWikiSync({ enabled: false, writableDir: null, writableFrom: null }).tone, 'muted');
    assert.equal(describeWikiSync(undefined).tone, 'muted');
  });
});
