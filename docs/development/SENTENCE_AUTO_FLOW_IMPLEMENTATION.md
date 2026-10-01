# 整段 MP3 + 句子时间戳：实施操作文档

## 1. 目标

用户一次粘贴多句话，只点击一次“生成语音”。系统完成以下事情：

1. 整段文本只合成一个 MP3，保证语气、停顿和下载体验连续。
2. 同一次 Edge TTS 流中收集每句话的开始、结束时间。
3. 前端把文本显示为“一句一行”。
4. 播放时自动高亮正在朗读的句子，并在长文本中自动跟随滚动。
5. 用户暂停、继续、拖动进度条或调整播放速度后，高亮仍然正确。

本阶段不做逐句 AI 讲解，不把一句话拆成一次 TTS 请求，也不分析 MP3 波形来猜测时间。

## 2. 可行性结论

该功能可以直接建立在当前代码上，技术风险较低。

项目锁定了 `edge-tts 7.2.8`。这个版本的 `Communicate` 默认边界类型就是 `SentenceBoundary`，流式结果会同时产生：

- `audio`：MP3 二进制块；
- `SentenceBoundary`：包含 `text`、`offset`、`duration` 的句界事件。

当前 [`edge_engine.py`](../backend/app/services/engines/edge_engine.py) 已经遍历了这条流，但只保存 `audio` 块，句界事件被忽略。因此不需要增加一次网络请求，只需在原循环中同时收集两类数据。

`offset` 和 `duration` 使用 100 纳秒 tick。换算公式是：

```text
start_ms = offset / 10_000
end_ms   = (offset + duration) / 10_000
```

仓库本地安装包的 `edge_tts/submaker.py` 也使用同一换算关系：tick 除以 10 得到微秒。

## 3. 本期范围

### 必须完成

- Edge TTS 一次生成整段 MP3 和句子时间轴；
- 新增返回 JSON 清单的接口；
- MP3 与时间轴成对缓存；
- 前端自动分行展示、播放高亮、自动跟随；
- 历史记录仍以“整段文本”为一条记录；
- 当前 `/api/tts` 二进制接口保持可用。

### 暂不完成

- Gemini TTS 的句子时间轴；
- 逐句生成多个 MP3；
- 逐词高亮；
- 当前句自动触发 AI 讲解；
- 用户手动编辑句子切分结果。

Gemini 当前没有提供本项目可直接使用的句界事件。第一版选择 Gemini 时继续走原 `/api/tts`，正常播放但不显示同步高亮。

## 4. 总体数据流

```text
用户输入整段文本
      |
      | POST /api/tts/flow
      v
Edge Communicate.stream()
      |
      +---- audio 块 -----------------> 合并为一个 MP3
      |
      +---- SentenceBoundary 事件 ----> 转换为毫秒时间轴
      |
      v
成对写入缓存：<key>.mp3 + <key>.timeline.json
      |
      v
返回 JSON 清单（audio_url + sentences）
      |
      +---- 前端获取 MP3，交给现有播放器
      |
      +---- 前端渲染一句一行，根据 currentTime 高亮
```

## 5. API 设计

### 5.1 保留现有接口

```http
POST /api/tts
```

继续直接返回 `audio/mpeg`，用于旧前端、Gemini 和降级路径。不要在本次改造中更改它的响应格式。

### 5.2 新增句子流接口

```http
POST /api/tts/flow
Content-Type: application/json
X-Client-ID: <client-id>
```

请求体继续复用 `TTSRequest`：

```json
{
  "text": "今日はいい天気です。散歩に行きましょう！明日はどうですか？",
  "engine": "edge",
  "voice": "ja-JP-NanamiNeural"
}
```

成功响应：

```json
{
  "version": 1,
  "cache_key": "95be26a8c12f7b01",
  "audio_url": "/api/tts/95be26a8c12f7b01",
  "media_type": "audio/mpeg",
  "engine": "edge",
  "voice": "ja-JP-NanamiNeural",
  "cached": false,
  "timeline_available": true,
  "sentences": [
    {
      "index": 0,
      "text": "今日はいい天気です。",
      "start_ms": 100,
      "end_ms": 1640
    },
    {
      "index": 1,
      "text": "散歩に行きましょう！",
      "start_ms": 1640,
      "end_ms": 3420
    },
    {
      "index": 2,
      "text": "明日はどうですか？",
      "start_ms": 3420,
      "end_ms": 4810
    }
  ]
}
```

