# 代码冗余与重构遗留审计报告

审查及实施日期：2026-10-02。基线提交：`e3928f3e96161a4e879b0acd1772a6ebd17c6908`。先完成审计，再依据用户指令分两轮精简。第 1–6 节及附录主要保留删除前的分析、行号和规模口径，S05 另注明工作树复核；第一轮实施见第 7 节，用户追加“缩减还未删除的部分”后的最终状态见第 8 节。

实施状态：H01–H17 和两项无用依赖已清理；第二轮完成 S01–S04、S08 的无消费者回调部分、D01 代理鉴权复用及 D08 浏览器基础设施提取。S05 旧存储、数据迁移、来源字段及其余活跃合同仍保留。代码范围累计净减少 **2,845 行**，最终后端 **329 项测试通过**，八套页面回归及工具生命周期回归通过。

## 审查范围、方法与结论边界

完整阅读范围为全部 100 个 Git 跟踪文本文件，另完整解析 `uv.lock` 的 56 条 package 记录及依赖关系；8 张截图只核对用途和生成脚本，不将图片当作代码阅读。源码、测试、脚本、文档、部署配置均非抽样审查。忽略 `.git` 内部文件、第三方虚拟环境实现、运行缓存、生成音频和本地密钥配置；没有读取实际凭据或生产数据库。逐文件清单见附录。

| 区域 | 跟踪文件数 | 物理行数 | 检查内容 |
|---|---:|---:|---|
| `src/` | 36 | 4,153 | 路由、DI、框架回调、Schema、TTS/LLM、存储、并发、错误 |
| `frontend/` | 17 | 6,641 | 全部 JS/HTML/CSS、静态和动态导入、动态 DOM、事件、状态、CSS 作用域 |
| `tests/` | 14 | 3,330 | 全部测试、pytest 自动发现与 fixture、mock/patch、迁移覆盖 |
| `scripts/` | 13 | 2,298 | CLI、检查器、全部浏览器测试及离线清理入口 |
| 文档/根配置/CI | 20 | 2,046 | 文档、环境变量、依赖声明、Docker、启动/停止、许可证 |
| `uv.lock` | 1 | 1,455 | 完整依赖图；不把平台 wheel/hash 行当作可维护业务代码 |
| 截图 | 8 | — | 路径和生成/覆盖用途 |
| 合计 | 109 | 18,468 文本行 + 1,455 锁文件行 | 本报告自身不在基线统计中 |

证据包括定义、全仓符号检索、导入图、FastAPI 注册/依赖注入、Pydantic 装饰器、pytest 收集、浏览器动态模板和事件委托、配置模式选择、测试调用及 Git 历史。未发现通过 entry points、importlib、反射注册隐藏 TTS 引擎的机制；引擎实际由固定 `_ENGINES` 注册表使用。Python `getattr` 用于异常/SDK 属性，Redis `eval` 执行额度和锁 Lua，不能当作任意业务符号的动态入口。

“高置信度可删除”限定当前仓库自带入口，仍需同步修改明确列出的调用边和回归验证。它不表示未知外部 Python 调用方、自定义旧网页或历史数据已被证明不存在，也不承诺“0% 风险”。活跃包装函数与需要迁移测试的兼容逻辑分别标注，避免把可简化误称为零调用。

### 对原摘要的核验与修正

| 原结论 | 核验结果 |
|---|---|
| 报告文件已经生成 | 文件存在；本轮更新其中错误分类、调用位置、行数口径，并补充遗漏项 |
| `pcm_to_wav` 无业务调用 | 成立；还有导入、`__all__` 和专属单测，需要联动清理 |
| `GEMINI_TEXT_MODEL` 除定义外零引用 | 表述错误：`.env.example:16`、`docker-compose.yml:23` 仍声明/传递它；正确结论是没有运行时代码读取此 Settings 字段 |
| 四个旧前端文件约 1340 行 | 1340 是非空行之和；物理行之和为 1532。下文统一说明统计口径 |
| `player.js` 可以直接物理删除 | 需同步移除 `scripts/test_async_state.cjs:114` 的动态导入，否则 CI 浏览器测试会失败 |
| `_generation_parts` 可直接删除 | 当前主实现返回 tuple，但现有测试仍返回字符串；归入待确认/迁移测试项 |
| 四个未接 CI 的脚本是一次性死代码 | 不成立。它们有独有当前功能断言，是直接可执行 CLI；CI 没调用不是删除证据 |
| `conversations.js:46–56` 定义 `formatTimestamp` | 不成立。该区域是 remove/append；重复实际在 `app.js:50–75` |
| 两段代理鉴权完全等价、可减少约 35 行 | 不准确；短密钥检查和错误文案不同，两块本身共约 17 行，净减少量需扣除公共函数及调用 |
| 可删除 8 文件、总计约 3450 行/20%–25% | 依据不足，混合了高置信、待确认、迁移退役和非空行口径；重新统计见第 6 节 |
| 当前 281 项测试通过 | 本轮实际执行已证实；仅代表现状基线，不证明未来删除方案无回归 |

## 1. 高置信度可删除

### H01 `src/app/services/tts_service.py:90:pcm_to_wav`

类型：Dead Code / 重构遗留。

证据：

- 定义范围 90–106；生产源码无调用。`tests/test_api.py:97` 是唯一调用，94–105 的测试只验证这个函数自身。
- `tts_service.py:1–2` 的 `io/wave` 和 `:154` 的导出只服务该路径；`test_api.py:1–2/:12` 也仅用于专属测试。
- 实际 Gemini 路径为 `GeminiTTSEngine.synthesize:165 → pcm_to_mp3:66 → asyncio.create_subprocess_exec("ffmpeg")`，Edge 输出 MP3。WAV 函数并非等价替换对象，只是已经没有业务入口。

建议：删除函数、专属导出、导入和专属测试，保留 MP3 转换及相关真实 ffmpeg mock 集成测试。

风险：低；会移除 Python 导出符号。估算生产 20 行、关联测试 15 行，共 35 行。

### H02 `src/app/config.py:60:Settings.GEMINI_TEXT_MODEL`

类型：过期配置。

证据：

- 无 `settings.GEMINI_TEXT_MODEL` 读取、动态配置查找或测试消费。
- `.env.example:16` 和 `docker-compose.yml:23` 是残留声明/传递边；并非全库零引用。
- 当前讲解使用 `llm/registry.py` 的 DeepSeek/GLM/Qwen profile；Gemini TTS 继续读取独立的 `GEMINI_TTS_MODEL`。

建议：同步删除以上三处，保留 TTS 模型配置。风险：低。估算 3 行。

### H03 `frontend/history.js`（整文件）

类型：Dead Code / 历史架构残留。

证据：

- `index.html:271 → app.js:2–10` 的生产导入图不包含该模块；全仓无其他动态导入/调用其入口。
- `initHistory:315` 绑定的 `historySection/historyList/historyBadge/historyEmpty` 等 DOM 不在当前 HTML，也无其他动态创建入口。旧 `.history-item/.sidebar-toast` 只能从该模块无人调用的流程生成。
- 当前使用 `app.js` 会话列表和 `conversations.js:ConversationStore`；`app.js:334` 的首次旧历史导入仍是有效流程。
- 整个 frontend 仍被 FastAPI 静态托管，旧文件 URL 可访问；可访问文件不等于页面会执行其业务。

建议：删除模块。保留后端历史 API、首次迁移及 localStorage 迁移标记。

风险：当前自带页面低；外部旧网页需另外评估。旧模块删除服务端历史，当前会话删除只删本地记录，两种行为并不等价。439 物理行/389 非空行。

### H04 `frontend/player.js`（整文件）

类型：Dead Code / 历史架构残留。

证据：

- 生产图不导入；当前没有 `audioPlayer/playerContainer/waveform*` 旧 DOM。`app.js:9` 使用 `MessagePlayer`。
- 唯一动态导入为 `scripts/test_async_state.cjs:114`，赋给 `window.player`；完整脚本没有读取/调用它。导入只执行声明，没有旧播放器初始化副作用。
- 新播放器每消息独立持有 audio、进度、倍速、可见下载及对象 URL 生命周期；不包含旧波形采样功能，不能声称所有旧能力逐一等价。

建议：删除文件，并移除测试中无效动态导入。风险：低；单独删文件而保留 import 会破坏 CI。365 物理行/322 非空行。

### H05 `frontend/player.css`、`frontend/history.css`、`frontend/style.css:14–15`

类型：废弃样式 / 无效加载边。

证据：

- 两文件虽被 import，但全部规则依赖旧播放器/抽屉节点，当前 HTML 和活跃 JS 模板没有匹配的完整选择器。
- 动态波形/history-item/toast 的生成者分别是 H04/H03，无实际入口。
- 当前播放器采用 `.custom-player/.player-btn-toggle/.player-progress-*`，会话侧栏采用 `.conversation-sidebar/.drawer-backdrop`，不能用名称前缀相似推断匹配。

