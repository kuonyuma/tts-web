const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const load = name => import('data:text/javascript;base64,' + fs.readFileSync(path.join(__dirname, '../frontend', name)).toString('base64'));
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const deferred = () => { let resolve, reject; const promise = new Promise((a,b) => { resolve=a; reject=b; }); return {promise,resolve,reject}; };
class Storage {
  data = new Map();
  get length() { return this.data.size; }
  key(i) { return [...this.data.keys()][i]; }
  getItem(k) { return this.data.get(k) ?? null; }
  setItem(k,v) { this.data.set(k,v); }
  removeItem(k) { this.data.delete(k); }
}
const record = (id='A', content='server', revision=1) => ({id,title:id,content,revision,created_at:'2026-01-01',updated_at:'2026-01-01',character_count:content.length});
(async () => {
  const { ArticleState } = await load('articles-state.js');
  const storage = new Storage();
  const requests = [];
  let remote = record();
  const api = {
    get: async id => record(id, remote.content, remote.revision), list:async()=>[],
    create: async body => ({...record(body.id),...body}),
    update: (id, body, signal) => { const d=deferred(); requests.push({id,body,signal,...d}); return d.promise; },
    remove: async()=>{},
  };
  const state = new ArticleState({api,storage,accountId:1,debounceMs:100000});
  const entry = await state.open('A');
  state.edit('A',{content:'first'});
  const saving = state.flush('A');
  await tick();
  state.edit('A',{content:'latest'});
  assert.equal(requests.length,1);
  requests[0].resolve(record('A','first',2));
  await tick();
  assert.equal(entry.content,'latest');
  assert.notEqual(entry.status,'saved');
  assert.equal(requests[1].body.content,'latest');
  assert.equal(requests[1].body.revision,2);
  requests[1].resolve(record('A','latest',3));
  await saving;
  assert.equal(entry.status,'saved');
  assert.equal(storage.getItem(state.draftKey('A')),null);
  console.log('PASS serialized saves acknowledge only matching edits');

  state.edit('A',{content:'offline'});
  const failure=state.flush('A'); await tick(); requests.at(-1).reject(new Error('offline')); await failure;
  assert.equal(entry.status,'error');
  assert.equal(JSON.parse(storage.getItem(state.draftKey('A'))).content,'offline');
  remote=record('A','other device',4);
  const restored=new ArticleState({api,storage,accountId:1,debounceMs:100000});
  const conflict=await restored.open('A');
  assert.equal(conflict.content,'offline'); assert.equal(conflict.status,'conflict');
  await restored.flush('A'); assert.equal(requests.length,3);
  await restored.resolve('A','server');
  assert.equal(conflict.content,'other device'); assert.equal(conflict.status,'saved');
  console.log('PASS failed draft protection and cross-device conflict resolution');

  const other=new ArticleState({api,storage,accountId:2,debounceMs:100000});
  assert.equal((await other.open('A')).content,'other device');
  state.edit('A',{content:'delete while saving'});
  const late=state.flush('A'); await tick(); const request=requests.at(-1);
  await state.remove('A'); assert.equal(request.signal.aborted,true);
  request.resolve(record('A','delete while saving',5)); await late;
  assert.equal(state.entries.has('A'),false); assert.equal(storage.getItem(state.draftKey('A')),null);
  console.log('PASS deletion cancels saves and late responses cannot restore entries');

  const b=await state.open('B'); state.edit('B',{content:'logout draft'});
  const logout=state.flush('B'); await tick(); const old=requests.at(-1);
  state.dispose(); assert.equal(old.signal.aborted,true);
  old.resolve(record('B','logout draft',5)); await logout;
  assert.equal(state.entries.size,0); assert.equal(b.status,'saving');
  assert.equal(JSON.parse(storage.getItem(state.draftKey('B'))).content,'logout draft');
  restored.dispose(); other.dispose();
  console.log('PASS logout invalidation preserves isolated draft without UI writes');

  // Refresh while offline must expose the protected text, then verify server revision on retry.
  let offline=true;
  storage.setItem('tts_article_draft_v1:account_3:C',JSON.stringify({title:'C',content:'offline refresh',revision:1,isNew:false}));
  const disconnected = new ArticleState({storage,accountId:3,debounceMs:100000,api:{...api,
    get:async()=>{if(offline)throw new Error('offline');return record('C','new device',2);},
  }});
  const recovered=await disconnected.open('C');
  assert.equal(recovered.content,'offline refresh');assert.equal(recovered.status,'error');
  offline=false;await disconnected.flush('C');
  assert.equal(recovered.status,'conflict');assert.equal(recovered.server.content,'new device');
  disconnected.dispose();
  console.log('PASS offline refresh exposes draft and verifies remote version before writing');

  const imeRequests=[];
  const ime=new ArticleState({storage:new Storage(),accountId:4,debounceMs:100000,api:{...api,
    update:async(id,body)=>{imeRequests.push(body);return record(id,body.content,body.revision+1);},
  }});
  await ime.open('IME');
  ime.edit('IME',{content:'にほん'},true);
  await ime.flushAll();
  assert.equal(imeRequests.length,0);
  ime.edit('IME',{content:'日本'},false);await ime.flushAll();
  assert.equal(imeRequests.length,1);assert.equal(imeRequests[0].content,'日本');
  ime.dispose();
  console.log('PASS IME intermediate text is protected locally and committed only after composition');

  const lost=deferred();const recoveryStorage=new Storage();let unsafeUpdates=0;
  const recoveryApi={...api,get:async()=>record('retry','other-device edit',5),
    create:()=>lost.promise,update:async()=>{unsafeUpdates++;return record('retry','latest local',6);},
  };
  const recovery=new ArticleState({storage:recoveryStorage,accountId:5,debounceMs:100000,api:recoveryApi});
  const newEntry=recovery.create('original title','initial content');
  const retrySave=recovery.flush(newEntry.id);
  recovery.edit(newEntry.id,{content:'latest local'});
  lost.resolve({...record(newEntry.id,'other-device edit',5),title:'other-device title'});
  await retrySave;
  assert.equal(unsafeUpdates,0);assert.equal(newEntry.status,'conflict');
  const afterReload=new ArticleState({storage:recoveryStorage,accountId:5,debounceMs:100000,api:recoveryApi});
  const again=await afterReload.open(newEntry.id);
  assert.equal(again.status,'conflict');assert.equal(again.content,'latest local');
  recovery.dispose();afterReload.dispose();
  console.log('PASS idempotent create response cannot overwrite remote changes even with concurrent local typing');

  const conflictStorage=new Storage();let overwriteCount=0;
  const conflictKey='tts_article_draft_v1:account_6:shared';
  conflictStorage.setItem(conflictKey,JSON.stringify({title:'shared',content:'local old',revision:1,isNew:false}));
  const conflictApi={...api,get:async()=>record('shared','new on server',2),update:async()=>{overwriteCount++;}};
  const firstConflict=new ArticleState({storage:conflictStorage,accountId:6,api:conflictApi,debounceMs:100000});
  assert.equal((await firstConflict.open('shared')).status,'conflict');
  firstConflict.edit('shared',{content:'edited conflict draft'});firstConflict.dispose();
  const secondConflict=new ArticleState({storage:conflictStorage,accountId:6,api:conflictApi,debounceMs:100000});
  const unresolved=await secondConflict.open('shared');await secondConflict.flush('shared');
  assert.equal(unresolved.status,'conflict');assert.equal(overwriteCount,0);
  assert.equal(unresolved.content,'edited conflict draft');
  secondConflict.dispose();
  console.log('PASS unresolved conflict survives edits, logout and a second refresh without silent overwrite');

  const choice=deferred();
  const resolutionStorage=new Storage();
  const resolution=new ArticleState({storage:resolutionStorage,accountId:7,debounceMs:100000,api:{...api,get:()=>choice.promise}});
  const changing=resolution.register(record('choose','local old',1));
  changing.dirty=true;changing.status='conflict';
  const resolving=resolution.resolve('choose','server');
  resolution.edit('choose',{content:'typed after choosing'});
  choice.resolve(record('choose','server choice',2));await resolving;
  assert.equal(changing.content,'typed after choosing');assert.equal(changing.dirty,true);
  assert.equal(changing.status,'conflict');
  resolution.dispose();
  console.log('PASS conflict resolution cannot discard edits made while reading the server');

  const sharedStorage=new Storage();
  const sharedApi={...api,get:async()=>record('same','server',1),update:async(id,body)=>record(id,body.content,body.revision+1)};
  const tabA=new ArticleState({storage:sharedStorage,accountId:8,draftOwner:'tab-A',api:sharedApi,debounceMs:100000});
  const tabB=new ArticleState({storage:sharedStorage,accountId:8,draftOwner:'tab-B',api:sharedApi,debounceMs:100000});
  await tabA.open('same');await tabB.open('same');
  tabA.edit('same',{content:'A unique offline draft'});
  tabB.edit('same',{content:'B saved'});await tabB.flush('same');
  assert.equal(JSON.parse(sharedStorage.getItem(tabA.draftKey('same'))).content,'A unique offline draft');
  assert.equal(sharedStorage.getItem(tabB.draftKey('same')),null);
  tabA.dispose();tabB.dispose();
  console.log('PASS browser tabs own independent draft slots and never clear another tab draft');

  const openRead=deferred();let fetchCount=0;
  const raceApi={...api,get:()=>++fetchCount===1?openRead.promise:Promise.resolve(record('race')),remove:async()=>{}};
  const deleteRace=new ArticleState({storage:new Storage(),accountId:9,api:raceApi});
  const staleOpen=deleteRace.open('race');
  await deleteRace.remove('race');openRead.resolve(record('race'));
  assert.equal(await staleOpen,null);assert.equal(deleteRace.entries.has('race'),false);
  deleteRace.dispose();
  console.log('PASS a detail response from before deletion cannot reopen the deleted article');

  const removalRead=deferred();let firstGet=true;
  const preserveStorage=new Storage();
  const deleteFailure=new ArticleState({storage:preserveStorage,accountId:10,debounceMs:100000,api:{...api,
    get:()=>firstGet?(firstGet=false,removalRead.promise):Promise.resolve(record('failure')),
    remove:async()=>{throw new Error('delete unavailable');},
  }});
  const failingDelete=deleteFailure.remove('failure').catch(error=>error);
  const editedEntry=deleteFailure.register(record('failure'));
  deleteFailure.edit('failure',{content:'retain new edit'});
  removalRead.resolve(record('failure'));await failingDelete;
  assert.equal(deleteFailure.entries.get('failure'),editedEntry);
  assert.equal(editedEntry.content,'retain new edit');assert.equal(editedEntry.dirty,true);
  assert.equal(JSON.parse(preserveStorage.getItem(deleteFailure.draftKey('failure'))).content,'retain new edit');
  deleteFailure.dispose();
  console.log('PASS a failed deletion reuses live editing state and preserves its local draft');

  const delayedDetail=deferred();let readAttempt=0;
  const continued=new ArticleState({storage:new Storage(),accountId:11,debounceMs:100000,api:{...api,
    get:()=>++readAttempt===1?delayedDetail.promise:Promise.resolve(record('continued')),
    remove:async()=>{throw new Error('delete failed');},
  }});
  const originalOpen=continued.open('continued');
  await continued.remove('continued').catch(()=>{});
  continued.edit('continued',{content:'edited after failed delete'});
  delayedDetail.resolve(record('continued'));
  assert.equal((await originalOpen).content,'edited after failed delete');
  assert.equal(continued.entries.get('continued').dirty,true);
  continued.dispose();
  console.log('PASS late detail after failed deletion cannot replace resumed editing');
})().catch(error=>{console.error(error.message);process.exit(1);});