约定：

- `start_ms` 含边界，`end_ms` 不含边界；
- `index` 从 0 开始且连续；
- 时间必须非负，并按 `start_ms` 单调递增；
- `text` 以 Edge 返回的边界文本为准；
- `audio_url` 返回同一次合成所得的 MP3，不能指向另一轮合成的音频；
- `timeline_available=false` 时 `sentences=[]`，前端仍可播放音频，但不显示同步高亮。

建议状态码：

- `200`：合成成功或命中完整缓存；
- `422`：请求了暂不支持时间轴的引擎；
- `502`：Edge 上游超时、断流或无音频；
- `500`：本地缓存或未预期错误。

路由 `/tts/flow` 必须声明在动态路由 `/tts/{cache_key}` 之前，避免 `flow` 被当成缓存键。

### 5.3 前端获取音频

接口返回 JSON 后，再按 `audio_url` 获取 MP3：

```js
const manifestResponse = await fetch("/api/tts/flow", requestOptions);
const manifest = await manifestResponse.json();

const audioResponse = await fetch(manifest.audio_url, {
  headers: { "X-Client-ID": getClientId() },
});
const audioBlob = await audioResponse.blob();
```

仍然把 `audioBlob` 交给现有 `playAudioBlob()`，这样波形、下载、倍速和历史播放逻辑可以继续复用。不要把 MP3 转成 Base64 放进 JSON；这会增加体积、内存占用和前端处理成本。

## 6. 后端实施

### 6.1 定义内部结果类型

修改 [`backend/app/services/engines/base.py`](../backend/app/services/engines/base.py)，增加不可变数据结构：

```python
from dataclasses import dataclass


@dataclass(frozen=True)
class SentenceCue:
    text: str
    start_ms: int
    end_ms: int


@dataclass(frozen=True)
class TimedSynthesisResult:
    audio_bytes: bytes
    sentences: list[SentenceCue]
```

不要直接把现有抽象方法 `synthesize()` 的返回值从 `bytes` 改掉，否则会强迫 Gemini、现有接口和已有测试一起迁移。采用增量接口：

```python
@property
def supports_sentence_timeline(self) -> bool:
    return False

async def synthesize_with_timeline(...) -> TimedSynthesisResult:
    raise NotImplementedError
```

`EdgeTTSEngine` 覆盖这两个成员；Gemini 暂时保持默认能力声明。

### 6.2 收集 Edge 句界事件

修改 [`backend/app/services/engines/edge_engine.py`](../backend/app/services/engines/edge_engine.py)。建议把普通合成和带时间轴合成共用一个私有方法，避免两套网络异常处理逻辑。

核心循环如下：

```python
communicate = edge_tts.Communicate(
    text,
    selected_voice,
    boundary="SentenceBoundary",
)

audio_chunks: list[bytes] = []
sentences: list[SentenceCue] = []

async for chunk in communicate.stream():
    if chunk["type"] == "audio":
        audio_chunks.append(chunk["data"])
    elif chunk["type"] == "SentenceBoundary":
        offset = int(chunk["offset"])
        duration = int(chunk["duration"])
        sentences.append(
            SentenceCue(
                text=chunk["text"],
                start_ms=offset // 10_000,
                end_ms=(offset + duration) // 10_000,
            )
        )
```

结束后执行以下校验：

1. `audio_chunks` 不能为空；
2. 每个句子的 `text` 不能为空；
3. `0 <= start_ms <= end_ms`；
4. `start_ms` 不得倒退；
5. 重新编号，避免信任上游索引。

不要根据字符数补造缺失时间。上游没有返回句界时，应保留音频并返回 `timeline_available=false`，同时记录警告日志，方便后续观察真实发生率。