建议：删两个 CSS 文件和两条 import。风险：低；仍需验证当前播放器、侧栏和亮暗主题。208 + 520 + 2 = 730 物理行；CSS 文件本身 629 非空行。

### H06 `frontend/layout.css:24–575` 及旧布局响应式规则

类型：废弃样式。

证据：

- `.app-layout/.main-area/.workspace/.work-left/.work-right/.workspace-seam/.control-*/.text-input/.generate-btn/.sample-chip/.sync-status/.work-reading-banner/.error-alert` 无当前活跃 DOM。
- 当前 `#errorAlert` 的 class 是 `.chat-notice`，不匹配 `.error-alert`；旧动画只由旧布局引用。
- 无匹配响应式块另在 947–964、972–974；必须保留外层 media 花括号及活跃 body/modal 规则。
- 设置弹窗从 577 行已经开始，不是“前 700 行都可删”。6–22 的 reset/body、577–939 的 modal 及后部 modal 响应式仍被使用。

建议：精确删除上述无匹配范围，保留设置样式；不要求先建立新文件。风险：低至中，需浏览器计算样式/布局回归。573 行候选，不是整文件 990 行。

### H07 `frontend/copilot.css` 的旧控件规则

类型：废弃样式。

证据：

- 无匹配范围：5–139、389–391、408–452、455–551、585–587，共 283 行。
- 旧 `.explain-section/.explain-header/.explain-controls/.explain-select/.toggle-*`、空态插画、action-card、旧聊天按钮、`.suggest-sep` 无当前节点/生成者。
- 当前重试按钮 ID 虽叫 `explainRetryBtn`，class 是 `.ai-retry-btn`；不会匹配旧 `.explain-retry-btn`。
- 文件剩余气泡 border、max-width、对齐及文本样式仍参与继承，不能整删。

建议：仅删除无匹配范围。风险：低至中，回归气泡、空态、建议按钮及弹层。283 行。

### H08 `frontend/theme.css:81–83/:132–208`

类型：废弃动效/状态。

证据：`.ambient-fields/.ambient-field-*` 没有静态节点或动态生成者，`is-fusing` 没有写入路径；活跃背景与 theme body 伪元素另有实现。

建议：删这些旧规则，保留 theme tokens 和活跃背景。风险：低。80 行。

### H09 当前模块中的零调用函数

类型：Dead Code。逐符号核对静态导入、动态 import、HTML inline handler、测试及事件回调，以下均无消费者：

| 符号 | 定义范围 | 替代/删除影响 |
|---|---|---|
| `settings.js:setSelectedEngine` | 79–85 | 真实 select change listener 写入状态，app 只读取选择值 |
| `settings.js:setSelectedVoice` | 87–91 | 同上，保留实际 voice change 逻辑 |
| `settings.js:hasApiKey` | 288–291 | app 使用 `getApiKey`；只删闲置 getter |
| `copilot.js:isExplainEnabled` | 65–67 | 实际状态仍被 request/toggle 消费，不能删状态 |
| `sidebar-resizer.js:getSidebarWidth` | 40–42 | 拖动/键盘/持久化入口仍有效，测试读取 CSS 属性 |

建议：删除这五个函数，保留内部实际状态与事件。风险：低，公开 ES module 导出会变化。22 行。

### H10 `frontend/copilot.js:221:openExplainSection`

类型：无意义抽象 / 空操作。

证据：221–223 函数体只有注释；618、686 的两次调用不产生行为，真正可见性由 `app.js:299:syncPanels` 管理。

建议：删函数及两次调用。风险：低。5 行。

### H11 无作用的前端状态、DOM 与分支

类型：无用状态 / 不可达分支 / 重复节点。每项分别核查了全部调用和动态节点：

| 定义位置 | 证据与建议 | 整行候选 |
|---|---|---:|
| `settings.js:156–159:historyRetention` | DOM 和所有模板均无该 ID，条件体无法执行；删查询与提示更新，保留 storage_mode | 4 |
| `copilot.js:62/:903–910:onActionTrigger` | app 调 `initCopilot()` 不传 callback；当前空态无 `.explain-action-card`；输入转义也不能产生该节点；删失效委托及专属 callback，保留建议 chip | 9 |
| `copilot.js:458–462:cancelExplainReveal(complete)` | 全部调用均不传参，默认 false；删 complete 分支/参数及只供该分支读取的 generation 属性，保留取消功能 | 5 |
| `copilot.js:269:staggerIndex` | 六处只写 `--stagger`，全仓无 CSS var/JS 读取；删计数器和六处行内 style | 1 |
| `message-player.js:33–37/:214:this.download`、`chat.css:105` | 锚始终 hidden 且 CSS display:none，无显示/点击路径；可见 `.player-download-link`/customDownload 已提供实际下载；删重复隐藏锚及 append/href 边 | 7 |
| `api.js:113–116:onApiKeyMissing` | `app.js:260`、`message-player.js:188` 均只传 response，没有任何回调提供方；删回调分支/options，保留错误本身 | 4 |
| `chat.css:145:.ai-options` | 只有带完整后缀的 row/grid/popover 类；单独 `.ai-options` 无匹配 | 1 |

风险：低；涉及公开回调/参数时同步确认调用边。本表共 31 整行，行内精简不额外折算。

### H12 `src/app/schemas/tts.py:50:ErrorResponse`

类型：Dead Code / 无用 Schema。

证据：只定义 `detail`，全仓无导入、response_model、实例化或导出注册。FastAPI 不会自动使用目录中的所有模型；当前错误处理直接返回 JSONResponse，OpenAPI 验证错误模型由框架生成。

建议：删这个类，保留实际异常处理与错误 JSON 合同。风险：低。2 行。

### H13 `src/app/config.py:128–129` 私有生产模式检查

类型：不可达分支 / 重复校验。

证据：该条件必然蕴含 126 行条件；相同 production 且 auth 非 trusted_proxy 的状态已在 127 行抛错，没有路径能到达第二次 raise。通过 Settings 修改配置再构造也改变不了条件蕴含关系。

建议：删除第二个重复检查，保留前一个生产认证约束。风险：低。2 行。

### H14 `src/app/services/explain_service.py:26:_normalize_client_id`

类型：无意义抽象，属于活跃薄包装，不是 Dead Code。

证据：253、271、337、398、434 共五个调用；函数仅转发到 `validation.normalize_client_id`，不增加转换、异常合同或状态，未发现对它的 patch/扩展注册。

建议：五处改为直接调用 canonical 函数，删包装定义。风险：低。2 整行；调用行只替换名字。

### H15 `src/app/services/cache_service.py:236:delete_audio_caches`

类型：Dead Code。

证据：236–238 只有定义，无生产/测试/CLI 消费；实际缓存淘汰使用 `_delete`。单项 `delete_audio_cache:231` 仍被测试使用。

建议：仅删除批量门面。风险：低。3 行。

### H16 未消费 logger、导入与测试清理

类型：无用变量 / 重复清理。

| 位置 | 证据 | 整行候选 |
|---|---|---:|
| `tts_service.py:3/:22`、`gemini_engine.py:3/:11` | logger 全文无消费，logging 导入仅服务它 | 4 |
| `tests/test_cache_flow.py:1–2` | json/hashlib 无使用 | 2 |
| `tests/test_cache_flow.py:21–22/:25–26` | 前一行 delete_audio_cache 已经经 `_delete:65–66` pop 两份 LRU；随后四次 pop 重复 | 4 |
| `tests/test_release.py:22` | EdgeTTSEngine 导入无使用，实际测试 patch Communicate | 1 |

建议：删除这些明确无效整行。风险：低。11 行；不删除 fixture、缓存清理或真实测试执行。

### H17 浏览器测试里的失效 fixture/状态

类型：临时代码 / 无用变量。

| 位置 | 证据与删除边界 | 整行候选 |
|---|---|---:|
| `test_async_state.cjs:21–25/:115/:118/:132–133` | wav、暴露 keys/wav、manifest、旧 replay/check helper 无读取/调用；保留用于历史 fixture 的顶层 keys | 9 |
| `test_chat.cjs:57:failures` | 只声明；实际由外层 catch 报失败 | 1 |
| `test_theme_and_sidebar.cjs:17/:47` | explainRequestCount 声明/递增后无断言或读取 | 2 |
| `test_theme_and_sidebar.cjs:38–45` | 没有生成操作，初始化也不取 flow/audio/test-audio；当前生成入口用 POST /api/tts | 8 |
| `test_frontend.cjs:22/:48–51` | historyDeleted 和 DELETE /api/history/1 fixture 无消费；当前删除本地会话不删服务器历史；42 行条件简化成直接数组 | 5 |

共 25 整行；与 H16 release 导入合计脚本/部署测试域 26 行。另有行内清理：async_state 的 window.app/window.player（113–114）、keys.C（18）、永不选择的 edit action（183）；chat 的 keys.C（18）、scrollId/beforeScroll（203）；app.js 的 getEngineLabel/sendExplainChat 导入；test_edge_timeline.py 的 SentenceCue；release.py 的未用 TTSUpstreamError 导入、monkeypatch 参数和结果变量。移除 `results` 绑定时仍须执行并等待 `list(pool.map(...))`，不能连同操作删除。共享 SDK fixture 的 requests 记录在其他测试中被断言，不能整体删。

