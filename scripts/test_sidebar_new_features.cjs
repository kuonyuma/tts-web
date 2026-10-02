const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { launchBrowser, delay } = require('./browser_test_helper.cjs');

const root = path.resolve(__dirname, '..');
const wav = Buffer.alloc(44 + 4800);
wav.write('RIFF', 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
wav.writeUInt32LE(24000, 24); wav.writeUInt32LE(48000, 28); wav.writeUInt16LE(2, 32);
wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(4800, 40);

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const json = (data, status = 200) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
  };
  if (url.pathname === '/api/engines') return json([{
    id: 'edge', name: 'Edge', is_free: true, default_voice: 'ja-JP-NanamiNeural',
    max_text_length: 1000, min_text_length: 1, request_timeout_seconds: 30,
    voices: [{ id: 'ja-JP-NanamiNeural', name: 'Nanami' }],
  }]);
  if (url.pathname === '/api/history') return json([]);
  if (url.pathname === '/api/copilot/models') return json({ models: [] });
  if (url.pathname === '/api/tts' && req.method === 'POST') {
    res.writeHead(200, {
      'Content-Type': 'audio/wav',
      'X-Cache-Key': 'a'.repeat(64),
    });
    return res.end(wav);
  }
  const relativePath = url.pathname === '/' ? 'index.html' : url.pathname.replace(/^\//, '');
  const filePath = path.join(root, 'frontend', relativePath);
  if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
    const ext = path.extname(filePath);
    const contentType = ext === '.js' ? 'text/javascript' : ext === '.css' ? 'text/css' : ext === '.html' ? 'text/html' : 'text/plain';
    res.writeHead(200, { 'Content-Type': contentType });
    return res.end(fs.readFileSync(filePath));
  }
  res.writeHead(404); res.end();
});

let browser;

