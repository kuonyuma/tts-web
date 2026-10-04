# 后端核验记录：成立的发现与修复实施

记录日期：2026-10-04。基准：`b28699f85639ece8a8606bac044d9abbd4a3272f` 上的工作区及后续修复实施。

本文件记录额外审查摘要中已经确认的具体行为、核验时的缺口分析，以及针对 C01–C08 各项的具体代码修复和架构收敛。涉及设计取舍和需要修正的推论见[部分成立的判断](backend_partially_confirmed_findings.md)，完整背景见[后端复杂度、冗余与简化机会审查报告](backend_code_complexity_and_redundancy_report.md)。

---

## 1. 发现与修复实施清单

| 编号 | 发现主题 | 对应原报告 | 修复状态 | 核心实现与架构收敛 |
|---|---|---|---|---|
| C01 | Private 内存命中仍读取完整音频并计算 SHA-256 | F18 | 明确机制与契约 | 确认设计权衡：内存层复用不可变 bytes 减少 Python 堆分配；磁盘摘要比对保障外部同尺寸/保留 mtime 损坏能被即时捕获。 |
| C02 | Private 历史先检查用户全部 ready 文件，再取有限条目 | F14 | 已修复优化 | 调整查询顺序，先按 LIMIT 获取候选条目，仅探测返回候选条目的文件状态（缺失时标记 unavailable 并返回），避免全量资产扫描。 |
| C03 | Legacy 历史全量取回、转换时间、Python 排序后截取 | F13 | 已修复优化 | 规范 SQL 查询为 `order by strftime('%Y-%m-%d %H:%M:%f', last_played_at) desc, id desc limit ?`，将时间跨时区归一化排序与截取完全下推至数据库。 |
| C04 | Legacy 新资产落盘前全目录检查和排序 | F20 | 已修复优化 | 将 `_entries()` 重构为单趟 `os.scandir` 扫描，一次性归集 `.mp3` 与 `.timeline.json` 大小，大幅减少多重 `stat` 和 `exists` 系统调用。 |
| C05 | 讲解存档缺少应用内容量释放路径 | F10 | 已修复补齐 | 在 `explain_service.py` 增加 `delete_explanation` 与 `clear_explanations`；在 `api/explain.py` 新增 `DELETE /api/explain/{explain_key}` 与 `DELETE /api/explain` 路由，释放存储容量。 |
| C06 | 文章墓碑缺少回收政策；不存在分支有重复 UPDATE | F11 | 已修复补齐 | 消除 `delete_article` 不存在分支中的重复 UPDATE，单次 INSERT 直接写入终态墓碑；增加 `prune_tombstones(older_than_seconds)` 回收函数支持基于时间窗口清理过期墓碑。 |
| C07 | 保存讲解未验证存储预留 token 的有效性与归属 | F08 | 已修复补齐 | 在 `save_explanation` 事务内严格校验 token 归属、键与有效期限并原子消费；有效消费跳过冗余 `count(*)` 查询；无效/过期预留拒绝越权并降级限额校验。 |
| C08 | 同库仍有三套表初始化生命周期 | F07 | 已修复收敛 | 提取 `migrate_explanations(conn)` 纳入 `database.init_db()` 统一主生命周期；提取 `migrate_private_tts(conn)`，统一表迁移并保留独立 Store 实例初始化能力。 |

---

## 2. 具体修复方案与技术细节

### C01：Private 内存命中与磁盘完整校验

**定位与设计契约**：
- `PrivateTTSStore.get()` 在 `self.memory` 命中后，仍然通过 `hashlib.file_digest(file, "sha256")` 校验磁盘文件。
- 该机制是有意设计的防损坏保护：复用内存层中不可变 `bytes` 避免大块内存重新分配；同时确保当底层文件系统在外部被篡改、发生截断或遭受同尺寸损坏（保留 mtime）时，系统能够即时感知并标记 `unavailable`，而不是返回脏数据。
- 对应测试：[`test_warm_cache_detects_same_size_corruption`](../tests/test_private_tts_storage.py) 与 [`test_corruption_with_preserved_timestamps_is_unavailable`](../tests/test_private_tts_storage.py)。

### C02：Private 历史查询在 LIMIT 前逐条探测文件

**修改实现**：
- 文件：[`src/app/services/private_tts_storage.py`](../src/app/services/private_tts_storage.py)。
- 修改前：`list_history()` 先遍历当前用户的所有 `ready` 状态资产（最多可达 250 项），逐个调用 `is_file()`，然后才执行 SQL `LIMIT`。
- 修改后：先通过 SQL 获取该用户按 `last_access_ns desc` 排序的前 `limit` 条候选记录，随后仅对这批候选记录逐条验证 `is_file()`。若存在磁盘文件缺失，则调用 `_mark_unavailable` 标记并在当前返回结果中设为 `unavailable`。未在本次结果中的资产由后续访问或 `reconcile()` 发现。
- 对应测试：[`test_list_history_only_checks_candidate_files`](../tests/test_private_tts_storage.py)，验证只对 limit 范围内的文件进行磁盘存在性检查。

### C03：Legacy 历史查询下推数据库排序与截取

**修改实现**：
- 文件：[`src/app/services/history_service.py`](../src/app/services/history_service.py)。
- 修改前：`select ... from history where client_id = ?` 取出全部记录，在 Python 中逐行解析 ISO 字符串并排序，最后切片 `[:limit]`。
- 修改后：SQL 调整为：
  ```sql
  select id, text, voice, model, engine, cache_key, created_at, last_played_at
  from history where client_id = ?
  order by strftime('%Y-%m-%d %H:%M:%f', last_played_at) desc, id desc limit ?
  ```
  SQLite 内置的 `strftime('%Y-%m-%d %H:%M:%f', ...)` 会自动将不同时区 offset（如 `+08:00` 与 `+00:00`）标准化为精确到毫秒的 UTC 字符串，实现跨时区按瞬间时刻在数据库引擎中直接排序与 LIMIT 截取。