风险：低；保留每个脚本的真实断言。以上局部项未计整行收益。

## 2. 疑似冗余，需要进一步确认

### S01 `api/explain.py:38:_generation_parts`

第二轮状态：已将所有相关测试模拟迁为实际四元组并删除垫片，见第 8 节。以下保留原审计依据。

主实现 `generate_explanation_text/generate_chat_answer → gateway.complete` 返回 `(LLMResult, model_id, mode_id, revision)`，字符串分支不被当前 provider 路径使用。但 `tests/test_explain.py:21–22` 仍以 explained/answer 字符串 mock，并通过该分支完成跨 context_id 的追问隔离验证。注释还提到 legacy extensions，仓库不能证明外部扩展不存在。

建议先把需要保留的测试 mock 改成规范 tuple，确认没有旧扩展合同，再删函数及两处调用/LLMResult 导入。风险：中；不能直接删现有测试或说完全零调用。当前函数 6 行，并非与薄包装合计必然省 40 行。

### S02 `llm/gateway.py:18:get_catalog` 与 `llm/__init__.py` 导出门面

第二轮状态：已改为 registry 函数的导入别名，保留 gateway/package 的公开调用名并移除包装函数，见第 8 节。

函数只转发 registry.catalog，但 main.readiness_check、api.copilot_models 实际调用它，包还重导出此符号。gateway 同时承担 complete 的应用边界，保留统一入口可能有模块边界价值。

可删除函数并改为 canonical import，或保留门面而避免额外函数帧；缺少的是明确的公共模块接口策略。风险：低至中。不删除整个 gateway，也不把只出现于 __all__ 的公共 API 自动当死代码。

### S03 `copilot.js:657–699:loadExplanationForReplay`

第二轮状态：会话竞态测试已迁至当前前端 POST 链路，旧前端 helper 已删除；后端 GET API 保留，见第 8 节。

生产 app 没有调用，当前 bindAI 使用 POST requestExplanation；但 CI 的 `test_async_state.cjs:200/:207/:216` 多次直接调用旧 GET helper，覆盖会话替换、旧聊天 finally、晚返回 404/network 的状态隔离。

GET 只读已有解释，POST 可能计费生成，不能声称等价。先把适用于当前界面的竞态断言迁到生产链路，再决定删除 helper 和专属旧回放用例。43 行，风险：中。后端 GET /api/explain 是已注册公共 API，前端不调用不足以删 API。

### S04 `index.html:56:explainRetryBtn` 隐藏测试挂钩

第二轮状态：隐藏节点/绑定/专属样式已移除，改为检验实际输入禁用与可见重试，见第 8 节。

按钮永久 display:none/aria-hidden/tabindex=-1，没有显示路径；copilot 仍绑定它，`test_chat.cjs:194` 还断言它的 disabled。可见重试入口存在于动态空态和气泡。

先改为断言可见重试控件，再清理 HTML/绑定/样式，估计约 15 行。风险：中；不可把真实重试能力联删。

### S05 legacy 存储、旧迁移及清理 CLI（严格待确认项）

本节按清理后的工作树再次核验，以下行号为当前行号，区别于其他小节保留的基线行号。

`TTS_STORAGE_MODE` 在 `src/app/config.py:99`、`.env.example:67`、`docker-compose.yml:56` 中均默认仍为 `legacy`。组合根 `tts_storage.py:69–78` 根据该配置返回 `LegacyTTSStorage`；应用启动初始化和 TTS/历史路由均使用这条组合链。因此，**旧实现是仓库默认配置下的活跃运行时路径，不能按死代码删除**。未读取实际部署环境，不能据此断言生产当前使用哪种模式；`APP_ENV` 的仓库默认值也是 `development`。

新链路与私有存储结构：

- 业务适配层：通过 `src/app/services/private_tts_adapter.py` 暴露符合 `TTSStorage` Protocol 的 `PrivateTTSStorage`，接口包括 `prepare/get/save/record_hit/replay`、历史操作与初始化；公共契约使用 `record_hit`，适配器内部才调用存储引擎的 `touch`；
- 存储实现层：`src/app/services/private_tts_storage.py`（`PrivateTTSStore`）；
- 物理存储：采用按 owner hash 分隔的二级安全目录结构（`{root}/{owner_hash[:2]}/{owner_hash}/{key}.mp3`）；
- 持久化结构：基于 **`tts_audio_assets`**（元数据、SHA256、状态、`timeline_json`）与 **`tts_history_v2`**（播放历史）两张表的外键级联关联。

退役意图与退出门禁（Exit Gate）：

`legacy_tts_storage.py` 头部注释（`Temporary compatibility adapter; remove after the private rollout exit gate.`）仅说明退役意图，不能证明退出条件已经满足。仓库未提供集中检查全部退役条件的自动门禁。以下区分现有代码约束与建议的退役验收项：

1. **可信身份代理验收**：`config.py:121–126` 要求 trusted_proxy 模式的密钥不少于 32 字符，且所有 production 配置必须使用 `COPILOT_AUTH_MODE=trusted_proxy`，并非只针对 Private 模式。Private 请求实际经 `dependencies.py:18–45` 的 `require_tts_identity → trusted_identity` 校验代理密钥和身份，开发环境同样不回退浏览器 client ID。这些是代码约束；代理拓扑、剥离外部伪造身份头及注入行为仍需部署验收，代码不能证明其已完成。当前 `config.py:128–129` 是 Redis/其他生产配置校验，不是私有存储专属鉴权 guard；
2. **旧资产与历史数据处置决策**：建议在退役前明确 `history` 表与 `cache/audio/` 的迁移、归档或淘汰策略，并验收历史访问结果；未发现自动把旧资产迁移到 private 的实现；
3. **回滚机制与应急预案**：建议明确回滚窗口、身份/键/数据的兼容安排并演练。现有代码没有“Private 失败后自动平滑回退 Legacy”的机制；更改模式本身不解决两种数据合同的差异；
4. **清理工具与运维闭环**：`scripts/clear_legacy_tts.py` 与 `tests/test_legacy_tts_cleanup.py` 提供默认只读盘点、限定路径清理及直接测试。CLI 执行 `--apply` 必须同时传入 `--proxy-verified`、`--service-stopped`，但这两个参数只是操作者声明，不会自动检测代理验收或服务是否停机；直接 Python 调用 `cleanup(..., apply=True)` 也不经过 CLI 参数门禁。最终清理时机需要由迁移验收和回滚窗口决定，不能把参数传入当作全部退出条件的达成证据。

基础设施共享边界：

`history_service.py` 不能随 Legacy 整文件删除。除旧 `history` 表读写外，还有以下共享调用：

- 为 AI 讲解服务（`explain_service.py:11/:30/:31`）提供连接管理（`connect_database`）与数据库初始化（`init_db`）；WAL 模式由初始化过程建立，不是每次 connect 都重新启用；
- 为私有存储（`private_tts_storage.py:21/:460`）提供时区感知的时间戳函数（`utc_timestamp`、`absolute_history_row`）及共享数据库路径 `DB_PATH`。

代码行数精确统计：

按物理行计数（包括文件内空行，末尾换行不另计空行），`legacy_tts_storage.py` 为 77 行，`cache_service.py` 为 233 行，**两文件合计 310 行**。另计清理脚本 63 行、专属测试 44 行则为 417 行。“约 355 行”的来源不能从当前文件计数证实，也不能推断它具体混入了哪些文件。310 是现存两文件的体量，不是已可删除量或最终净收益；退役还需更新调用、配置、测试，并保留共享基础设施。该区域继续列为 **S05 待确认项**。

### S06 `history_service.py:105–129`、`explain_service.py:_get_conn` 的旧数据库迁移

history_migration、explanations 的 gemini-legacy 默认值/ALTER 分支确有旧版本兼容职责，并有迁移/回滚测试（test_release.py:418/:431 等）。本轮没有读取用户数据库，不能用“版本较新”推断旧库已不存在。

需明确最低支持升级版本并盘点实际库，再决定移到离线迁移工具或移除。风险：高，涉及持久化数据与升级合同。旧 DEFAULT 值不代表当前 provider 仍使用 Gemini 文本模型。

### S07 `TTSUpstreamError.detail` 与 private 的 `format` 列

- errors.py:82–85 的 detail 参数只赋 self.detail，全仓无读取；main 只消费 status_code/type。可删属性和第二参数，但要更新所有异常构造及确认外部 Python 契约；不能删除 HTTP JSON 的 detail 字段。风险：低至中。
- private_tts_storage.py:91/:98–100 的 format 列仅 default mp3，没有业务读/过滤/显式写入；get 返回整行字典，adapter._asset:29 没有消费它。事实是字段未被当前业务使用，删除旧库列仍需迁移决策。建议停止增加无用字段，已有列保留，无需为了几行代码 DROP COLUMN。风险：中。