### 6.3 增加服务层入口

修改 [`backend/app/services/tts_service.py`](../backend/app/services/tts_service.py)，新增：

```python
async def synthesize_with_timeline(...) -> TimedSynthesisResult:
    engine_impl = get_engine(engine)
    if not engine_impl.supports_sentence_timeline:
        raise TTSConfigError("当前语音引擎暂不支持句子同步。")
    return await engine_impl.synthesize_with_timeline(...)
```

保留原 `synthesize()`，不要让旧接口经过新方法。

### 6.4 增加响应模型

修改 [`backend/app/schemas/tts.py`](../backend/app/schemas/tts.py)，新增：

- `SentenceCueResponse`；
- `TTSFlowResponse`。

字段严格按第 5.2 节的 JSON 协议定义。通过 Pydantic 输出响应，避免在路由里维护松散字典。

### 6.5 MP3 与时间轴成对缓存

当前 [`cache_service.py`](../backend/app/services/cache_service.py) 只缓存 `<cache_key>.mp3`。新增：

```text
backend/app/cache/audio/<cache_key>.mp3
backend/app/cache/audio/<cache_key>.timeline.json
```

时间轴 sidecar 建议包含：

```json
{
  "version": 1,
  "engine": "edge",
  "voice": "ja-JP-NanamiNeural",
  "audio_sha256": "完整的音频摘要",
  "sentences": []
}
```

必须把它们当成一个缓存单元：

- MP3 和 JSON 都存在，并且 `audio_sha256` 匹配，才算命中；
- 只有旧 MP3、JSON 缺失或摘要不匹配，都算未命中；
- 未命中时重新合成一轮，同时替换 MP3 和时间轴；
- 删除缓存时同时删除两个文件；
- 写入临时文件后再 `Path.replace()`，避免中断后留下半份 JSON。

不要先复用旧 MP3、再单独合成一轮时间轴。两轮语音的停顿可能不同，时间戳将不能可靠对应旧音频。

为避免与旧缓存混淆，新增 `compute_flow_cache_key()`，原始材料至少包含：

```text
text | voice | engine | sentence-flow-v1
```

保留现有 `compute_cache_key()` 的算法，避免破坏已有历史记录。时间轴协议变更时把 `v1` 升级为 `v2`，让旧缓存自然失效。

### 6.6 新增路由

修改 [`backend/app/api/tts.py`](../backend/app/api/tts.py)：

1. 解析并校验引擎、声音和客户端 ID；
2. 计算 flow 专用缓存键；
3. 尝试读取“MP3 + 时间轴”完整缓存；
4. 缓存未命中时调用 `synthesize_with_timeline()`；
5. 成对保存缓存；
6. 用完整原文调用一次 `add_or_touch()`；
7. 返回 `TTSFlowResponse`。

异常映射应与现有 `/api/tts` 一致。可以抽出共享的异常转换函数，避免复制四段 `except`；如果本次不重构，也至少保持用户可见文案一致。

日志只记录 `engine`、`voice`、文本长度、句子数、耗时、缓存状态和缓存键，不记录完整学习文本。

## 7. 前端实施

### 7.1 不要改写用户输入框

“一句一行”应当是播放视图，不应向原 `textarea` 强行插入换行。原因是：

- 用户仍需要修改原文；
- 插入换行可能改变 TTS 停顿；
- 自动整理与用户原始输入混在一起，撤销和光标位置会变得不可预测。

在输入框下方或播放器上方新增：

```html
<section id="sentenceFlow" class="sentence-flow" hidden>
  <div id="sentenceList" class="sentence-list"></div>
</section>
```

每句使用一个普通按钮或带 `tabindex` 的行元素。推荐按钮，因为点击句子跳转到对应位置时天然支持键盘：

```html
<button class="sentence-row" data-index="0" type="button">
  <span class="sentence-index">1</span>
  <span class="sentence-text">今日はいい天気です。</span>
</button>
```

### 7.2 粘贴后的即时预览

为了让用户刚粘贴就看到整洁结构，在 `input` 事件后约 120 ms 生成预览句子。优先使用浏览器原生分句：

