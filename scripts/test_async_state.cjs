// Offline browser regressions for request ownership and deadlines. No live providers.
// Node 22+ and Chrome/Edge are required; CHROME_PATH can select the executable.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { launchBrowser, delay } = require('./browser_test_helper.cjs');

const root = path.resolve(__dirname, '..');
const keys = { A: 'a'.repeat(64), B: 'b'.repeat(64) };
let catalogTimeout = 300;
let timestamp = new Date().toISOString();
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
    voices: [{ id: 'ja-JP-NanamiNeural', name: 'Nanami' }],
  }]);
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
let browser;
let failures = 0;

(async () => {
  try {
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${server.address().port}/`;
    browser = await launchBrowser({
      profilePrefix: 'tts-async-browser-', args: ['--autoplay-policy=no-user-gesture-required'],
      exceptionDescriptions: true, startupInterval: 25,
    });
    const { send, evaluate, exceptions } = browser;
    const act = (statements) => evaluate(`(async () => { ${statements} })()`);
    // Poll only for observed browser lifecycle/state; response ordering uses explicit deferreds.
    const wait = async (expression) => {
      const deadline = Date.now() + 7000;
      while (Date.now() < deadline) {
        if (await evaluate(expression)) return;
        await delay(15);
      }
      throw new Error('State deadline exceeded: ' + expression + '\n' + JSON.stringify(await evaluate('({url:location.href,html:document.documentElement.outerHTML.slice(0,150),mode:document.getElementById("explainThinkingSelect")?.value,counter:document.getElementById("charCounter")?.textContent,history:document.getElementById("historyList")?.innerHTML,exceptions:[]})')));
    };
    await send('Runtime.enable'); await send('Page.enable');
    await send('Emulation.setTimezoneOverride', { timezoneId: 'Asia/Singapore' });
    await send('Page.addScriptToEvaluateOnNewDocument', { source: `
      localStorage.setItem('tts_explain_enabled','0'); localStorage.setItem('tts_explain_model','m1');
      localStorage.setItem('tts_explain_mode','direct'); localStorage.setItem('tts_explain_lang','zh');
    ` });
    let testNumber = 0;
    const setup = async () => {
      const query = '?case=' + (++testNumber);
      await send('Page.navigate', { url: url + query });
      await wait(`location.search===${JSON.stringify(query)} && document.body?.dataset.ready==='true' && document.getElementById('explainThinkingSelect')?.value==='direct' && document.getElementById('charCounter')?.textContent.includes('1000')`);
      await evaluate(`(async () => {
        window.copilot=await import('/copilot.js'); window.api=await import('/api.js');
        window.json=(data,status=200,headers={})=>new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json',...headers}});
        window.explanation=(text,cached=true,messages=[])=>json({explain_key:'key-'+text,explanation:'explanation-'+text,lang:'zh',model_id:'m1',mode_id:'direct',upstream_model:'fixture',cached,messages});
        window.requests=[]; window.nativeFetch=fetch;
        window.fetch=(url,options={})=>{
          const target=new URL(url,location.href);
          if(!target.pathname.startsWith('/api/explain') && !target.pathname.startsWith('/api/tts')) return nativeFetch(url,options);
          return new Promise((resolve,reject)=>{
            const entry={url:target,path:target.pathname,method:options.method||'GET',body:options.body?JSON.parse(options.body):null,resolve,reject,signal:options.signal};
            requests.push(entry);
            options.signal?.addEventListener('abort',()=>reject(new DOMException('Aborted','AbortError')),{once:true});
          });
        };
        window.take=(path,method='GET')=>{const index=requests.findIndex(r=>r.path===path&&r.method===method);if(index<0)throw new Error('Missing deferred '+method+' '+path);return requests.splice(index,1)[0];};
        window.change=(id,value)=>{const el=document.getElementById(id);if(el.type==='checkbox')el.checked=value;else el.value=value;el.dispatchEvent(new Event('change'));};
        window.messages=()=>document.getElementById('explainMessages').textContent;
      })()`);
    };
    const test = async (name, run) => {
      try { await setup(); await run(); console.log('PASS ' + name); }
      catch (error) { failures++; console.error('FAIL ' + name + '\n' + error.message); }
    };

    for (const configured of [300, null]) {
      catalogTimeout = configured;
      await test('Copilot deadline survives TTS deadline (' + (configured ?? 'legacy catalog') + ')', async () => {
        await act(`(() => {
          const timers=new Map();let next=1000000;const original=setTimeout,originalClear=clearTimeout;
          window.setTimeout=(fn,ms,...args)=>{if(ms<10000)return original(fn,ms,...args);const id=next++;timers.set(id,{fn:()=>fn(...args),ms});return id;};
          window.clearTimeout=(id)=>{if(timers.has(id))timers.delete(id);else originalClear(id);};
          window.advance=(ms)=>{for(const [id,timer] of timers)if(timer.ms<=ms){timers.delete(id);timer.fn();}};
          window.job=copilot.requestExplanation('A',{manual:true});window.request=take('/api/explain','POST');
          advance(45000);
        })()`);
        const aborted = await evaluate('request.signal.aborted');
        assert.equal(aborted, false, 'Copilot must remain alive after the 45-second TTS deadline');
        await act(`request.resolve(explanation('A'));await job;`);
        assert.equal(await evaluate('copilot.getCurrentExplainKey()'), 'key-A');
        // The advertised deadline includes the backend queue, plus a response transfer allowance.
        await act(`window.job=copilot.requestExplanation('B',{manual:true});window.request=take('/api/explain','POST');advance(${configured === null ? 194999 : 314999});`);
        assert.equal(await evaluate('request.signal.aborted'), false);
        await act(`advance(${configured === null ? 195000 : 315000});await job;`);
        assert.equal(await evaluate('request.signal.aborted'), true, 'Copilot must still enforce its own deadline');
        assert.equal(await evaluate('api.getRequestTimeoutMs()'), 45000, 'Copilot budget must not lengthen TTS requests');
      });
    }
    catalogTimeout = 300;

    await test('Older explanation finally preserves newer loading', async () => {
      await act(`window.a=copilot.requestExplanation('A',{manual:true});window.ra=take('/api/explain','POST');window.b=copilot.requestExplanation('B',{manual:true});window.rb=take('/api/explain','POST');ra.resolve(explanation('A'));await a;`);
      assert.equal(await evaluate('copilot.isExplainLoading()'), true);
      assert.equal(await evaluate('document.getElementById("explainSendBtn").disabled'), true);
      await act(`rb.resolve(explanation('B'));await b;`);
      assert.equal(await evaluate('copilot.getCurrentExplainKey()'), 'key-B');
    });
    await test('A-B-A retry cannot accept first A response', async () => {
      await act(`window.a1=copilot.requestExplanation('A',{manual:true});window.ra1=take('/api/explain','POST');window.b=copilot.requestExplanation('B',{manual:true});window.rb=take('/api/explain','POST');window.a2=copilot.requestExplanation('A',{manual:true});window.ra2=take('/api/explain','POST');ra1.resolve(explanation('old-A'));await a1;`);
      assert.equal(await evaluate('copilot.getCurrentExplainKey()'), null);
      assert.equal(await evaluate('copilot.isExplainLoading()'), true);
      await act(`rb.resolve(explanation('B'));await b;ra2.resolve(explanation('latest-A'));await a2;`);
      assert.equal(await evaluate('copilot.getCurrentExplainKey()'), 'key-latest-A');
    });
    for (const action of ['reset', 'close', 'lang', 'model', 'mode']) {
      await test('Pending explanation is invalidated by ' + action, async () => {
        await act(`window.job=copilot.requestExplanation('A',{manual:true});window.request=take('/api/explain','POST');`);
        await evaluate({ reset: 'copilot.resetExplanation()', close: `change('explainToggle',false)`, lang: `change('explainLangSelect','en')`, model: `change('explainModelSelect','m2')`, mode: `change('explainThinkingSelect','deep')` }[action]);
        await act(`request.resolve(explanation('stale'));await job;`);
        assert.equal(await evaluate('copilot.getCurrentExplainKey()'), null);
        assert.equal(await evaluate(`messages().includes('explanation-stale')`), false);
        assert.equal(await evaluate('copilot.isExplainLoading()'), false);
      });
    }
    await test('Editing an unsent draft preserves the explanation for sent text', async () => {
      await act(`window.a=copilot.requestExplanation('A',{manual:true});window.ra=take('/api/explain','POST');`);
      await act(`document.getElementById('textInput').value='B';document.getElementById('textInput').dispatchEvent(new Event('input'));`);
      assert.equal(await evaluate('copilot.isExplainLoading()'), true);
      await act(`ra.resolve(explanation('A'));await a;`);
      assert.equal(await evaluate('copilot.getCurrentExplainText()'), 'A');
      assert.equal(await evaluate('copilot.getCurrentExplainKey()'), 'key-A');
    });
    await test('Visible explanation retry targets sent text and respects loading', async () => {
      await act(`copilot.setCurrentExplainText('A');copilot.renderExplainEmpty();document.getElementById('explainEmptyStartBtn').click();window.request=take('/api/explain','POST');`);
      assert.equal(await evaluate('request.body.text'), 'A');
      assert.equal(await evaluate('document.getElementById("explainSendBtn").disabled'), true);
      await act(`request.resolve(explanation('A'));`);
      await wait(`copilot.getCurrentExplainKey()==='key-A' && !copilot.isExplainLoading()`);
      assert.equal(await evaluate(`document.querySelector('.explain-retry-bubble-btn').disabled`), false);
      await act(`document.querySelector('.explain-retry-bubble-btn').click();window.retry=take('/api/explain','POST');`);
      assert.equal(await evaluate('retry.body.text'), 'A');
      assert.equal(await evaluate('copilot.isExplainLoading()'), true);
      await act(`retry.resolve(explanation('retried-A'));`);
      await wait(`copilot.getCurrentExplainKey()==='key-retried-A' && !copilot.isExplainLoading()`);
    });
    for (const kind of ['answer', 'error']) {
      await test('Stale chat ' + kind + ' cannot enter replacement session', async () => {
        await act(`window.job=copilot.requestExplanation("A",{manual:true});take('/api/explain','POST').resolve(explanation('A'));await job;document.getElementById('explainChatInput').value='question A';window.chat=copilot.sendExplainChat();window.oldChat=take('/api/explain/chat','POST');window.job=copilot.requestExplanation("B",{manual:true});take('/api/explain','POST').resolve(explanation('B'));await job;`);
        await act(kind === 'answer' ? `oldChat.resolve(json({explain_key:'key-A',answer:'stale-chat',model_id:'m1',mode_id:'direct'}));await chat;` : `oldChat.reject(new Error('stale-chat'));await chat;`);
        assert.equal(await evaluate('copilot.getCurrentExplainKey()'), 'key-B');
        assert.equal(await evaluate(`messages().includes('stale-chat')`), false);
      });
    }
    await test('Older chat finally preserves newer chatPending', async () => {
      await act(`window.job=copilot.requestExplanation("A",{manual:true});take('/api/explain','POST').resolve(explanation('A'));await job;document.getElementById('explainChatInput').value='first';window.first=copilot.sendExplainChat();window.r1=take('/api/explain/chat','POST');window.job=copilot.requestExplanation("B",{manual:true});take('/api/explain','POST').resolve(explanation('B'));await job;document.getElementById('explainChatInput').value='second';window.second=copilot.sendExplainChat();`);
      assert.equal(await evaluate(`requests.some(r=>r.path==='/api/explain/chat')`), true, 'Replacement session must release obsolete chat pending state');
      await act(`window.r2=take('/api/explain/chat','POST');r1.reject(new Error('old'));await first;`);
      assert.equal(await evaluate('copilot.isChatPending()'), true);
      await act(`r2.resolve(json({explain_key:'key-B',answer:'',model_id:'m1',mode_id:'direct'}));await second;`);
      assert.equal(await evaluate('copilot.isChatPending()'), false);
    });
    for (const failure of ['404', 'network']) {
      await test('Stale explanation ' + failure + ' preserves current session', async () => {
        await act(`window.a=copilot.requestExplanation("A",{manual:true});window.ra=take('/api/explain','POST');window.b=copilot.requestExplanation("B",{manual:true});take('/api/explain','POST').resolve(explanation('B'));await b;`);
        await act(failure === '404' ? `ra.resolve(json({detail:'missing'},404));await a;` : `ra.reject(new Error('offline'));await a;`);
        assert.equal(await evaluate('copilot.getCurrentExplainKey()'), 'key-B');
        assert.equal(await evaluate(`messages().includes('explanation-B')`), true);
      });
    }
    await test('Cancelled reveal cannot append old session messages', async () => {
      await act(`window.frames=new Map();let next=1;window.requestAnimationFrame=fn=>{const id=next++;frames.set(id,fn);return id;};window.cancelAnimationFrame=id=>frames.delete(id);window.a=copilot.requestExplanation('A',{manual:true});take('/api/explain','POST').resolve(explanation('A',false,[{role:'user',content:'orphan-message'}]));`);
      await wait('frames.size>0');
      await act(`window.b=copilot.requestExplanation('B',{manual:true});window.rb=take('/api/explain','POST');await a;`);
      assert.equal(await evaluate(`messages().includes('orphan-message')`), false);
      assert.equal(await evaluate('copilot.isExplainLoading()'), true);
      await act(`rb.resolve(explanation('B'));await b;`);
      assert.equal(await evaluate('copilot.getCurrentExplainKey()'), 'key-B');
      assert.equal(await evaluate('frames.size'), 0);
    });

    // Conversation/player ownership is exercised in test_chat.cjs. This suite
    // keeps the independent Copilot deadline, session and reveal regressions.
    assert.deepEqual(exceptions, [], 'No uncaught browser exceptions');
    if (failures) throw new Error(`${failures} async state regression(s) failed`);
  } finally {
    try {
      await browser?.close();
    } finally {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