### S08 无消费者回调和来源字段

第二轮状态：三个无消费者回调及专属调用已移除；持久化 `legacyHistoryId` 来源字段继续保留，见第 8 节。

settings 的 engine/voice callback 当前 initializer 只传 onLimitsLoaded；copilot 的 onStateChange 当前 initializer 不传 callback，调用始终落到 no-op。可缩减扩展接口，但应确认模块接口策略；保留 onLimitsLoaded 和实际事件。

conversations.js:88 的 legacyHistoryId 仅写入持久化会话，无读取；可能是来源追踪约定。可以停止写入，但不要为删一个字段强制重写用户 localStorage。风险：低至中。

### S09 `requirements.txt`、版本号与过期文档

requirements.txt 未被 Docker/CI 的安装链使用，但仍是手动安装入口，不能零引用即判死。它遗漏 pyproject 中的 redis、audioop-lts、urllib3 安全下限，存在依赖清单漂移；建议确认是否继续维护 pip 安装，再生成同步清单或明确废弃。

pyproject.toml 版本 0.1.0，FastAPI/README 为 0.2.0；这是元数据不一致，不是无用变量。配置中 src/.env 与 load_dotenv 自动查找也有真实 fallback，不因只有根 .env.example 就删。

过期/错链：COPILOT_DEPLOYMENT.md:20、STABLE_RELEASE.md:9/:16 仍指 backend/.env；STABLE_RELEASE.md:3 说 Redis 不必需，与生产 config 要求冲突，:21–22 的讲解时限和 Gemini 共享 pool 也属于旧链路；DEVELOPMENT.md:13/:29–42/:75–81 仍描述原生播放器、WAV 和已实现的未来计划，:83 相对链接失效；SENTENCE_AUTO_FLOW_IMPLEMENTATION.md 大量 backend 路径/旧 app 状态和“待实现”说明已过时。建议标明历史设计/适用版本并修当前操作指南，不必删整个历史文档。RELEASE_AUDIT.md 明确有旧基线和日期，应作为历史记录，不将当年“不用 Redis”当作当前事实。

### S10 未在当前网页使用的 flow HTTP API

app.js:258 实际用 POST /api/tts；flow POST/GET 仍注册、被 backend/API tests 使用，提供独立时间轴合同。既没有外部使用盘点，也没有公共 API 退役声明，不能把“新前端不调用”扩大成整个后端时间轴功能废弃。风险：中至高。

## 3. 重复实现

以下 11 组按实际职责归类。它们均有活跃消费者；重复不等于可以删掉任意一条调用链，范围长度也不等于净减少量。

### D01 可信代理身份验证

第二轮状态：已复用公共校验并保留两条 FastAPI 依赖；新增短密钥回归及完整身份边界用例，见第 8 节。

位置：dependencies.py:30–38 trusted_identity；:61–68 require_copilot_identity。

重复 secret 编码、常量时间比较、身份 trim/control-character 检查及 copilot 前缀 SHA256。前者额外拒绝 expected 长度 <32，401 文案不同。建议以保留更严格短密钥检查的公共 helper 为最终实现，文案参数化，两个 FastAPI 依赖保留。需覆盖短密钥、缺身份、非法字符、production 和 private development。属于认证边界，风险中至高；没有证据支持净省约 35 行。

### D02 LLM 使用量序列化与 SQL upsert

位置：explain_service.py:338–340/:366–379 save_explanation；:435–450 record_usage。

四项 token 归一化和 daily ledger upsert 高度重复。最终实现可提取接受现有 conn 的内部记账函数；save_explanation 必须保持和解释写入/预留删除处于同一事务，chat 的独立计费顺序也需保留。不能直接在事务内调用自行打开连接的 record_usage。风险中。

### D03 TTS/LLM 排队及总时限

位置：runtime.py:46–65 upstream_slot；:68–87 llm_upstream_slot；:28–34/:37–43 deadline。

两套 pending/semaphore/acquire/timeout/finally 算法重复；差异是命名空间、limit 来源、queue/whole deadline 和 TTS/LLM 异常类型。建议共享参数化内部算法，保留语义门面及取消后的释放行为。嵌套 deadline 分别保护整体锁/存储与直接引擎/provider 调用，不能把内层简单视为无效。风险中至高。

### D04 普通/flow legacy 哈希编码

位置：cache_service.py:30–35 compute_cache_key；:37–42 compute_flow_cache_key。

JSON 编码/SHA256/16 位截断相同，域前缀 audio-v3 与 sentence-flow-v3 不同。Legacy.prepare 动态选择，两种键都有实际测试。可共享 helper，保留字节编码和域分离，不能改成同键。private 完整键不应强行合并为相同协议。风险中，影响已有缓存定位。

### D05 TTSService → 模块函数 → Engine

位置：tts_service.py:31–70 generate；:109–125 synthesize；:128–146 synthesize_with_timeline。

generate 已 get_engine，模块函数又重复查询/能力检查。可由 service 使用已解析的实例调用，替代两个活跃门面。现有 test_api/test_release patch 模块函数，需迁移到 engine mock；test_tts_service/private API 已采用引擎级 mock。不是零调用，约 36 行现有范围，净收益需扣除新调用逻辑。风险中。

### D06 模型与模式重复解析

位置：api/explain.py:74；explain_service.py:127 build_explain_key、:229 generate_explanation_text；gateway.py:9–13 complete。

一次 explain 请求多次解析相同 profile/mode；前端选择、key 构造、提示词与 provider 都要一致。可传递已解析的选择对象，避免重复构建 profiles；但 resolve_selection 将 LLMConfigError 转 ValueError供 API 422，gateway/provider 仍需要配置错误合同。不能无差别删所有校验。风险中。

### D07 当前会话时间戳格式化

位置：app.js:50–61 formatTimestamp；:63–75 formatFullTimestamp。

共同 date 校验/pad/年月日时分，后者额外秒数，分别用于会话可见时间和 tooltip。可参数化 formatter，估计净减约 10–11 行，保留秒数差异。conversations.js 没有 formatter；后端 utc_timestamp 生成绝对时间，history_timestamp 将老本地时间解析为绝对时间，并不与前端展示等价。风险低至中。

### D08 八套浏览器 harness 基础设施

第二轮状态：八套脚本的浏览器/CDP 生命周期已提取为共享 helper，业务断言及特有 fixture/等待保留，见第 8 节。

位置：test_frontend、test_theme_and_sidebar、test_async_state、test_chat、test_copilot_send_fix、test_explain_popover、test_sidebar_new_features、test_sidebar_resizer，共 2083 行现有脚本。

重复 Chrome 路径探测、临时 profile、HTTP fixture 服务器、DevToolsActivePort 等待、CDP WebSocket pending map、send/evaluate/wait 和清理。建议提取共享 harness，保留各套断言和 fixture 差异。异常采集、awaitPromise、Browser.close/退出等待、清理重试并非完全一致，统一前需确认。

四个未接 CI 脚本合计 1133 物理行/998 非空行，具有如下独有覆盖，不能直接删：

| 脚本 | 独有现行断言示例 |
|---|---|
| test_copilot_send_fix.cjs | MouseEvent 不进入请求 message、建议 chip 立即发送、忙时禁用、失败重试不重复用户气泡 |
| test_explain_popover.cjs | 弹层 ARIA、外部点击/ESC/关闭、亮暗截图 |
| test_sidebar_new_features.cjs | 空会话复用/标题截断、卡片音色与字数、自定义播放器倍速、悬停时间戳 |
| test_sidebar_resizer.cjs | 双侧拖动上下限、双击重置、键盘、持久化、手机隐藏 |

最终实现应是共享基础设施 + 保留特性断言，而不是以“未进 CI”为删除依据。风险中。

### D09 样式覆盖与主题 token 重复

位置：theme.css:19–40/:43–67；copilot.css 剩余 bubble/actions 与 chat.css。

确有后置重写和 light 默认 token 重复，但主题属性在 html/body 和预览按钮上形成不同变量作用域，旧 bubble 的 border/max-width 也未必被覆盖。除 H06–H08 已证明无匹配规则外，合并需要计算样式验证，不能把整个旧 CSS 都当覆盖无效。风险中。

### D10 AI 目标切换的重复重置流程

位置：app.js:205–209 resetExplanation → setCurrentExplainText → renderExplainEmpty。

reset 已经过 clear/invalidate/render，setter 又 invalidate，之后再 render。可用一次目标更新和空态渲染实现，但 generation 增量和 callback 次数会变，需要竞态/reveal 测试确认。公共 reset 在 CI 直接使用，不整删。风险中。

### D11 文本 Unicode/空白校验

位置：validation.py:16–24 validate_text；schemas/explain.py:68–76 ChatRequest.validate_non_empty。