```js
const segmenter = new Intl.Segmenter(undefined, { granularity: "sentence" });
const previewSentences = [...segmenter.segment(text)]
  .map((item) => item.segment.trim())
  .filter(Boolean);
```

对不支持 `Intl.Segmenter` 的浏览器，使用保留标点的简单回退规则，至少覆盖：

```text
。！？!?…\n
```

预览只负责排版。生成成功后，必须用后端 `sentences` 重新渲染列表，因为只有后端句子与 MP3 时间轴是一一对应的。

### 7.3 增加独立播放状态

当前 [`frontend/app.js`](../frontend/app.js) 的 `activeAudioText` 表示整段音频对应的原文。不要在高亮切换时把它改成当前句，否则会错误触发“文本已修改/需要重新生成”的 dirty 状态。

新增独立状态：

```js
let activeTimeline = [];
let activeSentenceIndex = -1;
let sentenceSyncFrame = null;
```

整段原文继续放在 `activeAudioText`，当前句只由 `activeSentenceIndex` 表示。

### 7.4 改造生成流程

在 `handleGenerateTTS()` 中：

- Edge：请求 `/api/tts/flow`，读取 JSON，再取 MP3；
- Gemini：继续请求 `/api/tts` 并读取 Blob；
- Edge flow 失败且属于“不支持时间轴/时间轴不可用”时，可降级到原 `/api/tts`；
- 其他网络错误保持现有错误提示，不要无提示地重复合成。

拿到结果后：

```js
activeTimeline = manifest.sentences;
renderSentenceRows(activeTimeline);
playAudioBlob(audioBlob, manifest.cache_key, {
  text,
  engine: manifest.engine,
  voice: manifest.voice,
});
```

现有 AI 解释如果开启，仍只对完整 `text` 调用一次。切换高亮时不要调用 `requestExplanation()`。

需要用请求序号或 `AbortController` 防止旧请求覆盖新请求：用户在第一次生成未完成时修改文本并再次生成，较晚返回的旧响应必须被丢弃。

### 7.5 高亮同步算法

高亮判断使用 `audioPlayer.currentTime * 1000`。不要按字数估时，也不要使用固定定时器累计时间。

为了避免句间静音时高亮闪烁，当前句定义为：

```text
最后一个 start_ms <= currentTimeMs 的句子
```

也就是一直保持上一句高亮，直到下一句真正开始。播放尚未达到第一句的 `start_ms` 时不高亮；播放结束后清除高亮。

正常播放时句子索引只会向前移动，可从当前索引开始检查；用户拖动进度后使用二分查找定位，避免长文本每帧从头遍历。

建议在播放期间使用 `requestAnimationFrame`：

```js
function syncActiveSentence() {
  const nextIndex = findSentenceIndex(audioPlayer.currentTime * 1000);
  setActiveSentence(nextIndex);
  sentenceSyncFrame = requestAnimationFrame(syncActiveSentence);
}
```

事件处理：

- `play`：启动同步循环；
- `pause`：取消同步循环，但保留当前高亮；
- `seeking` / `seeked`：立即二分定位；
- `loadedmetadata`：定位到开头；
- `ended`：取消循环并清除高亮；
- 切换新音频：先取消旧循环、清空旧时间轴和旧高亮。

播放倍速不需要修改时间戳。`currentTime` 始终是 MP3 自身时间轴，浏览器会处理 `playbackRate`。

### 7.6 自动跟随与点击跳转

只有句子索引发生变化时才操作 DOM：

```js
row.classList.toggle("is-active", index === activeSentenceIndex);
```

当前行不在容器可视区域时调用：

```js
row.scrollIntoView({ block: "nearest", behavior: "smooth" });
```

不要在每个动画帧滚动。每句话最多滚动一次，否则页面会抖动并抢夺用户控制。

点击某行时：

```js
audioPlayer.currentTime = activeTimeline[index].start_ms / 1000;
audioPlayer.play();
```

这不是必需操作，但能把“一句一行”同时变成低学习成本的复听入口。

### 7.7 样式原则

第一版只增加三个视觉状态：

