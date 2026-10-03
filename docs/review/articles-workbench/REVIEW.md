# 文章工作台审查记录

实现保留 FastAPI 与原生 ES modules，复用认证、数据库与侧栏缩放；未部署、发布或合并。

独立只读审查发现并已补回归修复：

- 幂等 POST 返回另一设备的新版本时，即便本地同时继续输入，也必须先显示冲突。
- 冲突草稿在编辑、退出和再次刷新后仍保持冲突，不能自动覆盖服务器。
- 日文 IME 中间文字本地保护，在途保存返回后不能提前提交组合输入。
- 隐藏 textarea 的 scrollTop 为 0，阅读位置改用可见时缓存并恢复。
- 选择服务器版本期间继续输入时，晚到详情不能清除新输入或草稿。
- 不同浏览器标签分别拥有草稿键；复制标签时用本地 BroadcastChannel 检测重复所有者。
- 删除期间旧详情不能重新打开已删除文章；删除失败复用已有编辑对象，保留草稿。

关键验证：完整 pytest、全部现有前端检查、文章状态并发回归与模拟网络浏览器验收。浏览器模拟有效 WAV 音频和 AI 响应，不调用真实供应商。

最终结果：

- `& ".\.venv\Scripts\python.exe" -m pytest tests -q`：451 passed，2 条既有依赖弃用警告。
- `node scripts/check_frontend.cjs`：16 个 ES modules 语法检查通过。
- `test_frontend_syntax`、`test_conversations`、`test_browser_helper`、`test_accounts`、`test_async_state`、`test_frontend`、`test_chat`、`test_copilot_send_fix`、`test_explain_popover`、`test_sidebar_new_features`、`test_sidebar_resizer`、`test_theme_and_sidebar`：全部通过。
- `node scripts/test_articles_state.cjs`：13 组并发、失败、恢复、隔离场景通过。
- `node scripts/test_articles_workbench.cjs`：14 组模拟浏览器验收通过，未捕获运行时异常。
- `node scripts/test_article_markdown.cjs`：4 组渲染测试通过，覆盖反馈中的引用、分隔线、标题、代码块，以及嵌套列表、表格、换行、安全转义和源码范围。
- `git diff --check`：通过。

既有 test_chat、test_frontend 与 test_theme_and_sidebar 的刷新等待已修正：先清掉旧页面 ready，再等待新页面完成初始化，避免旧页面被误当作刷新后的页面。

使用反馈后，顶栏两个入口合并为“阅读工作台”，文章库通过内部标签或 ＋ 打开。有正文的文章默认渲染 Markdown，提供“编辑源码”切换。阅读与编辑分别保存滚动位置；浏览器测试覆盖两种视图切换、AI 标签隐藏后刷新恢复、导入后源码保留、阅读选文保留换行及不触发语音或 AI 请求。截图使用反馈中的端口号示例。

后续新增同一区域“实时预览”：正在编辑的 Markdown 块显示源码，其他块保持排版。阅读与实时预览按源码范围对应段落，返回编辑保留光标，标签切换和刷新恢复编辑位置。新增回归覆盖组合输入事件、CRLF 保留、跨段落键盘移动、新段落、撤销/重做、工作台缩窄后的高度重算、多行粘贴后光标跟随，以及实时预览选文不触发请求。真实系统输入法候选过程尚未人工验证。

实时预览独立审查发现并修复了跨段落撤销失效、缩窄后文字裁切、多行粘贴后光标移出视口三处问题；复查及工作台浏览器回归通过。

截图：

- [文章库（浅色）](library-light.png)
- [Markdown 阅读（浅色）](desktop-light.png)
- [Markdown 阅读（深色）](desktop-dark.png)
- [实时预览（浅色）](live-light.png)
- [实时预览（深色）](live-dark.png)
- [原 AI 助手标签（深色）](ai-dark.png)
- [窄屏右侧抽屉（深色）](mobile-dark.png)