两处 trim/空白/UTF-8 编码检查相似，但普通文本使用可配置 1–1000，聊天有 500 上限，错误文案不同。可提取 Unicode 约束内部 helper，保留各请求长度合同；TTSRequest 和 ExplainRequest 调相同 validate_text 的装饰器本身是有效框架边界，不因短包装就删。收益小，风险低至中。

### 看似重复但应保留的结构

- TTSStorage Protocol、两适配器、TTSService 的 history 方法是 DI/线程池边界，test_tts_api_service 在 legacy 配置下注入 private 验证接口遵守存储，具有实际价值。
- SentenceCue/TimedSynthesisResult、AudioAsset/TTSResult、SentenceCueResponse/TTSFlowResponse 分别描述引擎结果、存储/业务结果、HTTP 输出，不是几份可互删 DTO。ChatMessage 过滤输出元数据，但存储的 model_id/mode_id 被 chat 去重读取，不是无用字段。
- TTS replay 16/64、解释 key 16/64、legacy 16、private 64 的校验表达式属于不同边界/历史合同。文本相同不证明同一概念；TTS legacy 退役也不能自动取消旧解释 key 支持。
- check_frontend.cjs 检查实际前端；test_frontend_syntax.cjs 测试检查器的递归/失败行为；test_conversations.cjs 是存储单元测试，均不等价于浏览器测试。
- RequestLimits 的全局/IP 速率、LLM weighted Redis quota、provider queue、cache_lock/distributed lock/SQLite reservation 保护不同资源，不能按“都是限流/锁”合并删除。

## 4. 历史架构残留

Git 历史可证实的变化：2005770 引入同步阅读工作台；591759b 引入多模型 LLM gateway；e3928f3 同时引入 src 布局、会话界面及 private 存储相关实现。不能把逻辑上的五个模块变化写成已经证实先后独立发生的五次重构，尤其旧 player/history 模块拆分与 private 实现都出现在最新提交。

```text
旧工作台前端（已失去页面入口）
  index/app → 单播放器 + 历史抽屉/句子同步 UI
       ↓
当前会话前端
  index → app → ConversationStore（本地文本与参数）
                MessagePlayer（每消息音频）
                Copilot（最新消息 context_id）
                settings / sidebar-resizer / api

当前 TTS 共用业务链
  FastAPI Router → Depends(TTSService) → Engine registry → Edge/Gemini
                        ↓
                 TTSStorage Protocol
                   ├─ 默认 legacy → LegacyTTSStorage
                   │                  ├─ cache_service（16 位、共享、TTL）
                   │                  └─ history_service（SQLite history）
                   └─ 可选 private → PrivateTTSStorage adapter
                                      → PrivateTTSStore
                                      → private_audio/<owner>/<64位>.mp3
                                        tts_audio_assets + tts_history_v2

当前 LLM
  Explain/Chat Router → 锁/存储预留/额度 → explain_service 提示词
                    → gateway → registry/preset → httpx provider
                    → explanations + daily ledger（共用 history 数据库连接）
```

legacy 与 private 的资产合同不同：legacy 普通/flow 两个 key、TTL、删除历史不删共享音频；private 普通/flow 共用资产、owner 隔离、ready/unavailable/deleting、删除/驱逐联动历史、无 TTL。测试明确覆盖差异，Private 不是可在未迁移身份/数据前直接替换默认模式的实现。

另外有旧导出链 `errors → gemini_engine → engines/__init__ → tts_service`，以及 SentenceCue 的兼容导出。可统一从 errors/base canonical 模块导入并迁移测试，不能删异常类型定义。gemini_client 的 managed_client/retry 关闭有真实 SDK mock 验证，具有资源关闭职责，应保留。

旧模块、迁移代码和历史文档均已分项列出；未发现成片被注释掉的可执行旧实现、未使用 worker/cron/webhook 入口、或仅由废弃 provider 引用的一整套后端服务。代码示例中的 TODO/规划并非运行配置：SENTENCE_FLOW_ENABLED 只在旧设计文档提出，没有实现，不能算一个仍在 Settings 中的死 flag。

## 5. 无用依赖

### `pydub>=0.25.1` 与 `audioop-lts>=0.2.1`

类型：高置信无用直接依赖候选。

证据：

- pyproject.toml:14–15 直接声明，requirements.txt:7 还声明 pydub；全源码/测试/脚本没有 pydub/audioop import、动态加载、CLI 或配置插件入口。
- 当前转码明确使用 ffmpeg 子进程，标准库 base64/bytes 处理 PCM；原报告所谓 struct 解析并不存在。
- 完整 uv.lock 反向依赖图中，两包只有根项目引用，没有其他 locked package 依赖它们。audioop-lts 的实际安装/可用性不构成本项目使用它的证据。

建议：删三处声明并重新生成 uv.lock、重新安装/测试。审计阶段未修改依赖、未验证删除后的新环境；实施结果见第 7 节。不要只手改 lock 的部分 wheel 行。依赖声明与锁文件不纳入业务代码删除收益。

### 应保留/另需确认的依赖

| 依赖 | 使用证据/处置 |
|---|---|
| fastapi、pydantic | 路由、模型及框架生命周期 |
| uvicorn[standard] | Docker/start/文档 CLI，额外模块可由服务器自动使用 |
| httpx | 当前 LLM provider、SDK mock、API 集成测试 |
| python-dotenv | config 启动加载 |
| google-genai | Gemini SDK client，与旧 Gemini 文本配置无关 |
| edge-tts | Edge 引擎；其 aiohttp 是被 errors.py 实际使用的传递依赖，可考虑声明直接依赖，不能删 |
| cachetools | legacy 两份 LRU；默认 legacy 仍用，private 也有内存资产管理 |
| redis | quota.py 函数内延迟 import，生产额度/锁必需，不能只查顶层 import |
| urllib3 | 无源码直接 import，但根声明用于 requests/google-genai 的传递依赖版本下限，uv.lock 有 requests → urllib3；不是死依赖 |
| pytest | dev dependency，自动收集全套 backend tests |
| ffmpeg（系统包） | 活跃 MP3 转码和真实转换回归测试 |
| curl（Docker 系统包） | 仓库无直接 curl 命令，但远程 uv installer 内部可能消费；未读取外部安装器，不能确定删包安全 |

未核验外部模型/服务地址当前可用性，不把供应商固定 URL 或默认禁用但可配置的 GLM profile 判为过期服务。GLM flag 和各 provider key/concurrency/region 的读取均真实存在。

## 6. 最值得优先清理的区域

以下保留删除前的候选优先级，不是当前待办清单；最终逐项状态见第 8 节。按收益/风险排序，P0 表示清理优先级，不表示线上故障级别。物理行包括块内注释/空白；零散项只数整行，行内替换不折算；整文件及其内部函数不重复累加。

| 优先级 | 位置 | 问题 | 预计整行候选 | 风险/前置条件 |
|---|---|---|---:|---|
| P0 | 旧 player/history JS/CSS + style imports | 四文件无页面入口/样式无匹配 | 1534 | 低；同步移除 CI 无效 player 动态导入 |
| P0 | 闲置 WAV 与专属测试 | 无业务调用 | 35 | 低；移除导出/导入，保留 MP3 合同 |
| P0 | 死配置、ErrorResponse、重复生产 guard、私有 normalize 包装 | 明确无消费/可达性/透传证据 | 9 | 低；改五处 normalize 调用 |
| P1 | layout/copilot/theme 旧样式范围 | 无当前节点/状态 | 936 | 低至中；仅删精确范围，浏览器布局和主题回归 |
| P1 | 前端闲置函数/状态/隐藏重复锚 | 小型死逻辑 | 58 | 低；保留可见下载/建议按钮/取消状态 |
| P1 | backend 小型无用代码与测试 fixture | 批量删除门面/logger/import/重复清理/fixture | 39 | 低；保留所有真实断言 |
| P1 | pydub/audioop-lts | 未消费直接依赖 | 2 个依赖；不计代码量 | 低；重新锁定依赖与环境测试 |
| P2 | runtime/usage SQL/model selection/TTS 门面/browser harness | 活跃重复实现 | 未估净值 | 中；共享算法保留各合同和独有断言 |
| P2 | generation string compatibility/GET replay/隐藏 retry | 测试或扩展合同依赖 | 未计安全删除量 | 中；先迁移仍适用测试，确认接口策略 |
| P3 | legacy 存储退役、数据库迁移 | 有效过渡机制 | 未计安全删除量 | 高；生产/数据/身份/回滚门禁 |

上述可定位整行候选合计约 **2611 行**（约 2.6k）；这是静态候选清单，含需要联动删导入/更新调用和后续 UI 验证的项，不是本轮已经删除的代码。汇总为前端 2528、TTS/关联测试 48、脚本/部署测试 26、根/API/讲解项 9；与矩阵分组互不重计。依赖声明、lock、文档修订、待确认字段/分支和活跃重复合并收益另计。

### 项目冗余概况

