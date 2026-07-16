import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { GetPromptResult } from '@modelcontextprotocol/sdk/types.js';

export function registerPrompts(server: McpServer): void {
  // Prompt 1: 介绍 ki 的整体工作流程
  server.prompt(
    'ki-workflow',
    '介绍 KiSearch 的完整工作流程和最佳实践',
    (): GetPromptResult => {
      return {
        messages: [
          {
            role: 'user',
            content: {
              type: 'text',
              text: '请介绍 KiSearch (ki) 的完整工作流程和最佳实践。',
            },
          },
          {
            role: 'assistant',
            content: {
              type: 'text',
              text: `KiSearch（ki）是一个用于结构化知识索引和管理的 MCP 工具。以下是完整的工作流程和最佳实践：

## 1. 核心概念
- **Scope**: 知识域隔离单位，不同项目/模块使用不同 scope（如 \`project-A\`、\`project-B\`）
- **Group**: 树形结构组织知识，如 \`src/utils/auth > TokenManager\`
- **Relation**: 节点之间的关联关系（include、extend、depend、use、impl）

## 2. 标准工作流程

### Step 1: 确认 Scope
每次操作前先确认当前 scope：
- 使用 \`ki manage-index --action list-scopes\` 查看已有 scope
- 或直接在命令中指定 \`--scope <scope>\`

### Step 2: 创建索引（首次使用）
为新 scope 创建索引：
- \`ki manage-index --action create --scope <scope>\`

### Step 3: 存储知识
三种存储方式：
- **向量存储**：\`ki_store\`（scope, text, tags）— 纯文本语义检索
- **结构化同步**：\`ki_sync_relation\`（scope, group, relation, module_info, keywords）— 写入 Group 树
- **批量存储**：\`ki_bulk_store\`（scope, input）— JSON 文件路径

### Step 4: 建立关系
使用 \`ki_sync_relation\` 建立知识节点之间的关系：
- 类型：include、extend、depend、use、impl 等
- 关系支持双向查询

### Step 5: 查询与检索
- 树形查询：\`ki query-group --mode full\`
- 模块详情：\`ki get-module-info --path <path>\`
- 语义搜索：\`ki search <query>\`

## 3. 最佳实践
- 每次对话开始时先确认 scope
- 存储知识时提供完整的 keyword 和 description
- 及时同步关系，保持图谱完整性
- 定期使用语义搜索验证知识覆盖度`,
            },
          },
        ],
      };
    }
  );

  // Prompt 2: 指导如何正确存储知识
  server.prompt(
    'ki-store-guide',
    '指导如何正确地向 KiSearch 存储知识',
    (): GetPromptResult => {
      return {
        messages: [
          {
            role: 'user',
            content: {
              type: 'text',
              text: '如何正确地向 ki 存储知识？',
            },
          },
          {
            role: 'assistant',
            content: {
              type: 'text',
              text: `向 ki 存储知识时，请遵循以下规范：

## 存储字段规范

### 必填字段
- **path**: 知识节点路径，格式为 \`父节点/子节点\`，如 \`src/utils/auth > TokenManager\`
- **keyword**: 关键词，用于快速检索，如类名、函数名
- **description**: 详细描述，这是语义搜索的核心依据

### 推荐字段
- **type**: 节点类型（function, class, module, concept, api 等）
- **code**: 代码片段或示例
- **doc**: 文档说明
- **language**: 代码语言

## 存储示例

### 方式一：向量存储（纯文本语义检索）
调用 \`ki_store\` 工具，传入：
- scope: \`project-a\`
- text: \`TokenManager 是 JWT token 生成与验证工具类，支持过期检测，位于 src/utils/auth.ts\`
- tags: \`ki-search\`

### 方式二：结构化同步（写入 Group 树 + 原文）
调用 \`ki_sync_relation\` 工具，传入：
- scope: \`project-a\`
- group: \`src/utils > auth\`
- relation: \`TokenManager\`
- module_info: \`# TokenManager\n\nJWT token 生成与验证工具类...\`
- keywords: \`["TokenManager", "JWT", "过期检测"]\`

### 方式三：批量向量存储
调用 \`ki_bulk_store\` 工具，传入：
- scope: \`project-a\`
- input: \`/path/to/batch-data.json\`（JSON 数组文件路径）

## 注意事项
1. **text 要详尽**：向量搜索依据，越详细召回越精准
2. **module_info 要有结构**：建议用 Markdown 格式，便于后续检索
3. **keywords 要准确**：自然语言词，3~5 个，必须在原文中存在
4. **及时同步关系**：结构化写入后用 \`ki_query_group --mode full\` 刷新缓存
5. **scope 要正确**：确保存储到正确的知识域`,
            },
          },
        ],
      };
    }
  );
}
