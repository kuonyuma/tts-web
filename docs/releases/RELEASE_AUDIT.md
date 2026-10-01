# Release Audit

审查对象：当前工作区，基于 `a5b5b9859d853e773c7bc511fc9867ffa931d600`，复核日期 2026-09-13。
范围：修复 REL-001 至 REL-012；未增加产品功能，未批量升级依赖，未提交、推送或公开部署。

## Verdict

**CONDITIONALLY READY**

12 项已知问题已修复，复核未发现仍未处理的 P0/P1。当前版本可以作为受控部署的 stable 候选；公开上线需遵守单进程、HTTPS、Key 授权和容量配置，并完成目标环境的真实上游冒烟验证。

## Project Model

```text
浏览器（文本、音色、BYOK、浏览器 UUID）
  ↓ 同源 HTTP / JSON
FastAPI（输入校验、请求大小/频率/并发限制、错误合同、请求 ID）
  ├─ TTS → 同键协调 → Edge WebSocket / Gemini Interactions → ffmpeg（Gemini）
  │                                   ↓
  │                           MP3 + 时间轴文件缓存
  └─ 历史 / 讲解 / 追问 → SQLite WAL（线程池、事务、容量上限）
```

前端无需编译；FastAPI 同时托管静态页面。数据库和音频位于 `backend/app/cache`，Compose 使用持久化挂载。不使用 Redis、支付、OAuth 或外部队列。当前部署约束为一个进程、一个副本；无登录系统，浏览器 UUID 不是账号认证，确定性音频缓存是共享的。

## Release Blockers

无已确认且尚未修复的 P0/P1。原问题的关闭证据如下；修复置信度均为 High。

| ID | 修复结果 | 验证证据 |
| --- | --- | --- |
| REL-001 | 镜像严格使用 lock 构建；启动直接执行已安装的 uvicorn，不再触发 uv 安装开发依赖 | `--network none` 下启动、首页和健康检查；容器重启 |
| REL-002 | TTS、讲解、Key 检查有总时限；排队有时限；SDK 连接关闭；ffmpeg 可取消；前端响应体也受超时约束 | SDK 挂起/超时、取消恢复、队列超时、ffmpeg 终止、浏览器 stalled-body 测试 |
| REL-003 | 同键请求协调并二次检查缓存；音频与时间轴成对发布；讲解/追问重复提交复用结果 | 8 个并发生成请求只调用一次 provider；时间轴与音频一致；讲解/追问并发测试 |
| REL-004 | HTML 转义覆盖单双引号；所有动态属性值也转义 | 实际 Chrome 中原 XSS payload 保持文本，无法产生事件处理器；鼠标事件不执行 payload |
| REL-005 | 缓存键仅允许 16 位小写十六进制；文件路径必须留在缓存目录，拒绝符号链接 | Windows `..%5Csentinel` 读取返回 422；读取/删除路径越界测试 |
| REL-006 | 请求体、并发、排队、频率、内存、缓存与持久化数据有上限；服务端 Key 需要独立授权 | 413/429/503/507、缓存回收、磁盘预留、SQLite 容量、授权和 BYOK 测试 |
| REL-007 | 引擎和音色组合严格校验；缓存键采用无歧义的结构化编码 | 非法引擎/音色 422；分隔符碰撞回归测试；Unicode 边界 |
| REL-008 | 真实 SDK 异常映射；错误响应隐藏上游详情；单独关闭 SDK Interactions 重试 | SDK 401/403/404/429/500 均可控；DNS/reset/timeout/malformed/empty；单次 HTTP 调用和连接关闭断言 |
| REL-009 | SQLite 与文件操作移出事件循环；初始化加锁；追问写入使用事务 | SQLite 写锁期间 health 保持响应，释放锁后恢复；并发追问不丢更新；迁移失败回滚 |
| REL-010 | Compose 环境变量改为大写并完整传递；文本长度、CORS、默认 Gemini 音色、时限生效 | Compose 配置解析；动态设置、默认音色和 CORS 测试；浏览器读取字符限制 |
| REL-011 | 磁盘成功提交之后才写 L1；失败清理临时文件和半完成缓存 | 普通音频/时间轴写入 ENOSPC 均不产生虚假内存命中；失败后重试恢复 |
| REL-012 | 缺失/空白/非法/default 客户端 ID 被拒绝，服务层也拒绝共享回退 | 历史、删除、合成、讲解 API 422；客户端隔离；旧 default 行保留且不公开 |

## High-Risk Findings

无新增且尚未修复的代码问题。公开部署的适用条件：

- 使用单进程、单副本及 HTTPS 反向代理；默认 Compose 仅绑定本机回环地址。
- 不向匿名请求开放服务端 Gemini Key。需要服务端 Key 时，由已认证的代理校验用户并注入授权 token。
- 不将浏览器 UUID 存储或共享音频缓存用作保密资料存储。
- 新写入在 SQLite 配额满时返回 507，已有记录保留；管理员需按日志中的原因释放或增加容量。

## Deferred

- P3：SDK 和 TestClient 的弃用告警；当前测试通过，不为告警进行批量升级。
- P3：Python 尚未配置独立 lint/type-check 工具；本轮未引入格式化或架构重构。

## Verified

- ✓ `uv run pytest`：**120 passed**。Windows 默认 pytest 临时目录 ACL 阻止首次运行；最终使用独立 `--basetemp` 目录完成，未更改系统权限。
- ✓ JavaScript 语法检查及 `git diff --check`。
- ✓ 实际 Chrome：XSS、合成/音频解码/时间轴、双击、上游错误、响应体超时、配置字符上限、390px 移动布局、历史删除；无未捕获浏览器异常。
- ✓ Docker 构建；断网环境的生产命令启动、静态首页、健康检查。
- ✓ 容器重启后，历史、音频和时间轴仍可读取；容器健康状态 `healthy`；退出日志显示正常关闭。
- ✓ Linux 生产镜像内：Edge 合成链路、Gemini SDK 音频与真实 ffmpeg 转换、讲解、追问、持久化、非法路径和超大请求。外部响应均为本地 mock。
- ✓ Compose 解析验证：回环绑定、大写变量和 27 项配置传递。
- ✓ 历史库迁移与失败回滚、SQLite 完整性、并发写入、缓存磁盘失败和容量恢复。

## Not Verified

- 真实 Edge / Gemini 在线调用、真实 API Key 权限与配额、当前模型可用性；测试按仓库要求禁止访问真实 provider。
- 目标生产域名、HTTPS 代理、生产硬件重启、真实生产数据恢复演练。
- 此次修改在远程 GitHub Actions 上的结果；尚未推送。已更新 CI，加入离线容器启动/重启检查。
- 未配置的 Python lint/type check；前端不存在 build 编译步骤，未将语法检查等同于构建。

## Minimum Release Fix Set

代码修复集合已完成：REL-001～REL-012。没有夹带可选产品功能。

发布前剩余操作：

1. 按 [STABLE_RELEASE.md](STABLE_RELEASE.md) 设置目标环境、备份数据，并保留旧镜像用于回滚。
2. 在目标环境用授权测试 Key 验证一次真实合成、讲解、回放及重启，再开放访问。

本地已生成候选镜像 `tts-release-verified:local`。当前工作区尚未提交，未进行 main 合并或公开发布。
