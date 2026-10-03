# 基础账号创建

本文件记录第一阶段的注册基础设施。项目现已扩展登录、JWT/Session、权限、
邮箱验证/密码找回、GitHub OAuth 和账号页面；当前设计、配置和接口以
[AUTHENTICATION.md](AUTHENTICATION.md) 为准，下文的“未实现”描述属于初版范围。

## 现有结构与最小方案

后端使用 FastAPI、Pydantic 2 和标准库 sqlite3，无 ORM、通用 DAO 或数据库
session 层。路由位于 `src/app/api`，业务及持久化位于 `src/app/services`，
请求/响应位于 `src/app/schemas`，通过 FastAPI Depends 或模块函数组合服务。
配置使用 python-dotenv 和 `config.Settings`；异常由 `main.py` 统一转为
`detail` 响应，数据库故障不返回内部错误。前端为原生 ES modules。

现有 `history.db` 保存历史、讲解/聊天消息、Copilot 用量和存储预留；
private 模式还保存音频资产和历史。没有 User/Account/Profile、密码哈希、
本地登录、JWT、session 或账号配置。已有 development 客户端标识及
trusted_proxy 身份入口，但它们不对应本地账号。

迁移没有 Alembic 等工具，已有事务 SQL 和字段检查。新增账号沿用该方式，
不引入 ORM、通用 repository 或全局迁移框架，也不改变旧表的归属。
单独新建账号数据库需要额外配置、备份和 Docker 卷；目前复用现有数据库。

## 实施与验证计划

- [x] 先写 TestClient 注册测试并验证失败：201、安全响应、重复、参数边界。
- [x] 新增 `schemas/users.py`（请求/安全 DTO）、`services/passwords.py`
  （Argon2id）、`services/user_service.py`（User 模型和注册/SQL）、
  `services/user_migrations.py`（事务内增量 DDL）、`api/users.py`（薄路由）。
- [x] 修改 `history_service.py` 的事务初始化和 `main.py` 路由注册；更新
  `pyproject.toml`、`requirements.txt`、`uv.lock`，为账号响应添加 no-store。
- [x] 添加真实 SQLite/Argon2 测试：唯一约束、并发注册、非明文、随机盐、
  数据库/提交故障、迁移重复执行及回滚、旧数据和单机功能保留。
- [x] 运行 pytest 全套、已有前端检查，审查 git diff。项目无已配置的
  Python lint/type check，不新增第二套测试框架或无关工具。

## 数据与接口约定

User 只含 `id`、`username`、`password_hash`、`created_at`、`updated_at`。
用户名 3–32 字符，只允许 ASCII 字母、数字、下划线，统一转成小写；数据库
使用 NOCASE UNIQUE 约束作为并发及大小写冲突的最终保障。密码 8–128 字符，
允许 Unicode 和空格但拒绝纯空白或无效 Unicode，不裁剪或截断密码。

`POST /api/users/register` 无需身份请求头：

```json
{"username": "user123", "password": "example-password"}
```

成功返回 201：

```json
{"id": 1, "username": "user123", "created_at": "2026-10-02T00:00:00+00:00", "updated_at": "2026-10-02T00:00:00+00:00"}
```

重复用户名为 409；参数错误为 422；数据库故障沿用现有 503/507 响应。
不存在 email 字段，未知字段拒绝，避免调用方误以为邮箱已经保存。
密码使用 argon2-cffi PasswordHasher 的 Argon2id 和随机盐，哈希参数包含在
结果中。哈希工作在工作线程执行，并在单进程内限制为一次一个。
注册请求使用 SecretStr，响应只允许公开字段，不返回密码或哈希。

## 数据库迁移与持久化

`user_migrations.migrate_users(conn)` 在现有启动初始化的 `BEGIN IMMEDIATE`
事务中执行增量 SQL；旧库新增 users 表，新库同时建立原有表，失败回滚。
users 的 id 为 INTEGER PRIMARY KEY AUTOINCREMENT，其余字段均 NOT NULL；
username 的 UNIQUE 自动建立索引，无需重复索引。两个时间字段保存 UTC ISO
时间。updated_at 在注册时等于 created_at，未来更新接口必须同步更新它。
迁移可重复运行，不重建/删除旧业务表，不需要独立 migration 命令。

本地文件为 `src/app/cache/history.db`，Docker 持久化到已有
`backend/app/cache/history.db`。虽然目录名叫 cache，这个数据库包含持久业务
数据和账号：只能清理音频或指定业务记录，不能删除整个目录或数据库。
现有 `scripts/clear_legacy_tts.py` 只删除旧 history 行及旧音频，保留账号。
备份时应停止写入或使用 SQLite 在线备份 API，不能只复制活动 WAL 数据库的
主文件。迁移前备份；旧版本回退不会删除新增 users 表。

## 单机兼容与后续归属

不创建默认账号，不给旧记录添加 user_id，不替换现有 client_id/owner_id，
原有 TTS、讲解和前端流程继续使用原来的身份约定。注册成功不代表登录，
也不授予 trusted_proxy 身份或旧记录访问权。没有新增注册 UI。

| 数据 | 登录阶段的演进 |
| --- | --- |
| history | 经身份验证并确认归属后迁移到 user_id，保留旧匿名记录的迁移策略 |
| explanations/messages | 讲解和追问随账号隔离；更新所有读取、写入、删除条件 |
| copilot_usage_daily、Redis quota | 统一使用可信账号 ID 计费和限额 |
| explanation_storage_reservations | 随账号作用域的请求和配额一起调整 |
| tts_history_v2、tts_audio_assets | 将 owner_id 对接稳定账号身份，保留复合索引/关联 |
| localStorage 会话/活动会话 | 登录时明确导入归属，按账号分区，退出切换时清理界面状态 |
| 主题/声音偏好 | 需要跨设备同步时再建立账号设置；BYOK key 不自动迁入数据库 |
| legacy 共享音频缓存 | 公网上线前评估隐私并切换 private 模式，不能凭 client UUID 当作认证 |

当前不实现登录、JWT/refresh token、RBAC、OAuth、邮件验证或找回密码。
后续顺序：确定登录与现有代理身份的集成方式 → 实现登录/退出和服务端可信
身份 → 迁移并测试业务数据归属 → HTTPS、注册/登录专用限流及目标环境哈希
资源测试、备份恢复 → 有实际需求时再增加邮箱、密码重置和权限。

## 本次验证

- `uv run pytest`：373 个用例通过，其中注册专项 44 个；仅有既有依赖的
  google-genai/Starlette 弃用警告。
- CI 中现有前端检查全部通过：`test_frontend_syntax.cjs`、
  `check_frontend.cjs`、`test_conversations.cjs`、`test_browser_helper.cjs`、
  `test_frontend.cjs`、`test_theme_and_sidebar.cjs`、`test_async_state.cjs`、
  `test_chat.cjs`。测试生成的已跟踪截图已还原，不包含界面改动。
- `docker build --tag japanese-tts-web:accounts-check .` 成功；独立无外网的
  Python 3.13 容器真实 HTTP 注册返回 201，重启后同名返回 409；数据库中的
  Argon2id 可验证，首页及原匿名历史接口正常。测试容器和匿名卷已删除。
- `git diff --check` 通过；只读代码审查没有 Critical/Important 问题。
- 无已配置的 Python lint/type check，未将语法检查当作类型检查。