- 普通句：白色或透明背景；
- 当前句：浅色背景 + 左侧 3px 强调线；
- hover/focus：轻微底色，不新增复杂控件。

避免整句闪烁、发光动画或大幅缩放。高亮的作用是定位，不应抢过文字本身。容器设置合理最大高度并内部滚动；移动端保证当前行至少完整可见。

## 8. 历史记录和缓存回放

整段 MP3 只写入一条历史记录，历史文本仍是完整原文。

点击历史记录播放时，要同时恢复时间轴，否则只能播放、不能高亮。建议新增一个清单读取接口：

```http
GET /api/tts/flow/{cache_key}
```

它返回与 POST 相同的清单，但不重复合成。前端历史播放流程变成：

1. 获取 flow 清单；
2. 获取清单中的 MP3；
3. 恢复整段原文和句子列表；
4. 播放并同步高亮。

旧历史没有 timeline sidecar 时，返回 `404` 或 `timeline_available=false`，前端沿用现有音频回放，不自动重新合成，以免用户仅点击历史记录就产生额外上游请求。

当前 `GET /api/tts/{cache_key}` 只要知道缓存键就能取音频，并未验证该键是否属于当前 `X-Client-ID`。若网站公开部署，建议在新增清单读取接口时校验客户端历史归属，并把音频读取接口的同类问题列为上线前安全项。

## 9. 降级规则

| 场景 | 用户体验 | 系统处理 |
|---|---|---|
| Edge 返回音频和句界 | 正常播放并高亮 | 保存完整缓存对 |
| Edge 返回音频但无句界 | 正常播放，不高亮 | `timeline_available=false`，记录 warning |
| 缓存只有 MP3 | 本次稍慢，之后正常 | 重新合成并覆盖缓存对 |
| 时间轴摘要与 MP3 不匹配 | 本次稍慢，之后正常 | 判定缓存损坏并重新合成 |
| Gemini 被选中 | 正常播放，不高亮 | 继续走旧接口 |
| 浏览器不支持 `Intl.Segmenter` | 仍能看到分行预览 | 使用标点回退规则 |
| 用户拖动或倍速播放 | 高亮立即重新定位 | 基于 `currentTime`，不累计计时 |
| 旧请求晚于新请求返回 | 页面保持新内容 | 丢弃旧响应 |

## 10. 测试清单

### 10.1 引擎单元测试

新建 `backend/tests/test_edge_timeline.py`，mock `edge_tts.Communicate.stream()`，交替返回音频和句界块：

- 多个音频块被正确拼接为一个 MP3；
- `10_000` tick 正确转换为 `1 ms`；
- 句子顺序和文字保持一致；
- 空音频抛出错误；
- 空时间轴返回可降级结果；
- 负数、结束早于开始、时间倒退被拒绝；
- 并发限制仍经过现有 semaphore。

### 10.2 缓存单元测试

- MP3 + JSON + 摘要匹配才命中；
- JSON 缺失时未命中；
- MP3 缺失时未命中；
- 摘要不匹配时未命中；
- 删除操作同时删除两份文件；
- `sentence-flow-v1` 与旧缓存键不冲突。

### 10.3 API 测试

扩展 `backend/tests/test_api.py`：

- `POST /api/tts/flow` 返回规定的 JSON；
- 正确写入一条整段历史；
- 完整缓存命中时不调用 Edge；
- Gemini 请求返回明确的能力错误或按约定降级；
- 音频 URL 可取回同一份 MP3；
- `/api/tts` 旧测试全部继续通过；
- `/tts/flow` 不会落入 `/tts/{cache_key}`。

### 10.4 前端手工验收

至少覆盖以下文本：

```text
今日はいい天気です。散歩に行きましょう！明日はどうですか？
「本当に？」と彼女は聞いた。はい、そうです。
Hello world! How are you? I'm fine.
你好！今天天气不错。要一起出去吗？
```

逐项检查：

