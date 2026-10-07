# 仓库冗余代码清理记录

基线：`e715417`；分支：`refactor/remove-unused-code`。工作区起始无未提交改动。

本轮重新检查当前实现，不把历史报告中已经删除的代码再次计入成果。检查覆盖后端定义、导入与调用链，前端静态/动态导入、生成 DOM、CSS token、测试消费者，以及安装、CLI、CI 和 Docker 入口。第三方 CodeMirror 实现、运行数据和凭据不属于删除范围。

## 已清理

| 范围 | 清理内容与证据 |
|---|---|
| 身份依赖 | 删除无人调用的异步 `require_client_id` 包装；实际路径直接调用 `validate_client_id`。删除认证路由未使用的 `admin_account` 导入。 |
| IP 解析 | 中间件和测试统一使用 `resolve_client_ip`，删除仅为旧名称存在的 `_resolve_client_ip` 别名。 |
| 讲解初始化 | 删除未参与运行的 `_initialized`、`_init_lock` 和 `threading` 导入，以及 8 处无效测试重置；初始化继续由 `database.init_db` 负责。 |
| 讲解记账 | 删除已无调用者的独立 `record_usage`；首次讲解和追问继续在保存事务内执行 `_upsert_daily_usage`。 |
| 其他导入 | 删除历史服务未使用的 `datetime` 和引擎包无人使用的 `VoiceInfo` 重导出；具体引擎仍从定义模块导入类型。 |
| 依赖声明 | 删除无安装入口引用、且遗漏 Redis 和 urllib3 安全版本下限的 `requirements.txt`；实际安装、启动、CI、Docker 使用 `pyproject.toml` 和 `uv.lock`。 |
| 孤立维护函数 | 删除仅被自身测试调用的 `prune_tombstones` 及测试、专用导入。它从未接入应用、CLI 或调度；同步纠正文档。文章墓碑和迟到请求保护保持原有运行行为，目前没有自动回收。 |
| 数据库索引 | 迁移删除 `idx_history_client` 和 `idx_explanations_client`。实际查询可使用已有 `(client_id, cache_key)` / `(client_id, explain_key)` 唯一索引；历史列表的标准化时间排序原本也需要临时排序，旧时间索引不能满足它。 |
| 会话前端 | 合并分钟/秒时间格式化函数；删除 `setCurrentExplainText` 前重复的 AI 重置及空态渲染，保留其会话失效处理。 |
| Markdown | 删除只被测试使用的 `renderArticleMarkdown`；原有安全、HTML 和换行断言改为验证生产使用的 `renderArticleBlocks` 输出，并删除因此变成自比较的断言。 |
| 样式 | 删除无 DOM 消费者的 `.ai-heading`，以及 4 个无 CSS/JS 消费者的主题 token，共 8 处 token 声明。 |
| 测试基础设施 | 8 套测试复用 `frontend_test_server.cjs`，删除重复静态文件响应和随之无用的导入、根目录变量。保留各套业务 API fixture 与断言。新增真实离线 HTTP 回归并接入 CI。 |

代码、脚本、测试、CI 和依赖声明合计 **新增 123 行、删除 224 行，净减少 101 行**；口径包含新增共享 helper 与回归测试，不包含审计/计划文档和生成截图。

## 经核实保留的内容

- Legacy/Private 存储是不同的活跃契约；保留匿名共享、owner 隔离、旧 key 重播、迁移和恢复保护。
- 请求准入、认证、CSRF、容量预留、付费调用额度、并发和超时控制保护不同资源。
- FastAPI/Pydantic 回调、CodeMirror 自生类及动态 `cm-md-hN` 选择器有实际入口。
- Copilot 状态 getter 与 TTS 超时 getter 被异步回归直接用于断言，并非无人使用的接口。
- `legacyHistoryId` 是保留的持久化来源信息；薄 LLM gateway 仍被调用。
- 文章编辑器测试有专用根页面/CSP；账号测试原先根路径返回 404；工作台测试原先缺失路径返回 JSON 404。因此本轮没有强行用相同静态 fixture 替换这些不同语义。
- 历史审计文件保留为记录；与本轮删除相关的当前状态声明已更正。

## 验证

- 清理前：470 项后端测试通过；最终：470 项通过，2 个原有第三方弃用警告。测试数相同是因为新增 1 项旧索引升级回归、删除 1 项孤立墓碑函数测试。
- 新增索引回归先失败再通过：验证旧索引清理、重复启动、已有记录保留、跨时区历史排序和 owner 隔离/清空。
- `scripts/test_*.cjs` 实际枚举共 17 套（16 套原有、1 套新增），全部通过；覆盖 IME、文章工作台、异步旧响应、音频、侧栏、主题、账号和共享服务 HTTP 行为。
- `node scripts/check_frontend.cjs` 检查 19 个模块通过。
- `npm.cmd run build:editor` 通过，`git diff --exit-code -- frontend/vendor` 通过。
- Python AST/引用复查未留下未使用导入；第一方 CSS custom-property 复查未留下无消费者声明；`git diff --check` 通过。
- 独立审阅未发现阻断问题。Antigravity 恢复返回旧报告，未计入当前验证依据。

本记录中的验证均为本地结果，远端 CI 状态以关联 PR 为准。本轮未执行本地 Docker 构建或真实上游调用，也未改动生产数据库。索引清理仅随应用未来正常初始化执行。
