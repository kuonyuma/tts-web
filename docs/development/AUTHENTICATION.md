# 登录和账号管理设计

目标：在已有注册基础上完成登录、JWT/Session、权限、邮箱验证、密码找回、
GitHub 第三方登录和账号页面。继续使用 FastAPI/Pydantic/sqlite3/原生 JS。

## 决策

- JWT 使用 PyJWT HS256，固定算法、issuer、audience、exp/iat/jti/sub 校验。
  Session 存数据库，JWT 关联 Session；退出、重置密码、停用账号立即撤销。
  不增加 refresh token。网页用 HttpOnly、SameSite=Lax Cookie，API 支持 Bearer。
- Cookie 写请求校验 CSRF cookie/header 和数据库中的哈希。登录等匿名写入口
  校验 Origin/Sec-Fetch-Site；生产 Cookie 必须 Secure。
- 用户加 email（可空且唯一）、email_verified、role（user/admin）、is_active。
  原用户保留身份和哈希。新公网注册要求邮箱，未验证账号仅能管理账号。
  role 从数据库读取，不信任客户端或旧 JWT 的权限声明。
- 管理员只能由本地管理命令建立；提供管理员用户列表和角色/状态修改。
  不允许删除最后一个可用管理员，不允许管理员停用自己。
- 验证/重置链接由随机令牌构成，数据库只存 SHA256 摘要、目的和过期时间。
  一次性、事务消费、邮箱绑定；重置撤销所有 Session。请求响应不枚举邮箱。
  使用 SMTP，后台发信，错误日志不包含地址、密码或令牌。重新发送有冷却。
- GitHub OAuth 授权码 + state + 浏览器绑定 + PKCE。只信任 GitHub ID 和
  GitHub 返回的 verified 邮箱，绝不按相同邮箱自动关联现有账号。用户可以在
  登录后显式关联 GitHub；已有绑定不能转移。未配置时页面不显示登录按钮。
- JWT 密钥生产环境显式配置；单机开发模式自动生成并保存在现有 SQLite 中，
  重启后不变化。部署地址由 PUBLIC_BASE_URL 设置，不根据任意 Host 生成链接。
- ACCOUNT_AUTH_REQUIRED 默认 false 保持单机兼容；true 时要求账号身份，
  使用 private TTS 存储。已登录身份忽略 X-Client-ID，不允许匿名伪造保留的
  account_ ID；业务继续复用 client_id/owner_id，不机械重建所有业务表。
  原有 private TTS / trusted_proxy Copilot 在 false 时继续只接受可信代理，
  包括上游转发 Authorization 的情况；本地注册账号不能绕过代理入口。
- 注册/登录/邮箱/找回/重置/账号设置页面共用 account.html。JWT 不存
  localStorage；页面只保留非敏感账号作用域提示。会话按账号分区，切换身份
  重新载入，历史匿名会话不自动归属给账号。

## 数据库

沿用现有初始化事务内 SQL 迁移，增加用户字段及唯一邮箱索引，并新增
auth_sessions、auth_tokens、oauth_states、oauth_accounts、auth_rate_limits、
app_secrets 表。索引按 Session 用户/过期和一次性令牌用途/用户建立。
所有持久化使用参数化 SQL；令牌消费、Session 撤销及权限更新保持事务性。

## API

- POST /api/users/register；GET /api/users、PATCH /api/users/{id}（管理员）
- GET /api/auth/config；POST /api/auth/login；GET /api/auth/me；POST /api/auth/logout
- POST /api/auth/email/verification、POST /api/auth/email/verify；PUT /api/auth/email
- POST /api/auth/password/forgot、POST /api/auth/password/reset
- GET /api/auth/oauth/github/start、GET /api/auth/oauth/github/callback
- POST /api/auth/oauth/github/link

注册请求示例（返回 201；重复用户名/邮箱 409；格式错误 422）：

```json
{"username":"user123","email":"user@example.com","password":"example-password"}
```

公开响应包含 id、username、email、email_verified、role、is_active、
has_password、created_at、updated_at，不包含 password 或 password_hash。
登录请求为 `{"identity":"user123","password":"example-password"}`；响应包含
access_token、token_type=bearer、expires_in 和上述公开 user，同时设置浏览器 Cookie。
API 客户端使用 `Authorization: Bearer <access_token>`；网页使用同源 Cookie。

