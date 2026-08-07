# E2E Journey：外部Wiki直接导入与自动切分

> requirement_ref: REQ-20260806-001（REQ-01/02/03/06/07/08/12 + §4.4）
> 环境：本地 CLI（真实向量引擎，SILICONFLOW_API_KEY 已配置）
> 凭证：无（本地 CLI，无 token）

## Steps

| id | type | name | depends_on | produces | assert 要点 |
|----|------|------|------------|----------|-------------|
| setup_wiki | setup | 构造测试 wiki（git 仓库 + 5 md，1 大文件） | - | source_dir | 目录存在、git init、5 文件 |
| full_import | cli | `scan-kb import --source --scope e2e-test --root-name E2EWiki` | setup_wiki | scope, source_dir | ok:true、chunks>文件数、sourceDir 写入 |
| assert_cache | assert | relations-cache 校验 | full_import | - | chunk relation=文件名-N、sourcePath=文件#N、memoryId 非空 |
| assert_source | assert | source 块校验 | full_import | - | commit 非空、chunkSize=1000、chunkOverlap=150 |
| assert_sourcedir | assert | config sourceDir 绝对路径 | full_import | - | config.scopes[e2e-test].sourceDir=绝对路径 |
| search_pos | cli | `ki search "告警收敛"`（位置参数） | full_import | hit_relation | ok:true、命中 alarm-01、relation 输出 |
| make_changes | cli | git 制造增量（add+modify+delete+commit） | full_import | - | git 3 类变更 |
| incr_import | cli | `import --mode incremental` | make_changes | stats | added=1/modified=1/deleted=1/errors=0 |
| assert_final | assert | 终态：新增存在/修改更新/删除消失/commit 推进 | incr_import | - | 3 项断言全过 |
| no_git_error | cli | 非 git 目录跑增量 | full_import | - | 明确报错提示 git init |
| teardown | teardown | 清理 scope + wiki 目录 | - | - | 对称清理 |