- 高置信整文件删除候选：**4 个**，即 player.js/history.js/player.css/history.css；另四个未接 CI 脚本不计。
- 高置信可清理函数/类：**44 个**，其中旧两 JS 文件顶层函数 33 个、单独生产函数 9 个、未用 Schema 类 1 个、专属单测函数 1 个。模块删除与函数数是两个指标，不重复计算行数；活跃 normalize 包装需先改调用。匿名事件 callback 不在此符号计数中。
- 过期运行配置：确认 **1 项** GEMINI_TEXT_MODEL；另有 **1 个**被前置检查完全覆盖的配置分支。
- 重复实现组：**11 组**，其中多数属于活跃逻辑的合并候选，不是直接删除清单。
- 历史残留：旧前端四文件已失去入口；legacy 适配器/cache 两模块仍活跃；离线清理 CLI+测试两文件仍有效。另有讲解字符串兼容、导出兼容、数据库迁移及过期文档，分别详列，不能混成“全都废弃”。
- 预计整行候选：约 **2611 行**；80 个源码/前端/脚本/测试文件合计 16,422 行，按这个明确分母约 **15.9%**；不能宣称“约3450/20%–25%”。待确认重构与存储退役没有可靠的额外净节省估算。
- 风险最高：可信代理身份验证、持久化数据/旧库升级与 legacy 退役、额度/锁/事务合并、Copilot 竞态代次、CSS 变量继承与弹窗保留范围。

### 删除前的基线验证与限制

| 命令 | 实际结果 |
|---|---|
| `uv run pytest -q --tb=short` | **281 passed，2 warnings，26.14s，退出码 0** |
| `node scripts/test_frontend_syntax.cjs` | 3 项检查器行为验证通过，退出码 0 |
| `node scripts/check_frontend.cjs` | 全部 9 个 JS 模块语法通过，退出码 0 |
| `node scripts/test_conversations.cjs` | 持久化/隔离/参数快照/恢复/迁移/存储错误三组通过，退出码 0 |

pytest 两条 warning 来自 google-genai 类型和 Starlette TestClient 弃用；没有为它们升级依赖。初次 uv 因沙箱缓存访问失败，随后经批准在沙箱外完成测试。测试使用 mock，不调用真实 TTS/LLM。

审计阶段未运行八套浏览器回归、Docker build/启动、外部 provider、实际身份代理或生产迁移。test_chat.cjs 与 test_explain_popover.cjs 会覆盖 tracked screenshots，审计阶段没有执行。上表只证明删除前的基线；删除后的验证另列于第 7 节。

### 审计范围之外的已确认流程问题

start.bat:15/:17 使用相对 `--app-dir src`，stop.bat:24 调用的 verify_tts_process.ps1:23 拒绝相对路径，因此默认 start→stop 工作流不能被 verifier 认可；CHAT_INTERFACE.md:51 已记录限制。Verifier 是避免误杀的实际保护，不是无意义抽象。后续可把启动参数统一成项目 src 绝对路径并加组合测试；本轮不修复、不计冗余收益。

## 7. 第一轮已授权清理的实施结果

第一轮实施范围为 H01–H17 与第 5 节的 `pydub/audioop-lts`，当时没有扩展疑似项或合并鉴权。以下记录该阶段结束时的结果；追加授权后的精简另见第 8 节。审查阶段结束时，两轮修改尚未提交或推送。

| 审计项 | 实际处置 |
|---|---|
| H01 | 删除 `pcm_to_wav`、导入/导出与专属 `test_pcm_to_wav`；保留实际 MP3/ffmpeg 路径 |
| H02 | 同步删除 Settings、`.env.example`、Compose 中的 `GEMINI_TEXT_MODEL` |
| H03–H05 | 删除 `history.js/player.js/history.css/player.css`，移除 CSS 导入和测试中的旧播放器动态导入 |
| H06–H08 | 精确删除无匹配旧布局/Copilot/ambient 规则，保留全局 reset、设置弹窗、消息气泡及继承样式 |
| H09–H11 | 删除闲置导出、空操作及调用、失效回调/状态/分支、隐藏下载锚与无消费的 stagger；取消动画和可见音频下载仍保留 |
| H12–H15 | 删除未注册 Schema、不可达重复校验、闲置批量缓存门面；五处直接调用标准 client ID 校验函数 |
| H16 | 清理无用 logger/import、重复缓存 pop 及未消费的测试绑定；保留实际并发迭代执行与所有其他行为断言 |
| H17 | 清理四个 CI 浏览器脚本里的未触发 fixture/状态；四套未接 CI 的手动回归脚本完整保留 |
| 依赖 | 删除三处直接依赖声明，运行 `uv lock --offline`；锁文件仅移除两个包，无新包、无版本升级 |

### 实际规模

以下为相对基线的 `git diff --numstat`，包括空行/注释整理与调用行替换；不把本报告新增内容或临时验证产物算进删除收益。

| 区域 | 改动文件数（含删除） | 净减少物理行 |
|---|---:|---:|
| `frontend/` | 15，其中 4 个文件删除 | 2,545 |
| `src/` | 6 | 46 |
| `tests/` | 4 | 24 |
| `scripts/` | 4 | 26 |
| 源码/前端/测试/脚本合计 | 29 | **2,641** |
| 根配置/依赖声明 | 4 | 5 |
| `uv.lock` | 1 | 69 |
| 跟踪文件合计 | 34，其中 4 个文件删除 | **2,715** |

代码范围净减少 2,641 行，约占基线 16,422 行的 **16.1%**。与审计候选约 2,611 行的差异来自关联空行、失效属性及未消费绑定的联动清理，不是额外删除待确认模块。

### 第一轮结束时的清理建议矩阵

以下逐项复核原摘要的七项建议，记录第一轮结束时状态；第二轮后的状态见第 8 节。已完成项的优先级保留原清理顺序；其余优先级按现有证据与风险调整。本表不是净删除量的完整分解，不能将文件体量、候选范围和实际净减少量直接相加。

| 优先级 | 清理范围 | 当前状态 | 行数口径 | 风险与处置 |
|---|---|---|---|---|
| P0 | `player.js/history.js/player.css/history.css` | 已完成 | 四文件本身 1,532 物理行；原 1,340 是非空行口径 | 低；已同步移除 CSS 导入和 CI 旧播放器动态导入，浏览器回归通过 |
| P0 | `pcm_to_wav`、`GEMINI_TEXT_MODEL`、`pydub/audioop-lts` | 已完成 | 原约 35 行只对应 WAV 及关联测试候选，不能代表整组；依赖/锁文件另计 | 低；联动导入/导出/配置清理，两包实际卸载后 280 项后端测试通过 |
| P1 | 四个未接 CI 的手动浏览器脚本 | 保留，移出直接删除清单 | 安全删除收益未证实，不计约 998 行 | 中；包含独有侧栏、重试、事件及弹层断言，未证明 `test_chat.cjs` 等价覆盖；若未来统一测试框架，需保留并迁移这些断言 |
| P1/P2 | `_normalize_client_id`、`gateway.get_catalog`、`_generation_parts` | 必须拆分：normalize 已清理；其余分别为 S02、S01 待确认 | 原约 40 行无统一可删除依据，尚未核算后续净收益 | normalize 五处已直调；catalog 有实际调用与模块边界价值；generation 仍支撑字符串 mock/兼容，需先确认接口策略或迁移测试 |
| P2 | `dependencies.py` 两段代理鉴权 | D01 活跃重复，尚未合并 | 未核算净减少量，约 35 行缺乏依据 | 中至高；短密钥检查与错误文案不同，应保留两条 FastAPI 依赖边界及严格校验，并覆盖认证失败与 private 开发场景 |
| P1 | `layout.css` 旧工作台规则 | 已完成 | 文件实际净减少 575 行，包含空行/注释整理；原约 700 行不成立 | 低至中；仅删明确无匹配范围，设置弹窗/global/media 保留，浏览器回归通过 |
| P3 | `LegacyTTSStorage + cache_service.py` 退役 | S05 待确认，继续保留 | 当前两文件体量 310 行，不是已可删除量或最终净收益 | 高；需身份代理、数据处置、回滚窗口和运维验收，不能仅靠切换默认模式；`history_service.py` 共享部分仍须保留 |

原矩阵中的“极低风险直接删四个手动脚本”“把三类 Wrapper 一并清理”“鉴权可净省约 35 行”均不能由当前证据支持。前端旧文件删除也必须包含测试导入联动，不能只物理删除。上述校准只更新文档，未扩大代码清理范围。

### 删除后的回归验证