## 实施与验证计划

1. 先写失败测试：新字段迁移、JWT登录、Cookie/Bearer、CSRF、退出撤销、
   过期/篡改/停用拒绝、管理员授权及最后管理员保护。
2. 实现配置、增量 DDL、密码验证、账号服务、Session/JWT服务和薄路由。
3. 先写邮件及 OAuth 失败测试，再实现 SMTP MIME、一次性令牌和 GitHub 流程。
   测试使用真实 SQLite/密码哈希和模拟 SMTP/HTTP，不调用真实第三方。
4. 对接业务身份依赖，验证伪造 client_id、跨用户历史/音频/讲解访问均被阻止。
5. 实现账号页面及主页面账号入口、作用域切换，加入离线浏览器回归脚本。
6. 完整 pytest、现有前端检查、新浏览器测试、Docker 构建及 HTTP 认证烟测，
   检查 diff 和代码审查。外部实发邮件和真实 GitHub 授权需运维配置后验收。

测试重点：旧数据不丢失；JWT与Session双重过期；token单次使用及并发竞争；
重置后旧Session失效；匿名/普通用户无管理权限；OAuth state/cookie/PKCE绑定；
verified邮箱不能偷偷合并账号；CSRF不能借有效Cookie修改状态；邮件内容令牌
只在fragment中传递，不进入访问日志；任何错误不回显密码、token、SMTP secret。

## 启用与运维

默认配置保留匿名单机模式，也可以在 `/account.html` 注册和登录。新建账号
默认 role=user。邮箱可空以兼容第一阶段账号，但账号页面注册要求填写邮箱。
注册不会自动登录；未配置 SMTP 时可以注册，但不会声称邮件已经送出。
开发 JWT 密钥保存在 app_secrets 表，包含账号的 history.db 需要持续备份。
生产 JWT 密钥应通过 AUTH_JWT_SECRET 或其 _FILE 版本提供，不使用自动密钥。

本地开发可以通过 localhost、127.0.0.1 或 [::1] 访问，包括自定义端口。
当 PUBLIC_BASE_URL 也是回环地址时，账号写请求兼容实际访问地址的同源
Origin，仍校验协议、主机、端口并拒绝 cross-site。生产环境和配置为公网
域名的环境仍要求 Origin 精确匹配 PUBLIC_BASE_URL，不信任任意 Host。
邮件和 GitHub 回调始终使用 PUBLIC_BASE_URL；使用邮件/OAuth 前，应将它
设置为实际访问地址。局域网地址也需要显式配置 PUBLIC_BASE_URL。

公网账号模式至少设置：

```dotenv
APP_ENV=production
ACCOUNT_AUTH_REQUIRED=true
TTS_STORAGE_MODE=private
PUBLIC_BASE_URL=https://your-domain.example
AUTH_JWT_SECRET=<至少32字节的随机密钥>
REDIS_URL=<已有Copilot分布式配额的Redis地址>
SMTP_HOST=<邮件服务主机>
SMTP_PORT=587
SMTP_SECURITY=starttls
SMTP_FROM=<发件邮箱>
SMTP_USERNAME=<SMTP账号>
SMTP_PASSWORD=<SMTP密码>
```

如果 SMTP 使用隐式 TLS，设 SMTP_SECURITY=ssl 和适当端口（通常 465）。
plain 仅允许本地开发。SMTP_PASSWORD_FILE、AUTH_JWT_SECRET_FILE、
GITHUB_CLIENT_SECRET_FILE 也可从已挂载的只读 secrets 目录读取。
邮件链接使用固定 PUBLIC_BASE_URL，不依赖不可信 Host/转发头。
发送失败会记录脱敏错误类型，用户可一分钟后重发；没有邮件投递队列或退信
监控，不保证第三方 SMTP 的最终投递。忘记密码只针对已验证邮箱发送链接。

