# 账号文章库与工作台 Implementation Plan

> 执行方式：本会话直接实施，使用 executing-plans、test-driven-development 与 verification-before-completion。用户已明确要求完成实现与验证，按确认需求继续，无额外审批或提交。

**Goal:** 登录账号保存文章，多标签编辑阅读，并将选文填入既有语音输入。

**Architecture:** 账号 SQLite 增量迁移及原子版本校验；独立文章状态队列；常驻 DOM 标签切换。

**Tech Stack:** FastAPI、Pydantic、SQLite、原生 ES modules、pytest、Node/CDP。

**Spec:** ../specs/2026-10-03-articles-workbench-design.md

## Global Constraints

Windows / PowerShell 7；不重写认证、TTS、AI；无新前端框架；无真实外部网络；不部署、发布或合并。

## Review Focus

跨设备版本冲突不能静默覆盖；在途保存不能确认更新的编辑；删除后创建重试不能复活；账号切换取消旧任务；IME 输入保持草稿且不提前提交。

### Task 1: 账号文章接口

- [x] 新增 tests/test_articles.py，验证 CRUD/搜索/长文/隔离/幂等/冲突/墓碑/迁移，先运行确认失败。
- [x] 新增 schemas/articles.py、services/article_migrations.py、services/article_service.py、api/articles.py；迁移接入 history_service，路由接入 main；文章接口限定 4 MiB 请求。
- [x] 运行文章测试及完整 pytest。

接口：GET/POST /api/articles；GET/PUT/DELETE /api/articles/{UUID}。创建含 id/title/content；更新含 title/content/revision；列表含 character_count、时间、revision；详情含 content。

### Task 2: 自动保存与草稿状态

- [x] 新增 scripts/test_articles_state.cjs，对独立 ES 模块动态加载，先验证缺失失败。
- [x] 实现 articles-api.js 及 articles-state.js，提供 open/create/edit/flush/remove/resolve/dispose；复用 apiFetch 并支持调用方 AbortSignal。
- [x] 运行状态测试，覆盖连续输入、保存失败、草稿恢复与冲突、删除及账号退出。

### Task 3: 工作台与文章视图

- [x] 新增 scripts/test_articles_workbench.cjs，以现有浏览器 helper 和模拟 HTTP 验证标签/搜索/导入/选文/AI/刷新/布局。
- [x] 新增 workbench.js、article-views.js、articles.css；index.html 包装原 AI 内容；app.js 接入账号身份、抽屉入口和文本填入。
- [x] 运行浏览器测试及既有前端检查，保存明暗主题与窄屏截图。

### Task 4: 审查与文档

- [x] 编写 docs/development/ARTICLES.md 并链接 README；更新计划完成项。
- [x] 检查实现与需求逐项对应，运行完整后端与全部相关前端脚本，检查 git diff 和敏感文件。