(async () => {
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${server.address().port}/`;
    browser = await launchBrowser({
      profilePrefix: 'tts-sidebar-features-', args: ['--autoplay-policy=no-user-gesture-required'],
      waitAttempts: 160, waitMessage: 'UI did not reach expected state: ', exceptionDetailsAsJson: true,
    });
    const { send, evaluate, wait } = browser;

    await send('Runtime.enable');
    await send('Page.enable');
    await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await send('Page.navigate', { url });
    await wait('document.readyState === "complete"');
    await wait("document.body?.dataset.ready === 'true'");

    // 1. 验证新建会话按钮缩小并与侧边栏标题 KOTO 合成一个部分
    const buttonInHeader = await evaluate(`(() => {
      const btn = document.getElementById('newConversationBtn');
      const brandRow = document.querySelector('.brand-row');
      const brandHeader = document.querySelector('.brand-header');
      return brandRow.contains(btn) && brandHeader.contains(btn);
    })()`);
    assert.equal(buttonInHeader, true, '新建按钮必须在标题容器 brand-row / brand-header 内部');

    const buttonSize = await evaluate(`(() => {
      const btn = document.getElementById('newConversationBtn');
      const rect = btn.getBoundingClientRect();
      return { width: rect.width, height: rect.height };
    })()`);
    assert(buttonSize.width <= 32 && buttonSize.height <= 32, '新建按钮已缩小为小按钮');
    console.log('PASS 新建会话按钮已缩小并与侧边栏标题 KOTO 合成一个部分');

    // 2. 验证用户不可以无限制创建新会话（空会话不能无限重复创建）
    const initialCount = await evaluate("document.querySelectorAll('.conversation-row').length");
    assert.equal(initialCount, 1, '初始状态应有一个系统自动创建的会话');

    await evaluate(`(() => {
      for (let i = 0; i < 5; i++) {
        document.getElementById('newConversationBtn').click();
      }
    })()`);
    const countAfterSpam = await evaluate("document.querySelectorAll('.conversation-row').length");
    assert.equal(countAfterSpam, 1, '当前为空会话时重复点击新建按钮不应无限创建空白会话');
    console.log('PASS 用户无法无限制创建新会话（空会话防刷与复用生效）');

    // 3. 验证用用户输入的第一个文本作为标题，长文本只显示前面一部分
    const longText = 'むかしむかし、ある山奥に、小さな美しい花が咲いていました。誰にも見られない場所で、静かに誇らしく生きていました。';
    await evaluate(`(() => {
      const input = document.getElementById('textInput');
      input.value = ${JSON.stringify(longText)};
      input.dispatchEvent(new Event('input'));
      document.getElementById('generateBtn').click();
    })()`);

    await wait("document.querySelectorAll('.user-message').length === 1");
    const derivedTitle = await evaluate("document.querySelector('.conversation-select strong').textContent");
    assert(derivedTitle.length <= 25, `标题应只截取前一部分，实际获取: ${derivedTitle}`);
    assert(derivedTitle.startsWith('むかしむかし'), '标题应基于用户输入的第一个文本');
    assert(derivedTitle.endsWith('…'), '超长文本标题应带有省略符号');
    console.log('PASS 历史会话标题取用户首个文本的前面一部分并支持长文本截断');

    // 3.1 验证聊天气泡卡片：丰富了 TTS 引擎与音色等元数据，且自定义播放条取代黑色原生条
    await wait("!document.querySelector('.custom-player')?.hidden");
    const cardMeta = await evaluate(`(() => {
      const card = document.querySelector('.audio-card');
      const header = card.querySelector('.audio-card-header');
      const engineBadge = card.querySelector('.engine-badge')?.textContent.trim();
      const voiceName = card.querySelector('.voice-name')?.textContent.trim();
      const langTag = card.querySelector('.tag-lang')?.textContent.trim();
      const charsTag = card.querySelector('.tag-chars')?.textContent.trim();
      const customPlayer = card.querySelector('.custom-player');
      const toggleBtn = customPlayer?.querySelector('.player-btn-toggle');
      const progressBg = customPlayer?.querySelector('.player-progress-bg');
      return {
        hasHeader: !!header,
        engineBadge,
        voiceName,
        langTag,
        charsTag,
        hasCustomPlayer: !!customPlayer && !customPlayer.hidden,
        hasToggleBtn: !!toggleBtn,
        hasProgressBar: !!progressBg,
      };
    })()`);

    assert.equal(cardMeta.hasHeader, true, '卡片应包含顶部元数据区域');
    assert.equal(cardMeta.engineBadge, 'Edge TTS', '卡片应清晰展示 TTS 引擎徽章');
    assert(cardMeta.voiceName.includes('七海'), '卡片应展示当前选中的音色名');
    assert.equal(cardMeta.langTag, '日本語', '卡片应包含语言属性标识');
    assert(cardMeta.charsTag.includes('字'), '卡片应包含字符数统计');
    assert.equal(cardMeta.hasCustomPlayer, true, '自定义高颜值播放器应可见并启用');
    assert.equal(cardMeta.hasToggleBtn, true, '自定义播放器应有播放切换按钮');
    assert.equal(cardMeta.hasProgressBar, true, '自定义播放器应有翡翠绿进度条');
    console.log('PASS 聊天气泡卡片内容丰富（音色/引擎/语言/字数），且美观自定义播放器已取代黑色原生进度条');

    // 3.2 验证倍速切换功能（0.75x, 1x, 1.25x）
    const speedControls = await evaluate(`(() => {
      const speedsGroup = document.querySelector('.player-speeds');
      const buttons = Array.from(document.querySelectorAll('.speed-btn'));
      return {
        hasSpeedsGroup: !!speedsGroup,
        speeds: buttons.map(b => b.dataset.speed),
        activeSpeed: document.querySelector('.speed-btn.active')?.dataset.speed,
        initialPlaybackRate: document.querySelector('audio').playbackRate,
      };
    })()`);

    assert.equal(speedControls.hasSpeedsGroup, true, '播放器必须包含倍速切换控件组');
    assert.deepEqual(speedControls.speeds, ['0.75', '1', '1.25'], '必须提供 0.75x, 1x, 1.25x 三档倍速');
    assert.equal(speedControls.activeSpeed, '1', '默认倍速应为 1x');
    assert.equal(speedControls.initialPlaybackRate, 1, '音频元素初始播放速率应为 1');

    // 切换到 0.75x
    await evaluate("document.querySelector('.speed-btn[data-speed=\"0.75\"]').click()");
    const rate075 = await evaluate("document.querySelector('audio').playbackRate");
    const active075 = await evaluate("document.querySelector('.speed-btn.active')?.dataset.speed");
    assert.equal(rate075, 0.75, '点击 0.75x 按钮后 audio.playbackRate 应为 0.75');
    assert.equal(active075, '0.75', '0.75x 按钮应被激活');

    // 切换到 1.25x
    await evaluate("document.querySelector('.speed-btn[data-speed=\"1.25\"]').click()");
    const rate125 = await evaluate("document.querySelector('audio').playbackRate");
    const active125 = await evaluate("document.querySelector('.speed-btn.active')?.dataset.speed");
    assert.equal(rate125, 1.25, '点击 1.25x 按钮后 audio.playbackRate 应为 1.25');
    assert.equal(active125, '1.25', '1.25x 按钮应被激活');
    console.log('PASS 播放倍速切换（0.75x / 1x / 1.25x）测试全部通过');

    // 4. 当前会话已有消息时，系统允许创建新会话，且新会话同样受限
    await evaluate("document.getElementById('newConversationBtn').click()");
    const countAfterValidNew = await evaluate("document.querySelectorAll('.conversation-row').length");
    assert.equal(countAfterValidNew, 2, '前一个会话有消息后，点击新建按钮应创建新会话');

    await evaluate("document.getElementById('newConversationBtn').click()");
    const countAfterSecondSpam = await evaluate("document.querySelectorAll('.conversation-row').length");
    assert.equal(countAfterSecondSpam, 2, '新会话未发消息前不可再次无限制新建');

    // 5. 验证鼠标悬停高亮与创建会话时间戳显示
    const hasTimestampTitle = await evaluate(`(() => {
      const rows = document.querySelectorAll('.conversation-row');
      return Array.from(rows).every(r => r.getAttribute('title')?.includes('创建时间：'));
    })()`);
    assert.equal(hasTimestampTitle, true, '会话行 title 属性必须包含创建时间戳');

    const hoverTimestampElementExists = await evaluate(`(() => {
      const el = document.querySelector('.conversation-time-hover');
      return !!el && el.textContent.includes('创建于');
    })()`);
    assert.equal(hoverTimestampElementExists, true, '会话行内部包含创建时间戳标签');

    const hoverStyleValid = await evaluate(`(() => {
      const sheet = Array.from(document.styleSheets).find(s => s.href?.includes('chat.css'));
      const rules = Array.from(sheet.cssRules || []);
      const rowHover = rules.some(r => r.selectorText?.includes('.conversation-row:hover'));
      const timeHover = rules.some(r => r.selectorText?.includes('.conversation-time-hover'));
      return rowHover && timeHover;
    })()`);
    assert.equal(hoverStyleValid, true, 'CSS 中必须包含 conversation-row hover 与时间戳显示规则');
    console.log('PASS 鼠标悬停高亮与创建时间戳机制验证通过');

    console.log('ALL NEW FEATURES PASSED SUCCESSFULLY!');
  } finally {
    try {
      await browser?.close();
    } finally {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
  }
})().catch((err) => {
  console.error('Test failed:', err);
  process.exit(1);
});