GitHub：在自己的 GitHub 账号创建 OAuth App，将回调设为：
`https://your-domain.example/api/auth/oauth/github/callback`，配置
GITHUB_CLIENT_ID、GITHUB_CLIENT_SECRET。没有凭据时该入口不显示，API 返回
503，绝不模拟登录成功。开发环境可使用配置中的 localhost 回调。
第三方账号初次创建为普通用户、无本地密码；有 verified 邮箱时可通过
找回密码设置本地密码。没有 verified 邮箱时，先在 GitHub 验证邮箱，再次
登录会将该邮箱添加到没有邮箱的账号；邮箱冲突会拒绝，不合并账号。
第三方账号更换恢复邮箱必须先通过已验证邮箱设置本地密码，再验证当前密码。
GitHub 关联只能从浏览器 Cookie 会话发起，回调必须仍是发起时的同一个会话；
关联途中切换账号、退出或重置密码均会拒绝关联。
现有账号邮箱冲突不会自动合并，必须登录后点击“关联 GitHub”。

创建第一个管理员（PowerShell；密码交互输入，不出现在命令参数中）：

```powershell
$env:PYTHONPATH = 'src'
uv run python -m app.manage create-admin --username operator --email operator@example.com
```

该本地运维命令会将指定邮箱标记为已验证，操作者负责确认邮箱归属。
不存在“首个公开注册用户自动成为管理员”逻辑。管理员在账号页面管理用户；
后端也提供 GET /api/users（limit≤200，offset）和 PATCH /api/users/{id}。
Cookie 调用 PATCH/POST/PUT/DELETE 时，需要 X-CSRF-Token 与 tts_csrf Cookie
匹配；命令行使用登录响应中的 Bearer JWT 无需浏览器 CSRF。
JWT 只包含身份/Session/时间声明，权限和账号状态每次读取数据库。

登录 Session 默认8小时；验证链接24小时；重置链接30分钟；均可由 AUTH_*
设置改变。退出只撤销当前 Session，重置密码/停用用户撤销全部 Session。
关闭浏览器不会立即撤销持久 Cookie；到期或显式退出才失效。未实现 refresh
token、MFA、邮箱更换通知或其他第三方提供商。
失效浏览器 Session 在读取 /api/auth/me 或退出时会清除认证 Cookie；默认
单机模式随后可以继续匿名使用，强制账号模式则重新进入登录页。

账号业务的稳定 owner 为 account_<id>。服务端拒绝匿名伪造此保留前缀；
登录账号的历史、讲解、聊天、配额都忽略 X-Client-ID。公开账号模式强制使用
private 音频存储，不能配置 legacy 共享音频。既有匿名/代理记录保留原归属，
不自动认领。浏览器会话按账号分区，退出后回到单机的匿名分区；浏览器
localStorage 本身不提供针对同一操作系统用户的加密保护。

验证码和重置令牌在邮件 URL fragment 中传递，页面立即清除地址中的令牌。
GitHub 的临时 code/state 按 OAuth 协议位于回调查询参数；部署反向代理应避免
记录该回调的完整查询字符串（现有容器关闭 uvicorn access log）。
生产 TLS 终止代理、SMTP账号、GitHub OAuth App 和 DNS 是运营环境配置，
仓库测试使用隔离的 SMTP/HTTP 模拟服务，不会发送真实邮件或请求真实 GitHub。

## 验证结果

- 完整 `uv run pytest -q --tb=short`：440 个用例通过，包括已有单机业务与新增账号、
  邮件/OAuth、权限、跨用户私有音频、无效 JWT 和迁移测试。既有依赖仍有
  google-genai/Starlette 的弃用警告。
- 登录失败在服务端记录 identity_not_found、account_inactive 或 password_mismatch，
  不记录账号、邮箱、密码或哈希；客户端仍统一返回 401，避免枚举账号。
- CI 现有前端检查通过；新增 `node scripts/test_accounts.cjs` 覆盖注册、
  密码确认、登录、JWT 不落 localStorage、CSRF 退出、重置链接和手机布局。
  页面截图：`docs/screenshots/accounts-register.png`、`accounts-mobile.png`。
- Docker 构建通过；隔离无外网容器运行 `scripts/smoke_auth.py`，真实 HTTP
  验证注册、重复、校验、Cookie/Bearer、CSRF、退出撤销和重启持久化。
  烟测请求发送真实浏览器 Origin，覆盖默认 localhost 配置下的 127.0.0.1 访问。
  该烟测也已加入 CI；不会接触现有账号数据库。
- `docker compose config --quiet`、`git diff --check` 通过；项目未配置
  Python lint 或 type check，未引入无关工具。独立审查指出的 OAuth 关联
  会话、失效 Cookie 和既有代理兼容问题已修复并增加回归测试。
