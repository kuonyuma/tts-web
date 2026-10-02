const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { launchBrowser, delay } = require('./browser_test_helper.cjs');

const root = path.resolve(__dirname, '..');

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
  if (url.pathname === '/api/copilot/models') return json({ models: [{
    id: 'deepseek-flash', name: 'DeepSeek Flash', default: true,
    modes: [
      { id: 'direct', name: '直接回答', description: '速度优先', quota_weight: 1 },
      { id: 'deep', name: '深度思考', description: '复杂长句', quota_weight: 5 },
    ],
  }] });
  if (url.pathname === '/api/explain') {
    return json({ detail: 'Gemini 服务需要 API Key。' }, 400);
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
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${server.address().port}/`;
    browser = await launchBrowser({
      profilePrefix: 'tts-theme-test-', args: ['--autoplay-policy=no-user-gesture-required'],
      exceptionDescriptions: true, exceptionDetailsAsJson: true,
      waitAttempts: 160, waitMessage: 'UI did not reach expected state: ',
    });
    const { send, evaluate, exceptions, wait } = browser;
    await send('Runtime.enable');
    await send('Page.enable');
    console.log('Browser system reduced-motion preference: '+await evaluate("matchMedia('(prefers-reduced-motion: reduce)').matches"));
    await send('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'no-preference'}]});
    await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await send('Page.navigate', { url });

    await wait('document.readyState === "complete"');
    await delay(300);

    await wait("document.body?.dataset.ready==='true'");
    assert.equal(await evaluate("document.getElementById('explainModelSelect').value"),'deepseek-flash');
    assert.deepEqual(await evaluate("[...document.getElementById('explainThinkingSelect').options].map(o=>o.value)"),['direct','deep']);
    console.log('PASS model catalog drives reasoning modes');
    await evaluate("document.getElementById('historyBtn').click();document.getElementById('aiPanelBtn').click();document.getElementById('settingsBtn').click()");
    assert.equal(await evaluate("document.getElementById('settingsModal').style.display"),'flex');
    assert.deepEqual(await evaluate("[...document.querySelectorAll('.theme-option-btn')].map(b=>b.dataset.theme).sort()"),['dark','light']);
    for(const theme of ['dark','light']) {
      await evaluate(`document.querySelector('.theme-option-btn[data-theme="${theme}"]').click()`);
      assert.equal(await evaluate("localStorage.getItem('tts_theme')"),theme);
      assert.equal(await evaluate(`document.querySelector('.theme-option-btn[data-theme="${theme}"]').getAttribute('aria-checked')`),'true');
    }
    await evaluate("document.getElementById('modalCloseBtn').click()");
    assert.equal(await evaluate("document.getElementById('settingsModal').style.display"),'none');
    await evaluate("document.getElementById('settingsBtn').click();document.getElementById('geminiApiKeyInput').value='fixture-key';document.getElementById('saveKeyBtn').click()");
    assert.equal(await evaluate("getComputedStyle(document.getElementById('keyStatusBadge')).display==='none'"),false);
    await evaluate("document.getElementById('settingsBtn').click();document.getElementById('clearKeyBtn').click();document.getElementById('modalCloseBtn').click()");
    assert.equal(await evaluate("getComputedStyle(document.getElementById('keyStatusBadge')).display"),'none');
    console.log('PASS settings remain accessible with both sidebars collapsed; light/dark theme controls');
    for(const theme of ['default','sakura']) {
      await evaluate(`localStorage.setItem('tts_theme','${theme}')`);
      await send('Page.reload');
      await wait("document.body?.dataset.ready==='true' && document.documentElement.dataset.theme==='light'");
      assert.equal(await evaluate("localStorage.getItem('tts_theme')"),'light');
    }
    assert.equal(await evaluate("document.getElementById('conversationSidebar').hidden"),true);
    assert.equal(await evaluate("document.getElementById('explainSection').hidden"),true);
    console.log('PASS legacy theme migration and collapsed sidebar preferences survive reload');
    await evaluate(`window.sampleTransition=(buttonId,panelId)=>{
      const panel=document.getElementById(panelId),main=document.getElementById('chatMain');
      const read=()=>({width:main.getBoundingClientRect().width,x:panel.getBoundingClientRect().x,opacity:Number(getComputedStyle(panel).opacity)});
      const before=read(); document.getElementById(buttonId).click();
      const animations=panel.getAnimations();
      if(!animations.length)throw new Error('Sidebar must animate instead of switching display instantly: '+JSON.stringify({before,after:read(),transition:getComputedStyle(panel).transition,ready:document.body.dataset.ready,hidden:panel.hidden,display:getComputedStyle(panel).display}));
      animations.forEach(a=>{a.pause();a.currentTime=a.effect.getTiming().duration/2});
      const middle=read(); animations.forEach(a=>a.finish());
      return {before,middle,after:read(),inert:panel.inert,visibility:getComputedStyle(panel).visibility};
    }`);
    for(const [button,panel] of [['historyBtn','conversationSidebar'],['aiPanelBtn','explainSection']]) {
      const opening=await evaluate(`sampleTransition('${button}','${panel}')`);
      assert(opening.before.width>opening.middle.width && opening.middle.width>opening.after.width,'Workspace shrinks continuously while opening');
      assert.equal(opening.visibility,'visible');
      const closing=await evaluate(`sampleTransition('${button}','${panel}')`);
      assert(closing.before.width<closing.middle.width && closing.middle.width<closing.after.width,'Workspace expands continuously while closing');
      assert.equal(closing.visibility,'hidden');
      assert.equal(closing.inert,true);
    }
    console.log('PASS both desktop sidebars animate in both directions with continuous workspace resizing');

    await send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});
    await evaluate("document.getElementById('historyBtn').click()");
    assert.equal(await evaluate("document.getElementById('chatMain').inert"),true);
    assert.equal(await evaluate("document.documentElement.scrollWidth<=innerWidth"),true);
    await evaluate("document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))");
    assert.equal(await evaluate("document.getElementById('chatMain').inert"),false);
    console.log('PASS mobile drawer and Escape restore the workspace');
    await evaluate("Promise.all(document.getAnimations().map(a=>a.finished.catch(()=>{})))");
    for(const [button,panel] of [['historyBtn','conversationSidebar'],['aiPanelBtn','explainSection']]) {
      const opening=await evaluate(`sampleTransition('${button}','${panel}')`);
      assert.equal(opening.before.width,opening.after.width,'Drawers do not squeeze the workspace');
      assert(opening.middle.x>Math.min(opening.before.x,opening.after.x) && opening.middle.x<Math.max(opening.before.x,opening.after.x),'Drawer slides rather than jumping');
      assert.equal(await evaluate("document.getElementById('chatMain').inert"),true);
      const closing=await evaluate(`sampleTransition('${panel==='conversationSidebar'?'sidebarCloseBtn':'aiCloseBtn'}','${panel}')`);
      assert(closing.middle.x>Math.min(closing.before.x,closing.after.x) && closing.middle.x<Math.max(closing.before.x,closing.after.x));
      assert.equal(await evaluate('document.activeElement.id'),button);
    }
    await evaluate(`(async()=>{
      const button=document.getElementById('historyBtn'),panel=document.getElementById('conversationSidebar');
      for(let i=0;i<4;i++){button.click();panel.getBoundingClientRect();await new Promise(requestAnimationFrame);}
      await Promise.all(document.getAnimations().map(a=>a.finished.catch(()=>{})));
    })()`);
    assert.equal(await evaluate("getComputedStyle(document.getElementById('conversationSidebar')).visibility"),'hidden');
    assert.equal(await evaluate("getComputedStyle(document.getElementById('sidebarBackdrop')).pointerEvents"),'none');
    console.log('PASS mobile sliding, focus restoration and rapid toggle reversal');
    await send('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
    await evaluate("document.getElementById('aiPanelBtn').click();document.getElementById('explainSection').getBoundingClientRect()");
    assert.equal(await evaluate("document.getElementById('explainSection').getAnimations().length"),0);
    assert.equal(await evaluate("document.getElementById('sidebarBackdrop').getAnimations().length"),0);
    console.log('PASS reduced-motion preference disables sidebar and backdrop animation');
    assert.equal(await evaluate("!!document.getElementById('motionSelect')"),true,'Settings must let the user explicitly enable motion');
    await evaluate("document.getElementById('aiCloseBtn').click();document.getElementById('settingsBtn').click();var motionOption=document.getElementById('motionSelect');motionOption.value='full';motionOption.dispatchEvent(new Event('change'));document.getElementById('modalCloseBtn').click()");
    const forced=await evaluate("sampleTransition('aiPanelBtn','explainSection')");
    assert(forced.middle.x>Math.min(forced.before.x,forced.after.x) && forced.middle.x<Math.max(forced.before.x,forced.after.x),'Explicit on overrides browser reduced-motion preference');
    await send('Page.reload');
    await wait("document.body?.dataset.ready==='true'");
    assert.equal(await evaluate("document.getElementById('motionSelect').value"),'full');
    assert.notEqual(await evaluate("getComputedStyle(document.getElementById('explainSection')).transition"),'none');
    await evaluate("document.getElementById('settingsBtn').click();var motionOption=document.getElementById('motionSelect');motionOption.value='reduced';motionOption.dispatchEvent(new Event('change'));document.getElementById('modalCloseBtn').click()");
    await send('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'no-preference'}]});
    await evaluate("document.getElementById('aiPanelBtn').click();document.getElementById('explainSection').getBoundingClientRect()");
    assert.equal(await evaluate("document.getElementById('explainSection').getAnimations().length"),0);
    await evaluate("document.getElementById('aiCloseBtn').click();document.getElementById('settingsBtn').click();var motionOption=document.getElementById('motionSelect');motionOption.value='system';motionOption.dispatchEvent(new Event('change'));document.getElementById('modalCloseBtn').click()");
    assert.notEqual(await evaluate("getComputedStyle(document.getElementById('explainSection')).transition"),'none');
    await send('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
    await wait("document.getElementById('motionHint').textContent.includes('关闭')");
    assert.equal(await evaluate("getComputedStyle(document.getElementById('explainSection')).transition"),'none');
    console.log('PASS explicit motion setting overrides either system preference, persists, and system mode follows live changes');


    assert.deepEqual(exceptions, []);
    console.log('PASS all theme and sidebar tests passed with 0 exceptions');
  } finally {
    try {
      await browser?.close();
    } finally {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
  }
})().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
