---
kind: external_dependency
name: SiliconFlow 文本向量化服务（4096 维）
slug: siliconflow-embedding
category: external_dependency
category_hints:
    - vendor_identity
    - auth_protocol
scope:
    - '**'
source_files:
    - docs/configuration.md
    - src/lib/config-schema.ts
---

### SiliconFlow Embedding 提供商
- 角色：ki 默认的 Embedding 提供商，用于生成 dense 向量（Float32Array 4096 维）。
- 接入方式：配置 `embedding.provider = 'siliconflow'`，URL 固定为 `https://api.siliconflow.cn/v1/embeddings`，密钥通过 `embedding.apiKey` 注入。
- 校验：`ki doctor` 会连通该 URL、用真实密钥做一次 embedding 请求并校验返回维度与配置的 `dimension` 一致（当前均为 4096）。
- 注意：provider 枚举未做硬校验，可自定义端点；但 dimension 必须为正整数且与服务端实际返回匹配，否则向量集合 schema 不一致。