- 对应测试：[`test_legacy_history_orders_mixed_offsets_before_limiting`](../tests/test_storage_integrity.py)。

### C04：Legacy 新资产写入前单趟目录扫描优化

**修改实现**：
- 文件：[`src/app/services/cache_service.py`](../src/app/services/cache_service.py)。
- 修改前：`_entries()` 使用 `CACHE_DIR.glob("*.mp3")`，对每个文件分别调用 `is_symlink()`、`stat()`、`timeline.exists()`、`timeline.stat()`，引发大量系统调用。
- 修改后：重构为单趟 `os.scandir(CACHE_DIR)`，一次性在内存中归集 `.timeline.json` 大小与 `.mp3` 的元数据，消除重复的磁盘存在性检查与属性重复获取。

### C05：讲解存档容量释放路径补齐

**修改实现**：
- 服务层：[`src/app/services/explain_service.py`](../src/app/services/explain_service.py) 增加：
  - `delete_explanation(client_id: str, explain_key: str) -> bool`：按客户端及键删除讲解，释放记录配额。
  - `clear_explanations(client_id: str) -> int`：清空当前客户端的所有讲解记录。
- API 层：[`src/app/api/explain.py`](../src/app/api/explain.py) 新增：
  - `DELETE /api/explain/{explain_key}`：删除指定讲解，成功返回 204，不存在返回 404。
  - `DELETE /api/explain`：清空当前身份的全部讲解，成功返回 204。
- 对应测试：[`test_explanation_delete_and_clear_releases_capacity`](../tests/test_explain.py)、[`test_explain_api_delete_endpoints`](../tests/test_explain.py)。

### C06：文章墓碑消除重复 UPDATE 与增加回收策略

**修改实现**：
- 文件：[`src/app/services/article_service.py`](../src/app/services/article_service.py)。
- 消除重复 UPDATE：在 `delete_article` 的 `existing is None` 分支中，直接以终态属性执行单次 `insert`：
  ```sql
  insert into articles(id,user_id,title,content,created_at,updated_at,deleted,revision)
  values(?,?,'','',?,?,1,1)
  ```
  避免了先 INSERT 空墓碑再立即执行相同字段 UPDATE 的多余写操作。
- 墓碑生命周期回收：新增 `prune_tombstones(older_than_seconds: float = 7 * 86400.0) -> int`，清理更新时间早于保留窗口的软删除记录（`deleted=1 and updated_at < ?`），在有效防乱序重试期过后释放数据库存储空间。
- 对应测试：[`test_tombstone_inserted_without_duplicate_update`](../tests/test_articles.py)、[`test_article_tombstone_pruning`](../tests/test_articles.py)。

### C07：讲解存储预留 token 有效性校验与原子消费

**修改实现**：
- 文件：[`src/app/services/explain_service.py`](../src/app/services/explain_service.py)。
- 修改前：`save_explanation` 只要收到非空 `reservation_token` 即无条件绕过 `EXPLANATION_MAX_RECORDS` 上限，后续仅简单按 token 删除，未校验所有权、键、有效期与是否已消费。
- 修改后：在写事务内：
  1. 若已存在同键记录（更新分支）：正常覆盖，若传入 token 则一并清理。
  2. 若不存在（新增分支）：若传入 `reservation_token`，从 `explanation_storage_reservations` 表中按 token 查询并校验 `client_id == cid and explain_key == explain_key and expires_at > now`。若匹配有效，则原子删除该预留并消费成功，同时跳过冗余的 `count(*)` 查询。
  3. 若 token 无效、已过期、错所有者、错键或未传 token：执行容量检查 `count(*) >= settings.EXPLANATION_MAX_RECORDS`，若达到上限则抛出 `StorageFullError`。
- 对应测试：[`test_invalid_or_expired_reservation_token_cannot_bypass_quota`](../tests/test_explain.py)。

### C08：收敛数据库表初始化生命周期

**修改实现**：
- 抽取讲解迁移：新建 [`src/app/services/explanation_migrations.py`](../src/app/services/explanation_migrations.py)，提供纯函数 `migrate_explanations(conn: sqlite3.Connection)`。
- 收敛主库启动：在 [`src/app/services/database.py`](../src/app/services/database.py) 的 `init_db()` 中统一执行 `migrate_users`、`migrate_articles`、`migrate_history` 与 `migrate_explanations`，使讲解表在主库启动时统一完成创建与升级；连接 helper `_get_conn()` 恢复为纯粹的连接管理。
- 抽取私有 TTS 迁移：新建 [`src/app/services/private_tts_migrations.py`](../src/app/services/private_tts_migrations.py)，提供 `migrate_private_tts(conn: sqlite3.Connection)`，由 `PrivateTTSStore.init()` 调用，兼顾独立 Store 实例与统一结构定义。
- 对应测试：全部数据库回归测试、[`test_storage_roundtrip_and_migration_metadata`](../tests/test_explain.py)、[`test_article_migration_preserves_users_and_history`](../tests/test_articles.py)。

---

## 3. 验证记录

2026-10-04 完成修改后运行全量测试套件：

```powershell
& ".\.venv\Scripts\python.exe" -m pytest tests -q
```

运行结果：
```text
468 passed, 2 warnings in 31.25s
```

较基准通过的 462 个用例新增了 6 个针对本次修复的完备单元测试（覆盖预留防越权、讲解容量释放、墓碑单次插入、墓碑回收清理、候选历史检查等边界），所有核心测试全数通过，无任何回归故障。
