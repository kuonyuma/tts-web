// Offline browser regressions for request ownership and deadlines. No live providers.
// Node 22+ and Chrome/Edge are required; CHROME_PATH can select the executable.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const chromePath = process.env.CHROME_PATH || [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
].find(fs.existsSync);
assert(chromePath, 'Chrome/Edge is required; set CHROME_PATH');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'tts-async-browser-'));
const keys = { A: 'a'.repeat(64), B: 'b'.repeat(64), C: 'c'.repeat(64) };
let catalogTimeout = 300;
let stallCatalog = false;
let timestamp = new Date().toISOString();
const wav = Buffer.alloc(44 + 384000);
wav.write('RIFF', 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
wav.writeUInt32LE(24000, 24); wav.writeUInt32LE(48000, 28); wav.writeUInt16LE(2, 32);
wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(384000, 40);
const models = ['m1', 'm2'].map((id, index) => ({
  id, name: id, default: index === 0,
  modes: [{ id: 'direct', name: 'Direct', description: '', quota_weight: 1 },
    { id: 'deep', name: 'Deep', description: '', quota_weight: 5 }],
}));
const records = ['A', 'B'].map((text, index) => ({
  id: index + 1, text, engine: 'edge', voice: 'ja-JP-NanamiNeural',
  cache_key: keys[text], audio_status: 'ready', created_at: timestamp, last_played_at: timestamp,
}));
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const json = (data) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); };
  if (url.pathname === '/api/engines') return json([{
    id: 'edge', name: 'Edge', is_free: true, default_voice: 'ja-JP-NanamiNeural',
    max_text_length: 1000, min_text_length: 1, request_timeout_seconds: 30,
    voices: [{ id: 'ja-JP-NanamiNeural', name: 'Nanami' }, { id: 'ja-JP-KeitaNeural', name: 'Keita' }],
  }]);
  if (url.pathname === '/api/copilot/models' && stallCatalog) return;
  if (url.pathname === '/api/copilot/models') return json({ models, request_timeout_seconds: catalogTimeout });
  if (url.pathname === '/api/history') return json(records.map((record) => ({ ...record, created_at: timestamp, last_played_at: timestamp })));
  const relative = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
  const file = path.resolve(root, 'frontend', relative);
  if (file.startsWith(path.resolve(root, 'frontend') + path.sep) && fs.existsSync(file) && fs.statSync(file).isFile()) {
    res.writeHead(200, { 'Content-Type': { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html' }[path.extname(file)] || 'text/plain' });
    return res.end(fs.readFileSync(file));
  }
  res.writeHead(404); res.end();
});
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let browser, browserExit, socket;
let failures = 0;

(async () => {
  try {
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${server.address().port}/`;
    browser = spawn(chromePath, ['--headless=new', '--remote-debugging-address=127.0.0.1',
      '--remote-debugging-port=0', '--user-data-dir=' + profile, '--no-first-run',
      '--no-default-browser-check', '--autoplay-policy=no-user-gesture-required', 'about:blank'],
    { windowsHide: true, stdio: 'ignore' });
    browserExit = new Promise((resolve) => browser.once('exit', resolve));
    const portFile = path.join(profile, 'DevToolsActivePort');
    for (let i = 0; i < 200 && !fs.existsSync(portFile); i++) await delay(25);
    assert(fs.existsSync(portFile), 'Browser debugging endpoint did not start');
    const port = fs.readFileSync(portFile, 'utf8').split(/\r?\n/)[0];
    const tab = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json();
    socket = new WebSocket(tab.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
    let callId = 0;
    const pending = new Map();
    const exceptions = [];
    socket.onmessage = (event) => {
      const data = JSON.parse(event.data);
      if (data.id) {
        const entry = pending.get(data.id); pending.delete(data.id);
        if (entry) data.error ? entry.reject(data.error) : entry.resolve(data.result);
      } else if (data.method === 'Runtime.exceptionThrown') exceptions.push(data.params.exceptionDetails.exception?.description || data.params.exceptionDetails.text);
    };
    const send = (method, params = {}) => new Promise((resolve, reject) => {
      const id = ++callId; pending.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params }));
    });
    const evaluate = async (expression) => {
      const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
      assert(!result.exceptionDetails, result.exceptionDetails?.exception?.description || JSON.stringify(result.exceptionDetails));
      return result.result.value;
    };
    await send('Runtime.enable'); await send('Page.enable');
    await send('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'no-preference'}]});
    await send('Emulation.setDeviceMetricsOverride', {width:1440,height:960,deviceScaleFactor:1,mobile:false});
    await send('Page.addScriptToEvaluateOnNewDocument', {source:"if (!localStorage.getItem('tts_explain_enabled')) localStorage.setItem('tts_explain_enabled','0');"});
    await send('Page.navigate', { url });
    const wait = async expression => {
      for (let i=0; i<350; i++) { if (await evaluate(expression)) return; await delay(20); }
      throw new Error('State deadline exceeded: '+expression);
    };
    await wait("document.body?.dataset.ready === 'true'");
    const install = async () => evaluate(`(async()=>{
      window.storeModule=await import('/conversations.js');
      window.api=await import('/api.js'); window.copilot=await import('/copilot.js');
      window.store=new storeModule.ConversationStore(localStorage,api.getClientId());
      window.wav=Uint8Array.from(atob('${wav.toString('base64')}'),c=>c.charCodeAt(0));
      window.requests=[]; window.nativeFetch=fetch;
      window.fetch=(url,options={})=>{
        const path=new URL(url,location.href).pathname;
        if(!path.startsWith('/api/tts')&&!path.startsWith('/api/explain'))return nativeFetch(url,options);
        return new Promise((resolve,reject)=>{
          requests.push({path,body:options.body?JSON.parse(options.body):null,headers:options.headers,resolve,reject});
          options.signal?.addEventListener('abort',()=>reject(new DOMException('Aborted','AbortError')),{once:true});
        });
      };
      window.take=(path,text)=>{const i=requests.findIndex(r=>r.path===path&&(!text||r.body?.text===text));if(i<0)throw new Error('Missing request '+path+' '+text);return requests.splice(i,1)[0];};
      window.json=(data,status=200)=>new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json'}});
      window.resolveTTS=(text,key='c'.repeat(64))=>take('/api/tts',text).resolve(new Response(wav,{headers:{'Content-Type':'audio/wav','X-Cache-Key':key}}));
      window.resolveAI=(text)=>take('/api/explain',text).resolve(json({explain_key:'key-'+text,explanation:'解说：'+text,cached:true,messages:[]}));
      window.submit=text=>{const input=document.getElementById('textInput');input.value=text;input.dispatchEvent(new Event('input'));document.getElementById('generateBtn').click();};
      window.click=id=>document.getElementById(id).click();
      window.select=id=>document.querySelector('[data-conversation-id="'+id+'"]').click();
      window.current=()=>store.get(localStorage.getItem('tts_active_conversation:'+api.getClientId()));
      window.change=(id,value)=>{const el=document.getElementById(id);if(el.type==='checkbox')el.checked=value;else el.value=value;el.dispatchEvent(new Event('change'));};
      window.confirm=()=>true;
    })()`);
    await install();
    assert.equal(await evaluate("store.list()[0].title"), '历史记录');
    assert.equal(await evaluate("document.querySelectorAll('.message-pair').length"), 2);
    assert.equal(await evaluate('requests.length'), 0);
    console.log('PASS legacy history migrates with automatic AI disabled');

    await evaluate("click('newConversationBtn');window.firstId=current().id;submit('こんにちは。今日はいい天気ですね。');submit('東京の小さな喫茶店で、ゆっくり本を読みます。');");
    assert.equal(await evaluate("document.querySelectorAll('.user-message').length"), 2);
    assert.equal(await evaluate("document.querySelectorAll('.pending-dot').length"), 2);
    await evaluate("click('newConversationBtn');window.secondId=current().id;submit('別の会話です。');resolveTTS('東京の小さな喫茶店で、ゆっくり本を読みます。','d'.repeat(64));resolveTTS('こんにちは。今日はいい天気ですね。');");
    await wait("store.get(firstId).messages.every(m=>m.audio.status==='ready')");
    assert.equal(await evaluate("document.querySelector('.user-message').textContent"), '別の会話です。');
    assert.equal(await evaluate("current().messages[0].audio.status"), 'pending');
    await evaluate("take('/api/tts','別の会話です。').resolve(json({detail:'模拟服务失败'},502));");
    await wait("!!document.querySelector('.retry-audio')");
    assert.equal(await evaluate("current().messages[0].text"), '別の会話です。');
    await evaluate("change('voiceSelect','ja-JP-KeitaNeural');document.querySelector('.retry-audio').click();");
    assert.equal(await evaluate("take('/api/tts','別の会話です。').body.voice"), 'ja-JP-NanamiNeural');
    // The assertion above consumes the deferred. Keep this attempt pending to test recovery on refresh.
    console.log('PASS consecutive sends, reverse completion order, background ownership and per-card retry');

    await send('Page.reload');
    await wait("document.body?.dataset.ready === 'true'");
    await install();
    assert.equal(await evaluate("document.querySelectorAll('.retry-audio').length"), 1);
    assert.equal(await evaluate("store.list().length"), 3);
    await evaluate("window.firstId=store.list().find(c=>c.messages.length===2&&c.title!=='历史记录').id;window.secondId=current().id;select(firstId);");
    assert.equal(await evaluate("document.querySelectorAll('.user-message').length"), 2);
    await evaluate("document.querySelector('.audio-action').click();take('/api/tts/'+'c'.repeat(64)).resolve(json({detail:'expired'},404));");
    await wait("document.querySelector('.retry-audio')?.textContent.includes('重新生成')");
    assert.equal(await evaluate("current().messages[0].text"), 'こんにちは。今日はいい天気ですね。');
    await evaluate("document.querySelector('.retry-audio').click();resolveTTS('こんにちは。今日はいい天気ですね。');");
    await wait("current().messages[0].audio.status==='ready'");
    assert.equal(await evaluate("current().messages.length"), 2);
    await evaluate("document.querySelector('.audio-action:not([hidden])').click();take('/api/tts/'+'d'.repeat(64)).resolve(new Response(wav,{headers:{'Content-Type':'audio/wav'}}));");
    await wait("[...document.querySelectorAll('audio')].every(a=>!!a.src)");
    await evaluate("(async()=>{const audio=[...document.querySelectorAll('audio')];audio.forEach(a=>a.loop=true);await audio[0].play();await audio[1].play();})()");
    assert.equal(await evaluate("document.querySelectorAll('audio')[0].paused"), true);
    assert.equal(await evaluate("document.querySelectorAll('audio')[1].paused"), false);
    await evaluate("document.querySelectorAll('audio').forEach(a=>a.pause())");
    console.log('PASS refresh recovery, cache expiry regeneration and mutually exclusive playback');

    await evaluate("change('explainToggle',true)");
    assert.equal(await evaluate("requests.filter(r=>r.path==='/api/explain').at(-1).body.text"), '東京の小さな喫茶店で、ゆっくり本を読みます。');
    await evaluate("window.oldAI=take('/api/explain');if(oldAI.body.context_id!==current().id+'_'+current().messages.at(-1).id)throw new Error('Missing message context');document.getElementById('textInput').value='未发送的草稿';document.getElementById('textInput').dispatchEvent(new Event('input'));click('aiPanelBtn');click('aiPanelBtn');");
    assert.equal(await evaluate("requests.filter(r=>r.path==='/api/explain').length"), 0);
    await evaluate("select(secondId);window.newAI=take('/api/explain');oldAI.resolve(json({explain_key:'old',explanation:'STALE_RESULT',cached:true,messages:[]}));newAI.resolve(json({explain_key:'new',explanation:'当前会话的解说',cached:true,messages:[]}));");
    await wait("document.getElementById('explainMessages').textContent.includes('当前会话的解说')");
    assert.equal(await evaluate("document.getElementById('explainMessages').textContent.includes('STALE_RESULT')"), false);
    await evaluate("submit('新しい文章です。');window.oldTextAI=take('/api/explain');submit('最新の文章です。');resolveAI('最新の文章です。');oldTextAI.resolve(json({explain_key:'stale',explanation:'OLD_TEXT',cached:true,messages:[]}));");
    await wait("document.getElementById('explainMessages').textContent.includes('最新の文章です。')");
    assert.equal(await evaluate("document.getElementById('explainMessages').textContent.includes('OLD_TEXT')"), false);
    await evaluate("change('explainToggle',false);click('newConversationBtn');");
    assert.equal(await evaluate("document.getElementById('explainRetryBtn').disabled"), true);
    assert.equal(await evaluate("requests.filter(r=>r.path==='/api/explain').length"), 0);
    console.log('PASS AI binds sent text only; drafts and panel visibility cause no requests; late results cannot overwrite new context');

    await evaluate("window.deletedId=current().id;submit('即将删除');document.querySelector('[data-delete-id=\"'+deletedId+'\"]').click();resolveTTS('即将删除');");
    await delay(50);
    assert.equal(await evaluate("store.get(deletedId)"), null);
    console.log('PASS deleting a pending conversation never resurrects it');

    await evaluate("click('newConversationBtn');window.scrollId=current().id;for(let i=0;i<12;i++)submit('滚动测试 '+i);document.getElementById('messageList').scrollTop=0;window.beforeScroll=document.getElementById('messageList').scrollTop;resolveTTS('滚动测试 11');");
    await wait("current().messages[11].audio.status==='ready'");
    assert.equal(await evaluate("document.getElementById('messageList').scrollTop"), 0);
    assert.equal(await evaluate("document.getElementById('jumpToLatestBtn').hidden"), false);
    await evaluate("click('jumpToLatestBtn');");
    assert.equal(await evaluate("document.getElementById('jumpToLatestBtn').hidden"), true);
    console.log('PASS updates preserve old-message reading position, with explicit jump to latest');

    await evaluate("window.originalSetItem=Storage.prototype.setItem;Storage.prototype.setItem=function(k,v){if(k.startsWith('tts_conversations_v1:'))throw new DOMException('Quota','QuotaExceededError');return originalSetItem.call(this,k,v)};window.beforeCount=current().messages.length;submit('不能丢失的草稿');");
    assert.equal(await evaluate("document.getElementById('textInput').value"),'不能丢失的草稿');
    assert.equal(await evaluate("current().messages.length===beforeCount"),true);
    assert.equal(await evaluate("document.getElementById('errorMessage').textContent.includes('保存失败')"),true);
    await evaluate("Storage.prototype.setItem=originalSetItem;click('errorCloseBtn')");
    console.log('PASS failed persistence retains the unsent draft');

    await evaluate("select(firstId);change('explainToggle',true);take('/api/explain').resolve(json({explain_key:'demo',explanation:'### 中文翻译\\n在东京的一家小咖啡店里，悠闲地读书。\\n\\n### 语法笔记\\n**で · 动作发生的场所**\\n\\n「喫茶店で」说明读书发生的地点。\\n\\n**ゆっくり · 慢慢地、从容地**\\n\\n修饰后面的动词「読みます」，表达放松、悠闲的状态。\\n\\n### 重点词汇\\n- **喫茶店（きっさてん）**：咖啡店\\n- **読む（よむ）**：阅读',cached:true,messages:[]}));");
    await wait("document.getElementById('explainMessages').textContent.includes('中文翻译')");
    const screenshotDir=path.join(root,'docs/screenshots');fs.mkdirSync(screenshotDir,{recursive:true});
    const settlePanels=()=>evaluate("Promise.all([...document.querySelectorAll('.conversation-sidebar,.ai-sidebar,.drawer-backdrop')].flatMap(el=>el.getAnimations()).map(a=>a.finished.catch(()=>{})))");
    const capture=async name=>{await settlePanels();const result=await send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(screenshotDir,name),Buffer.from(result.data,'base64'));};
    // Load both audio controls for the visual fixture without external providers.
    await evaluate("document.querySelectorAll('.audio-action').forEach(b=>b.click());requests.filter(r=>r.path.startsWith('/api/tts/')).forEach(r=>r.resolve(new Response(wav,{headers:{'Content-Type':'audio/wav'}})));requests=requests.filter(r=>!r.path.startsWith('/api/tts/'));document.getElementById('textInput').value='';document.getElementById('textInput').dispatchEvent(new Event('input'));");
    await wait("[...document.querySelectorAll('audio')].every(a=>a.readyState>=2)");
    await evaluate("document.querySelectorAll('audio').forEach(a=>a.pause())");
    await capture('chat-desktop.png');
    const width=await evaluate("document.getElementById('chatMain').clientWidth");
    const explanationCount=await evaluate("requests.filter(r=>r.path==='/api/explain').length");
    await evaluate("click('historyBtn');click('aiPanelBtn');");
    await settlePanels();
    assert(await evaluate("document.getElementById('chatMain').clientWidth")>width);
    assert.equal(await evaluate("requests.filter(r=>r.path==='/api/explain').length"), explanationCount);
    await capture('chat-collapsed.png');
    await evaluate("click('historyBtn');click('aiPanelBtn');");
    await evaluate("(async()=>{const settings=await import('/settings.js');settings.applyTheme('dark')})()");
    await capture('chat-dark.png');
    await evaluate("(async()=>{const settings=await import('/settings.js');settings.applyTheme('light')})()");
    await send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});
    await wait("document.getElementById('conversationSidebar').hidden && document.getElementById('explainSection').hidden");
    assert.equal(await evaluate("document.documentElement.scrollWidth<=innerWidth"), true);
    await capture('chat-mobile.png');
    await evaluate("click('historyBtn')");
    assert.equal(await evaluate("document.getElementById('chatMain').inert"), true);
    assert.equal(await evaluate("document.getElementById('explainSection').hidden"), true);
    await capture('chat-mobile-sessions.png');
    await evaluate("click('sidebarCloseBtn');click('aiPanelBtn')");
    assert.equal(await evaluate("document.getElementById('conversationSidebar').hidden"), true);
    await capture('chat-mobile-ai.png');
    await evaluate("document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))");
    assert.equal(await evaluate("document.getElementById('chatMain').inert"), false);
    assert.equal(await evaluate("document.activeElement.id"), 'aiPanelBtn');
    console.log('PASS desktop expansion, dark theme, narrow drawers and no horizontal overflow; screenshots saved');
    stallCatalog=true;
    await send('Page.reload');
    await wait("document.body?.dataset.ready==='true'");
    assert.equal(await evaluate("document.querySelectorAll('.user-message').length"),2);
    await evaluate("document.getElementById('textInput').value='works';document.getElementById('textInput').dispatchEvent(new Event('input'))");
    assert.equal(await evaluate("document.getElementById('generateBtn').disabled"),false);
    console.log('PASS a stalled optional AI catalog cannot block restored conversations or TTS');
    assert.deepEqual(exceptions, [], 'No uncaught browser exceptions');
    await send('Browser.close'); await browserExit;
  } finally {
    socket?.close();
    if (browser && browser.exitCode === null) { browser.kill(); await Promise.race([browserExit, delay(3000)]); }
    server.closeAllConnections(); await new Promise((resolve) => server.close(resolve));
    assert.equal(path.dirname(path.resolve(profile)), path.resolve(os.tmpdir()));
    assert(path.basename(profile).startsWith('tts-async-browser-'));
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
