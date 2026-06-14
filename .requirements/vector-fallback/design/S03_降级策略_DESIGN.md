# S-03：降级策略

> 状态：草案
> 父文档：[DESIGN.md](./DESIGN.md)

---

## 术语

| 术语 | 定义 |
|------|------|
| 静默降级 | mem CLI 不可用时不抛异常、不阻断主流程，退化为原有行为 |
| 降级触发条件 | execFileSync 抛异常、进程超时、JSON 解析失败 |

---

## 现状（AS-IS）

当前 `batch-vectorize.ts` 中的 `vectorizeOne` / `bulkVectorize` 已有错误处理：失败条目记入 errors，不中断整体。但查询端（`group-resolve.ts`、`get-module-info.ts`）完全没有与 mem CLI 交互的逻辑，不存在降级需求。

---

## 方案（TO-BE）

### 降级实现位置

降级逻辑**内嵌在 `path-search.ts` 的 `searchPath()` 中**，不独立为模块。S-03 作为独立子需求是为了明确降级接口和测试场景。

### 降级规则

```typescript
// path-search.ts 内部的降级实现
function searchPath(query, tag, scope, threshold = 0.75): PathSearchResult | null {
  try {
    const stdout = execFileSync('mem', [
      'search', query,
      '--scope', scope,
      '--tags', tag,
      '--limit', '1',
      '--json',
    ], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: SEARCH_TIMEOUT_MS,  // 15s
    });

    const json = JSON.parse(extractJson(stdout));
    if (!json.results?.length) {
      return { matched: false, rawText: '', extractedPath: '', score: 0 };
    }

    const top = json.results[0];
    if (top.score >= threshold) {
      return {
        matched: true,
        rawText: top.content,
        extractedPath: parsePathFromContent(top.content),
        score: top.score,
      };
    }
    return { matched: false, rawText: top.content, extractedPath: '', score: top.score };

  } catch (err) {
    // ── 降级：所有异常统一返回 null ──
    if ((err as any)?.code === 'ETIMEDOUT' || (err as any)?.killed) {
      process.stderr.write(`[path-search] 搜索超时(${SEARCH_TIMEOUT_MS}ms)，跳过向量兜底\n`);
    } else {
      process.stderr.write(`[path-search] 搜索失败，跳过向量兜底: ${(err as Error).message}\n`);
    }
    return null;
  }
}
```

### 调用方降级处理

`resolveGroupPath()` 和 `get-module-info.ts` 收到 `null` 时的行为：

```typescript
// group-resolve.ts 中
const fuzzyResult = searchPath(userInput, 'ki-path', scope);
if (fuzzyResult === null) {
  // 降级：跳过向量兜底，继续原有的第 7 步
} else if (fuzzyResult.matched) {
  // 向量命中，返回近似匹配
  return {
    resolvedPath: fuzzyResult.extractedPath,
    hint: `💡 近似匹配："${userInput}" → "${fuzzyResult.extractedPath}"（score: ${fuzzyResult.score.toFixed(2)}）`,
    matched: true,
    fuzzyMatched: true,
    fuzzyScore: fuzzyResult.score,
  };
}
// fuzzyResult.matched === false → 继续原有流程
```

---

## 异常处理

| 场景 | 触发条件 | 行为 | 是否对外暴露 |
|------|---------|------|-------------|
| 超时 | `execFileSync` 超过 15s | stderr 输出警告，返回 null | 否（仅 stderr） |
| 进程异常 | `execFileSync` 抛 Error | stderr 输出错误信息，返回 null | 否 |
| JSON 解析失败 | `JSON.parse` 抛异常 | 被 catch 捕获，返回 null | 否 |
| mem 未安装 | `ENOENT` 错误 | stderr 输出，返回 null | 否 |
| SILICONFLOW_API_KEY 未设置 | mem 进程报错 | stderr 输出，返回 null | 否 |

---

## 关键决策点

### D1：降级日志输出方式

| 方案 | 被否决原因 |
|------|-----------|
| 抛出异常让调用方处理 | 违反"静默降级"原则，增加调用方复杂度 |
| 完全静默（无任何输出） | 排查问题时无法知道是否触发了降级 |
| **stderr 输出 + 返回 null** ✅ | 不阻断主流程，同时保留可观测性 |

### D2：超时时间选择

| 方案 | 被否决原因 |
|------|-----------|
| 30s（与 kb-import 一致） | 查询端用户等待容忍度低，30s 太长 |
| 5s | POC 测试中正常查询需要 2-4s，5s 余量不够 |
| **15s** ✅ | 正常查询 2-4s 的 3-5 倍余量，且用户等待上限可接受 |