1. 粘贴后立即显示一句一行；
2. 只生成一个可下载 MP3；
3. 当前朗读句高亮，切换无明显提前或滞后；
4. 暂停时保持当前位置，继续后正常切换；
5. 拖到前一句和后一句时立即定位；
6. `0.75x`、`1.25x`、`1.5x` 下仍同步；
7. 长文本只在当前句离开可视区域时自动滚动；
8. 点击句子能从该句开始播放；
9. 从历史恢复时也能显示时间轴；
10. Gemini 和旧历史仍可普通播放；
11. 连续快速生成两段文字时，旧响应不会覆盖新结果；
12. 当前句切换不会触发逐句 AI 请求。

## 11. 验收标准

满足以下条件即可认为第一版完成：

- 输入 4 至 10 句日文、中文或英文，只发起一次 Edge 合成；
- 下载结果是一个完整 MP3；
- API 返回与该 MP3 同轮生成的句子时间轴；
- 页面自动显示一句一行；
- 正常播放时，高亮切换与听感误差不超过约 200 ms；
- 暂停、继续、拖动和倍速播放不破坏同步；
- 整段内容只产生一条历史记录；
- Edge 时间轴异常时仍可播放音频；
- 原 `/api/tts` 行为和已有测试不回归。

## 12. 推荐实施顺序

### 第一步：做最小验证

先只写引擎测试，用模拟 stream 验证“同一循环收集音频 + SentenceBoundary”。随后用一段 3 句日文在本地手工调用真实 Edge，打印句子数和毫秒区间，不写缓存和前端。

完成条件：真实响应至少产生一个 MP3 和三个单调递增的句界。

### 第二步：打通后端闭环

依次完成内部结果类型、Edge 方法、flow cache、Pydantic 响应、POST 路由和 API 测试。

完成条件：调用 `/api/tts/flow` 得到 JSON，随后能通过 `audio_url` 播放同一份 MP3；第二次请求命中完整缓存。

### 第三步：接入前端

先渲染服务端句子列表，再接高亮，最后增加即时预览和自动滚动。不要一开始同时重做现有播放器。

完成条件：现有播放器功能全部保留，新增句子列表独立工作。

### 第四步：补齐历史与降级

增加清单读取接口、旧历史降级、Gemini 降级和陈旧请求保护。

完成条件：新旧历史、Edge、Gemini 都有明确且无死路的用户体验。

### 第五步：回归与发布

运行：

```powershell
uv run pytest
```

然后按第 10.4 节完成桌面和移动端手工验收。发布初期可增加 `SENTENCE_FLOW_ENABLED` 配置开关；关闭时前端统一退回原 `/api/tts`。

## 13. 本项目中预计修改的文件

```text
backend/app/services/engines/base.py
backend/app/services/engines/edge_engine.py
backend/app/services/tts_service.py
backend/app/services/cache_service.py
backend/app/schemas/tts.py
backend/app/api/tts.py
backend/tests/test_edge_timeline.py
backend/tests/test_api.py
frontend/index.html
frontend/app.js
frontend/style.css
README.md 或 DEVELOPMENT.md
```

## 14. 实施时最容易踩的坑

1. **把预览分句当成时间轴分句。** 浏览器和 Edge 的分句结果可能不同，播放时必须以服务端时间轴为准。
2. **只缓存 MP3。** 时间轴不能在以后从 MP3 中无损恢复，二者必须成对保存和校验。
3. **为拿时间轴再合成一次。** 第二轮的停顿可能与第一轮不同，必须从同一条流中取得两类数据。
4. **在 `timeupdate` 中不断重绘全部列表。** 只在句子索引变化时切换两个 DOM 节点的 class。
5. **用 `setInterval` 自己累计播放时间。** 暂停、后台标签页、拖动和倍速都会造成漂移，始终读取 `audio.currentTime`。
6. **把当前句写入 `activeAudioText`。** 这会破坏现有 dirty 状态判断；整段原文和当前句必须分开存放。
7. **把 `/tts/flow` 放在动态缓存路由后面。** 路由顺序错误可能让 `flow` 被解释为 `cache_key`。
8. **每次高亮都触发 AI。** 本期 AI 与句子同步解耦，最多保留现有的整段调用一次。