| 检查 | 结果 |
|---|---|
| `uv run pytest -q --tb=short` | 280 passed，2 warnings，36.06s，退出码 0 |
| `uv sync --frozen --dev --offline` | 实际卸载 `audioop-lts==0.2.2`、`pydub==0.25.1`，退出码 0 |
| `uv run --frozen --offline pytest -q --tb=short` | 卸载两包后再次验证：280 passed，2 warnings，35.92s，退出码 0 |
| `node scripts/test_frontend_syntax.cjs` | 3 组检查器自身回归通过 |
| `node scripts/check_frontend.cjs` | 剩余全部 7 个前端 JS 模块语法通过 |
| `node scripts/test_conversations.cjs` | 持久化、隔离、快照、恢复、迁移和存储错误检查通过 |
| `test_frontend.cjs` | 通过 |
| `test_theme_and_sidebar.cjs` | 通过 |
| `test_async_state.cjs` | 通过 |
| `test_chat.cjs` | 通过 |
| `test_copilot_send_fix.cjs` | 通过 |
| `test_sidebar_new_features.cjs` | 通过 |
| `test_sidebar_resizer.cjs` | 通过 |
| `test_explain_popover.cjs` | 通过 |
| `docker compose config --quiet` | 配置验证通过，没有启动容器或输出环境值 |
| 锁文件结构对比 | 56 → 54 个包；只移除上述两包，无新增或版本变更 |
| 删除符号的源码/测试/脚本检索 | 无剩余使用引用 |
| `git diff --check` | 通过 |
| 独立代码复核 | 核对全部工作树改动及调用/DOM/样式/测试边界，无未解决的 Critical、Important 或 Minor 问题 |

后端从 281 项减少到 280 项，仅因为删除了验证闲置 WAV 函数的专属测试，其余后端行为测试保留。八套浏览器测试使用本地 fixture，不调用真实供应商；两套截图生成脚本覆盖的 8 张图片均已按原字节恢复，`docs/screenshots` 无 diff。临时验证器和日志保存在 Git 忽略的 `.pytest_cleanup_fix/`，不属于提交改动。

第一轮未执行 Docker 镜像构建/启动、真实供应商或代理验证、生产数据迁移。因此结果证明本地离线回归和配置成立，不代表生产切换或历史存储退役已经完成。该阶段存储双轨、`_generation_parts`、Gateway 门面、重放 API、隐藏测试钩子以及活跃重复逻辑维持原状；后续变化见第 8 节。

## 8. 第二轮：剩余包装、重复逻辑和测试基础设施精简

用户明确要求“缩减还未删除的部分”后，继续处理已经有调用关系证据、能够保持当前业务合同的部分。没有切换 legacy/private 默认模式或删除历史数据。

### 最终处置状态

| 区域 | 实际精简 | 保留的合同与验证 |
|---|---|---|
| S01 `_generation_parts` | 删除字符串兼容分支、专属 LLMResult 导入；路由直接解包生成服务四元组 | 仓库内字符串模拟全部迁至真实返回形态；缓存/隔离/重复计费/元数据断言保留 |
| S02 `get_catalog` 包装 | `registry.catalog as get_catalog` 直接别名导入，删除转发函数 | gateway 与 package 的原公开调用名保留，三个入口指向同一函数；模型目录及 readiness 行为不变 |
| S03 旧前端回放 helper | 删除仅被 CI 直接调用的 `loadExplanationForReplay`；竞态测试迁至当前 `requestExplanation` POST 链路 | 保留后端 GET `/api/explain` 的只读合同；旧聊天晚返回、finally、404/network、取消动画保护继续验证 |
| S04 隐藏重试挂钩 | 删除 HTML 节点、字段、绑定及 `.ai-retry-btn` 专属样式 | 空态开始和气泡重试仍可见可用；新增 sent text/忙态/重试结果回归，并检验实际输入禁用状态 |
| S08 无消费者回调 | 删除 Copilot `onStateChange`、Settings `onEngineChange/onVoiceChange` 与专属调用 | 引擎/音色实际 change、持久化和元数据更新仍在；实际 `onLimitsLoaded` 保留，来源字段未重写 |
| D01 代理身份验证 | 两条代理链路复用 `trusted_identity`，不同登录错误文案通过参数保留；开发 ID 校验复用 `require_client_id` | TTS/Copilot 依赖函数、身份哈希命名空间及 legacy/development 路径保留；Copilot 现也拒绝配置中的短代理密钥 |
| D08 八套浏览器基础设施 | 提取 `scripts/browser_test_helper.cjs`，统一浏览器发现/启动、CDP、异常采集、退出和临时目录清理 | 211 个业务 assert 调用、fixture、特有等待/诊断、时区、截图路径保留；浏览器工具的断连回归接入 CI |
| S05 旧存储及其余数据/事务合同 | 继续保留 | 两种资产合同、身份基础设施、历史升级与回滚条件仍需实际验收，310 行仍是现存体量 |

鉴权是本轮唯一预期的校验加强：即使运行时设置绕过 Settings 初始化，Copilot 也不接受短代理密钥。新增 49 个参数化用例覆盖缺失/错误/短密钥、空/控制字符身份、Unicode 与 trim、稳定 ownership hash、legacy/development ID 校验及 private 开发不回退。修改前准确复现两项短密钥用例失败，修改后全部通过；其他 HTTP 文案和错误码保持。

共享浏览器工具的独立复核发现，关闭后的 WebSocket 会静默丢弃新命令，造成 Promise 永久等待。已先用真实浏览器及永久回归复现，再在入队前检查 `WebSocket.OPEN`。`test_browser_helper.cjs` 验证启动 ENOENT 后的临时目录清理、CDP/求值错误、异步对象返回、关闭时未完成调用和关闭后新调用的及时拒绝，并已加入 CI。

### 第二轮净收益与累计规模

第二轮基线保存于 Git 忽略的 `.pytest_cleanup_fix/round2-baseline.json`，为第一轮结束后的 76 个现存代码文件、13,781 物理行。统计包含三个新代码文件，不使用只统计已跟踪文件的 diff 来遗漏新增成本。

| 区域 | 第二轮改动文件数（含新增） | 净减少物理行 |
|---|---:|---:|
| `src/` | 3 | 17 |
| `frontend/` | 4 | 72 |
| `scripts/` | 10 | 214 |
| `tests/` | 3 | -99（新增） |
| 代码范围合计 | 20 | **204** |
| CI 配置 | 1 | -1（新增命令，不计业务代码量） |

八套浏览器脚本提取重复基础设施减少 388 行，共享 helper 新增 119 行，净减少 269 行；随后扣除 40 行工具生命周期回归、15 行前端测试增强，scripts 区域净减少 214 行。后端测试新增 92 行认证测试文件及 7 行模拟契约更新，共 99 行。新增测试与共享工具均已计入成本。

第一轮代码净减少 2,641 行，第二轮净减少 204 行，**累计净减少 2,845 行**。相对原始 16,422 行代码范围约 **17.3%**；现存 79 个代码文件共 13,577 行。四个旧文件删除、三个有实际职责的测试/工具文件新增，不能把文件数下降视为唯一收益。根配置、lock、CI 与本报告不计入这个代码比例；计入根配置/锁文件/CI 的全仓净减少量为 2,918 行，仍不包含报告本身。

### 最终验证

| 检查 | 实际结果 |
|---|---|
| `uv run --frozen --offline pytest -q --tb=short` | **329 passed，2 warnings，29.73s，退出码 0** |
| `node scripts/test_browser_helper.cjs` | 生命周期回归通过，退出码 0 |
| 八套离线浏览器回归 | **8/8 通过**；包含迁移后的 17 组 Copilot 异步场景与可见重试 |
| `node scripts/test_frontend_syntax.cjs` | 3 组检查器回归通过 |
| `node scripts/check_frontend.cjs` | 7 个实际前端 JS 模块通过 |
| `node scripts/test_conversations.cjs` | 持久化/隔离/恢复/迁移/存储错误检查通过 |
| 删除符号检索 | 源码、测试、脚本无剩余引用 |
| 独立代码复核 | 已修复断连边界问题，无未解决 Critical/Important/Minor 项 |
| 文档截图 | 两套截图生成脚本执行后，8 张 PNG 按原字节恢复，无 diff |

后端 280 → 329 是新增 49 个鉴权用例；没有删除已有后端行为测试。所有页面业务断言保留，新生命周期回归另计。仍未运行 Docker build/真实供应商/实际代理/生产迁移，现有两条依赖弃用 warning 保留。S06–S07、来源字段、版本/依赖清单漂移，以及 D02–D07/D09–D11 的其他活跃算法仍须按其实际合同另行验证，未扩大为直接删除。审查阶段结束时，两轮修改尚未提交或推送。

随后按用户“创建分支并 PR”的要求准备提交；打包前再次运行完整后端测试，结果为 **329 passed，2 warnings，16.18s**。前端语法检查器、七个前端模块、会话存储检查及浏览器工具生命周期回归再次通过。提交与 PR 的差异包含本报告及两轮实现，忽略目录中的临时盘点、日志和验证 runner 不纳入提交。

## 附录：逐文件覆盖清单

下表由基线 `git ls-files` 生成。文本均全文阅读，锁文件完整结构解析，图片仅核对引用/生成路径；未将未跟踪审计报告计入原仓库规模。
| 文件 | 覆盖方式 |
|---|---|
| `.dockerignore` | 全文阅读 + 相关引用核查 |
| `.env.example` | 全文阅读 + 相关引用核查 |
| `.github/workflows/ci.yml` | 全文阅读 + 相关引用核查 |
| `.gitignore` | 全文阅读 + 相关引用核查 |
| `AGENTS.md` | 全文阅读 + 相关引用核查 |
| `Dockerfile` | 全文阅读 + 相关引用核查 |
| `LICENSE` | 全文阅读 + 相关引用核查 |
| `README.md` | 全文阅读 + 相关引用核查 |
| `docker-compose.yml` | 全文阅读 + 相关引用核查 |
| `docs/deployment/COPILOT_DEPLOYMENT.md` | 全文阅读 + 相关引用核查 |
| `docs/development/CHAT_INTERFACE.md` | 全文阅读 + 相关引用核查 |
| `docs/development/DEVELOPMENT.md` | 全文阅读 + 相关引用核查 |
| `docs/development/SENTENCE_AUTO_FLOW_IMPLEMENTATION.md` | 全文阅读 + 相关引用核查 |
| `docs/i18n/README_zh.md` | 全文阅读 + 相关引用核查 |
| `docs/releases/RELEASE_AUDIT.md` | 全文阅读 + 相关引用核查 |
| `docs/releases/STABLE_RELEASE.md` | 全文阅读 + 相关引用核查 |
| `docs/screenshots/ai-popover-dark.png` | 图片用途/生成路径核对 |
| `docs/screenshots/ai-popover-open.png` | 图片用途/生成路径核对 |
| `docs/screenshots/chat-collapsed.png` | 图片用途/生成路径核对 |
| `docs/screenshots/chat-dark.png` | 图片用途/生成路径核对 |
| `docs/screenshots/chat-desktop.png` | 图片用途/生成路径核对 |
| `docs/screenshots/chat-mobile-ai.png` | 图片用途/生成路径核对 |
| `docs/screenshots/chat-mobile-sessions.png` | 图片用途/生成路径核对 |
| `docs/screenshots/chat-mobile.png` | 图片用途/生成路径核对 |
| `frontend/api.js` | 全文阅读 + 相关引用核查 |
| `frontend/app.js` | 全文阅读 + 相关引用核查 |
| `frontend/chat.css` | 全文阅读 + 相关引用核查 |
| `frontend/conversations.js` | 全文阅读 + 相关引用核查 |
| `frontend/copilot.css` | 全文阅读 + 相关引用核查 |
| `frontend/copilot.js` | 全文阅读 + 相关引用核查 |
| `frontend/history.css` | 全文阅读 + 相关引用核查 |
| `frontend/history.js` | 全文阅读 + 相关引用核查 |
| `frontend/index.html` | 全文阅读 + 相关引用核查 |
| `frontend/layout.css` | 全文阅读 + 相关引用核查 |
| `frontend/message-player.js` | 全文阅读 + 相关引用核查 |
| `frontend/player.css` | 全文阅读 + 相关引用核查 |
| `frontend/player.js` | 全文阅读 + 相关引用核查 |
| `frontend/settings.js` | 全文阅读 + 相关引用核查 |
| `frontend/sidebar-resizer.js` | 全文阅读 + 相关引用核查 |
| `frontend/style.css` | 全文阅读 + 相关引用核查 |
| `frontend/theme.css` | 全文阅读 + 相关引用核查 |
| `pyproject.toml` | 全文阅读 + 相关引用核查 |
| `requirements.txt` | 全文阅读 + 相关引用核查 |
| `scripts/check_frontend.cjs` | 全文阅读 + 相关引用核查 |
| `scripts/clear_legacy_tts.py` | 全文阅读 + 相关引用核查 |
| `scripts/test_async_state.cjs` | 全文阅读 + 相关引用核查 |
| `scripts/test_chat.cjs` | 全文阅读 + 相关引用核查 |
| `scripts/test_conversations.cjs` | 全文阅读 + 相关引用核查 |
| `scripts/test_copilot_send_fix.cjs` | 全文阅读 + 相关引用核查 |
| `scripts/test_explain_popover.cjs` | 全文阅读 + 相关引用核查 |
| `scripts/test_frontend.cjs` | 全文阅读 + 相关引用核查 |
| `scripts/test_frontend_syntax.cjs` | 全文阅读 + 相关引用核查 |
| `scripts/test_sidebar_new_features.cjs` | 全文阅读 + 相关引用核查 |
| `scripts/test_sidebar_resizer.cjs` | 全文阅读 + 相关引用核查 |
| `scripts/test_theme_and_sidebar.cjs` | 全文阅读 + 相关引用核查 |
| `scripts/verify_tts_process.ps1` | 全文阅读 + 相关引用核查 |
| `src/app/__init__.py` | 全文阅读 + 相关引用核查 |
| `src/app/api/__init__.py` | 全文阅读 + 相关引用核查 |
| `src/app/api/dependencies.py` | 全文阅读 + 相关引用核查 |
| `src/app/api/explain.py` | 全文阅读 + 相关引用核查 |
| `src/app/api/history.py` | 全文阅读 + 相关引用核查 |
| `src/app/api/limits.py` | 全文阅读 + 相关引用核查 |
| `src/app/api/security.py` | 全文阅读 + 相关引用核查 |
| `src/app/api/tts.py` | 全文阅读 + 相关引用核查 |
| `src/app/config.py` | 全文阅读 + 相关引用核查 |
| `src/app/main.py` | 全文阅读 + 相关引用核查 |
| `src/app/schemas/__init__.py` | 全文阅读 + 相关引用核查 |
| `src/app/schemas/explain.py` | 全文阅读 + 相关引用核查 |
| `src/app/schemas/tts.py` | 全文阅读 + 相关引用核查 |
| `src/app/services/__init__.py` | 全文阅读 + 相关引用核查 |
| `src/app/services/cache_service.py` | 全文阅读 + 相关引用核查 |
| `src/app/services/engines/__init__.py` | 全文阅读 + 相关引用核查 |
| `src/app/services/engines/base.py` | 全文阅读 + 相关引用核查 |
| `src/app/services/engines/edge_engine.py` | 全文阅读 + 相关引用核查 |
| `src/app/services/engines/gemini_engine.py` | 全文阅读 + 相关引用核查 |
| `src/app/services/errors.py` | 全文阅读 + 相关引用核查 |
| `src/app/services/explain_service.py` | 全文阅读 + 相关引用核查 |
| `src/app/services/gemini_client.py` | 全文阅读 + 相关引用核查 |
| `src/app/services/history_service.py` | 全文阅读 + 相关引用核查 |
| `src/app/services/legacy_tts_storage.py` | 全文阅读 + 相关引用核查 |
| `src/app/services/llm/__init__.py` | 全文阅读 + 相关引用核查 |
| `src/app/services/llm/gateway.py` | 全文阅读 + 相关引用核查 |
| `src/app/services/llm/providers.py` | 全文阅读 + 相关引用核查 |
| `src/app/services/llm/quota.py` | 全文阅读 + 相关引用核查 |
| `src/app/services/llm/registry.py` | 全文阅读 + 相关引用核查 |
| `src/app/services/llm/types.py` | 全文阅读 + 相关引用核查 |
| `src/app/services/private_tts_adapter.py` | 全文阅读 + 相关引用核查 |
| `src/app/services/private_tts_storage.py` | 全文阅读 + 相关引用核查 |
| `src/app/services/runtime.py` | 全文阅读 + 相关引用核查 |
| `src/app/services/tts_service.py` | 全文阅读 + 相关引用核查 |
| `src/app/services/tts_storage.py` | 全文阅读 + 相关引用核查 |
| `src/app/validation.py` | 全文阅读 + 相关引用核查 |
| `start.bat` | 全文阅读 + 相关引用核查 |
| `stop.bat` | 全文阅读 + 相关引用核查 |
| `tests/conftest.py` | 全文阅读 + 相关引用核查 |
| `tests/test_api.py` | 全文阅读 + 相关引用核查 |
| `tests/test_cache_flow.py` | 全文阅读 + 相关引用核查 |
| `tests/test_deployment_scripts.py` | 全文阅读 + 相关引用核查 |
| `tests/test_edge_timeline.py` | 全文阅读 + 相关引用核查 |
| `tests/test_explain.py` | 全文阅读 + 相关引用核查 |
| `tests/test_legacy_tts_cleanup.py` | 全文阅读 + 相关引用核查 |
| `tests/test_llm_providers.py` | 全文阅读 + 相关引用核查 |
| `tests/test_private_tts_api.py` | 全文阅读 + 相关引用核查 |
| `tests/test_private_tts_storage.py` | 全文阅读 + 相关引用核查 |
| `tests/test_release.py` | 全文阅读 + 相关引用核查 |
| `tests/test_storage_integrity.py` | 全文阅读 + 相关引用核查 |
| `tests/test_tts_api_service.py` | 全文阅读 + 相关引用核查 |
| `tests/test_tts_service.py` | 全文阅读 + 相关引用核查 |
| `uv.lock` | 全部 56 包记录与依赖图解析 |
