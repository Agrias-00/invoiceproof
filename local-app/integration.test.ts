import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import { createContext, runInContext } from 'node:vm';
import { DatabaseSync } from 'node:sqlite';
import { request as httpRequest } from 'node:http';
import { startLocalApp } from './server.ts';

const worker = fileURLToPath(new URL('./process-worker.ts', import.meta.url));
const UI = fileURLToPath(new URL('../integrated-ui/', import.meta.url));
type App = Awaited<ReturnType<typeof startLocalApp>>;
const childrenByDb = new Map<string, { child: ChildProcess; ended: Promise<unknown> }[]>();
async function api(origin: string, path = '/api/state', payload?: unknown, extra: Record<string, string> = {}) {
  const response = await fetch(origin + path, payload === undefined ? { headers: extra } : {
    method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', ...extra }, body: JSON.stringify(payload),
  });
  return { status: response.status, headers: response.headers, body: await response.json() };
}
async function setup(t: test.TestContext, ledgerOptions?: Parameters<typeof startLocalApp>[0]['ledgerOptions']) {
  const dir = mkdtempSync(join(tmpdir(), 'invoiceproof-ui-'));
  const dbPath = join(dir, 'synthetic.sqlite'); const apps: App[] = [];
  const open = async () => { const app = await startLocalApp({ dbPath, ledgerOptions }); apps.push(app); return app; };
  t.after(async () => {
    for (const worker of childrenByDb.get(dbPath) ?? []) {
      if (worker.child.exitCode === null && worker.child.signalCode === null) { worker.child.kill('SIGTERM'); await worker.ended; }
    }
    childrenByDb.delete(dbPath);
    for (const app of apps) { try { await app.close(); } catch {} }
    rmSync(dir, { recursive: true, force: true });
  });
  const app = await open(); return { dir, dbPath, app, open };
}
async function approve(origin: string) {
  const s = await api(origin); const a = await api(origin, '/api/approve', { expectedRevision: s.body.state.revision });
  assert.equal(a.status, 200); return a.body.state.approval as string;
}
async function childServer(t: test.TestContext, dbPath: string, action?: string, phase = 'afterCommit') {
  const args = [worker, dbPath]; if (action) args.push(action, phase);
  const child = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = ''; child.stderr!.on('data', data => { stderr += String(data); });
  const ended = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => child.on('exit', (code, signal) => resolve({ code, signal })));
  childrenByDb.set(dbPath, [...(childrenByDb.get(dbPath) ?? []), { child, ended }]);
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) { child.kill('SIGTERM'); await ended; } });
  const origin = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Child server timeout')); }, 10000);
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`Child startup exit ${code}: ${stderr}`)); });
    createInterface({ input: child.stdout! }).once('line', line => { clearTimeout(timer); resolve(JSON.parse(line).origin); });
  });
  return { origin, child, ended };
}
function mount(origin: string, options: { fetcher?: (path: string, init: RequestInit) => Promise<Response> } = {}) {
  const ids = ['app-root','error-summary','comparison-panel','comparison-heading','comparison-caption','local-values','server-values','restore-edits','discard-edits','description','quantity','rate','validation','total','approve','save','success','unknown','failure','receipt','refresh','recover','reconcile','read-scenario','recovery-summary','recovery-next-step','recovery-receipt','recovery-code','status','storage','result','draft-form'];
  const nodes: Record<string, any> = {};
  const document: { activeElement: any; getElementById: (id:string)=>any } = { activeElement:null, getElementById:id=>nodes[id] };
  for (const id of ids) nodes[id] = { id, disabled: false, hidden: false, value: '', textContent: '', attributes:{}, focusCount:0, events: {},
    setAttribute(name:string,value:string){this.attributes[name]=value;},getAttribute(name:string){return this.attributes[name]??null;},removeAttribute(name:string){delete this.attributes[name];},
    focus(){document.activeElement=this;this.focusCount++;},
    addEventListener(type: string, fn: (event?: unknown) => unknown) { this.events[type] = fn; },
    click() { if (!this.disabled) return this.events.click?.(); },
    input(value: string) { this.value = value; return this.events.input?.({ target: this }); },
  };
  const requests: { path: string; method: string }[] = [];
  const fetcher = async (path: string, init: RequestInit) => {
    requests.push({ path, method: init.method ?? 'GET' });
    if (options.fetcher) return options.fetcher(path, init);
    const headers = { ...(init.headers ?? {}), ...(init.method === 'POST' ? { Origin: origin } : {}) };
    return fetch(origin + path, { ...init, headers });
  };
  const context = createContext({ document, fetch: fetcher, AbortController, setTimeout, clearTimeout });
  runInContext(readFileSync(join(UI, 'client.js'), 'utf8'), context); runInContext(readFileSync(join(UI, 'app.js'), 'utf8'), context);
  return { nodes, requests, document, app: context.invoiceProofApp };
}
async function click(ui: ReturnType<typeof mount>, id: string) { ui.nodes[id].click(); await ui.app.idle(); }

test('real loopback HTTP serves allowlisted UI and same-origin CSP', async t => {
  const { app } = await setup(t); const r = await fetch(app.origin); const html = await r.text();
  assert.equal(r.status, 200); assert.match(html, /<title>InvoiceProof<\/title>/); assert.match(r.headers.get('content-security-policy')!, /connect-src 'self'/);
  assert.match(r.headers.get('content-security-policy')!, /frame-ancestors 'none'/); assert.equal(r.headers.get('cache-control'), 'no-store');
  for (const file of ['client.js', 'app.js', 'style.css']) assert.equal((await fetch(`${app.origin}/${file}`)).status, 200);
  assert.equal((await api(app.origin, '/server.ts')).status, 404);
});
test('server seeds only the stable synthetic draft once', async t => {
  const { app, open } = await setup(t); const initial = await api(app.origin);
  assert.equal(initial.body.state.draftId, 'synthetic-ui-draft-1'); assert.equal(initial.body.state.total, '100.00');
  const other = await open(); assert.equal((await api(other.origin)).body.state.revision, 1);
});
test('edit saves atomically and invalidates approval in actual SQLite', async t => {
  const { app, dbPath } = await setup(t); await approve(app.origin);
  const r = await api(app.origin, '/api/edit', { expectedRevision: 1, description: 'Synthetic edited work', quantity: '2', rate: '50.00' });
  assert.equal(r.status, 200); assert.equal(r.body.state.revision, 2); assert.equal(r.body.state.approval, null);
  const db = new DatabaseSync(dbPath); assert.equal(db.prepare('SELECT revision FROM drafts').get()!.revision, 2); db.close();
});
test('evidence mismatch rejects edit without damaging saved revision', async t => {
  const { app } = await setup(t); const r = await api(app.origin, '/api/edit', { expectedRevision: 1, description: 'Synthetic work', quantity: '2', rate: '99.00' });
  assert.equal(r.status, 409); assert.equal(r.body.state.revision, 1); assert.equal(r.body.state.draft.lines[0].rate, '50.00');
});
test('stale tab cannot overwrite a newer saved revision or approve it unseen', async t => {
  const { app } = await setup(t); const fields = { expectedRevision: 1, description: 'Synthetic edit', quantity: '2', rate: '50.00' };
  assert.equal((await api(app.origin, '/api/edit', fields)).status, 200);
  assert.equal((await api(app.origin, '/api/edit', fields)).status, 409);
  assert.equal((await api(app.origin, '/api/approve', { expectedRevision: 1 })).status, 409);
});
for (const outcome of ['DRAFT','UNKNOWN','FAILED']) test(`${outcome} synthetic HTTP outcome survives server restart`, async t => {
  const { app, open } = await setup(t); const approval = await approve(app.origin);
  const result = await api(app.origin, '/api/simulate', { approval, outcome }); assert.equal(result.status, 200); assert.equal(result.body.started, true);
  const expected = outcome === 'DRAFT' ? 'DRAFT_VERIFIED' : outcome; assert.equal(result.body.state.status, expected);
  await app.close(); const restarted = await open(); assert.equal((await api(restarted.origin)).body.state.status, expected);
  const repeated = await api(restarted.origin, '/api/simulate', { approval, outcome: 'DRAFT' });
  assert.equal(repeated.body.started, false); assert.equal(repeated.body.state.status, expected);
});
test('forged approval cannot start a simulation', async t => {
  const { app } = await setup(t); await approve(app.origin);
  const r = await api(app.origin, '/api/simulate', { approval: 'f'.repeat(64), outcome: 'DRAFT' }); assert.equal(r.status, 409);
  assert.equal(r.body.state.operationId, null);
});
test('client-supplied draft IDs and operation IDs are never accepted', async t => {
  const { app } = await setup(t); const approval = await approve(app.origin);
  assert.equal((await api(app.origin, '/api/simulate', { approval, outcome: 'DRAFT', operationId: 'new-id' })).status, 400);
  assert.equal((await api(app.origin, '/api/approve', { expectedRevision: 1, draftId: 'another' })).status, 400);
});
test('concurrent HTTP calls with conflicting outcomes grant one creation claim', async t => {
  const { app, dbPath } = await setup(t); const approval = await approve(app.origin);
  const outcomes = ['DRAFT', 'UNKNOWN', 'FAILED'];
  const results = await Promise.all(Array.from({ length: 24 }, (_, i) => api(app.origin, '/api/simulate', { approval, outcome: outcomes[i % 3] })));
  assert.equal(results.filter(r => r.body.started).length, 1); assert.ok(results.every(r => r.status === 200));
  const db = new DatabaseSync(dbPath); assert.equal(db.prepare('SELECT COUNT(*) AS n FROM operations').get()!.n, 1); db.close();
});
test('four independent HTTP server processes sharing SQLite grant one claim', async t => {
  const { app, dbPath } = await setup(t); const approval = await approve(app.origin);
  const children = await Promise.all(Array.from({ length: 4 }, () => childServer(t, dbPath)));
  const results = await Promise.all(children.map(child => api(child.origin, '/api/simulate', { approval, outcome: 'DRAFT' })));
  assert.ok(results.every(r => r.status === 200)); assert.equal(results.filter(r => r.body.started).length, 1);
  assert.equal((await api(app.origin)).body.state.status, 'DRAFT_VERIFIED');
});
for (const [action, phase, expectedStatus, receipt] of [
  ['begin','beforeCommit','APPROVED',false], ['begin','afterCommit','CREATING',false],
  ['recordOutcome','beforeCommit','CREATING',false], ['recordOutcome','afterCommit','CREATING',true],
] as const) test(`HTTP server SIGKILL at ${action}/${phase} preserves safe restart state`, async t => {
  const { app, dbPath } = await setup(t); const approval = await approve(app.origin);
  const child = await childServer(t, dbPath, action, phase);
  await assert.rejects(() => api(child.origin, '/api/simulate', { approval, outcome: 'DRAFT' }));
  assert.equal((await child.ended).signal, 'SIGKILL');
  const state = (await api(app.origin)).body.state; assert.equal(state.status, expectedStatus); assert.equal(Boolean(state.remoteId), receipt);
  if (expectedStatus === 'APPROVED') {
    assert.equal(state.operationId, null); assert.equal((await api(app.origin, '/api/simulate', { approval, outcome: 'DRAFT' })).body.started, true);
  } else {
    assert.equal((await api(app.origin, '/api/simulate', { approval, outcome: 'DRAFT' })).body.started, false);
    assert.equal((await api(app.origin, '/api/recover', {})).body.state.status, 'UNKNOWN');
    const reconcile = await api(app.origin, '/api/reconcile', {});
    assert.equal(reconcile.status, receipt ? 200 : 400); assert.equal(reconcile.body.state.status, receipt ? 'DRAFT_VERIFIED' : 'UNKNOWN');
  }
});
test('database writer lock returns 503 and no claim or fallback storage', async t => {
  const { app, dbPath } = await setup(t, { busyTimeoutMs: 20 }); const approval = await approve(app.origin);
  const lock = new DatabaseSync(dbPath); lock.exec('BEGIN IMMEDIATE');
  try {
    const r = await api(app.origin, '/api/simulate', { approval, outcome: 'DRAFT' }); assert.equal(r.status, 503);
    assert.match(r.body.error, /Storage unavailable/); assert.equal(r.body.state.operationId, null);
  } finally { lock.exec('ROLLBACK'); lock.close(); }
});
test('actual SQL write failure rolls back operation and returns 503', async t => {
  const { app, dbPath } = await setup(t); const approval = await approve(app.origin); const db = new DatabaseSync(dbPath);
  db.exec("CREATE TRIGGER reject_update BEFORE UPDATE ON drafts BEGIN SELECT RAISE(ABORT, 'synthetic disk error'); END;");
  const r = await api(app.origin, '/api/simulate', { approval, outcome: 'DRAFT' }); assert.equal(r.status, 503); assert.equal(r.body.state.operationId, null);
  db.exec('DROP TRIGGER reject_update'); db.close();
});
test('closed/corrupt persistent database does not create a disposable fallback', async t => {
  const { app, dbPath, open } = await setup(t); await app.close(); writeFileSync(dbPath, 'corrupted synthetic database');
  await assert.rejects(open, /database/);
});
test('recover and reconcile cannot invent a receipt or create a new operation', async t => {
  const { app } = await setup(t); assert.equal((await api(app.origin, '/api/recover', {})).status, 409);
  const approval = await approve(app.origin); await api(app.origin, '/api/simulate', { approval, outcome: 'UNKNOWN' });
  assert.equal((await api(app.origin, '/api/reconcile', {})).status, 400);
  assert.equal((await api(app.origin, '/api/reconcile', { remoteId: 'fake' })).status, 400);
  assert.equal((await api(app.origin)).body.state.status, 'UNKNOWN');
});
test('cross-origin, missing-Origin mutation, cross-site and DNS-rebinding Host are blocked', async t => {
  const { app } = await setup(t);
  assert.equal((await api(app.origin, '/api/approve', { expectedRevision: 1 }, { Origin: 'https://example.invalid' })).status, 403);
  assert.equal((await fetch(app.origin + '/api/approve', { method:'POST',headers:{'Content-Type':'application/json'},body:'{"expectedRevision":1}' })).status,403);
  assert.equal((await api(app.origin, '/api/state', undefined, { 'sec-fetch-site': 'cross-site' })).status,403);
  // Node fetch rewrites Host; use an actual HTTP request to test the exact wire header.
  const badHost = await new Promise<number>((resolve, reject) => {
    const request = httpRequest(app.origin+'/api/state', { headers: { Host:'attacker.invalid' } }, response => { response.resume(); resolve(response.statusCode!); });
    request.on('error', reject); request.end();
  });
  assert.equal(badHost,403);
  assert.equal((await api(app.origin)).body.state.status,'NEEDS_REVIEW');
});
test('malformed/extra/oversized request fields and unsupported methods fail closed', async t => {
  const { app } = await setup(t);
  const malformed = await fetch(app.origin+'/api/approve',{method:'POST',headers:{Origin:app.origin,'Content-Type':'application/json'},body:'{'});assert.equal(malformed.status,400);
  const badType = await fetch(app.origin+'/api/approve',{method:'POST',headers:{Origin:app.origin,'Content-Type':'text/plain'},body:'{}'});assert.equal(badType.status,415);
  assert.equal((await api(app.origin,'/api/approve')).status,405);
  for(const payload of [null,[],{}, {expectedRevision:1,extra:true},{expectedRevision:'1'}]) assert.equal((await api(app.origin,'/api/approve',payload)).status,400);
  assert.equal((await api(app.origin,'/api/edit',{expectedRevision:1,description:'x'.repeat(201),quantity:'2',rate:'50.00'})).status,400);
  assert.equal((await api(app.origin,'/api/state?reset=true')).status,400);
  assert.equal((await api(app.origin,'/api/edit',{expectedRevision:1,description:'x'.repeat(9000),quantity:'2',rate:'50.00'})).status,413);
});
test('API cannot serve SQLite/source files or expose a reset/send/payment route', async t => {
  const { app } = await setup(t);
  for(const path of ['/synthetic.sqlite','/../offline-ledger/ledger.ts','/api/reset','/api/send','/api/pay','/api/delete']) assert.equal((await api(app.origin,path)).status,404);
});
test('DOM-to-real-HTTP-to-SQLite happy path and fresh mount retain DRAFT', async t => {
  const { app } = await setup(t); const ui = mount(app.origin); await ui.app.ready;
  assert.equal(ui.nodes.description.value,'Synthetic design work');assert.equal(ui.nodes.total.textContent,'100.00 USD');
  await click(ui,'approve'); assert.equal(ui.nodes.success.disabled,false);
  await click(ui,'success'); assert.match(ui.nodes.status.textContent,/DRAFT_VERIFIED/);
  const refreshed=mount(app.origin);await refreshed.app.ready;assert.match(refreshed.nodes.status.textContent,/DRAFT_VERIFIED/);
  for(const id of ['description','quantity','rate','approve','save','success','unknown','failure']) assert.equal(refreshed.nodes[id].disabled,true);
});
test('dirty fields disable approval and persist only on explicit save', async t => {
  const { app } = await setup(t); const ui=mount(app.origin);await ui.app.ready;await click(ui,'approve');
  const before=ui.requests.length;ui.nodes.description.input('Synthetic revised description');
  assert.equal(ui.requests.length,before);assert.equal(ui.nodes.approve.disabled,true);assert.equal(ui.nodes.success.disabled,true);
  await click(ui,'save');assert.match(ui.nodes.status.textContent,/Revision 2/);assert.match(ui.nodes.status.textContent,/No current/);
  await click(ui,'approve');await click(ui,'success');assert.match(ui.nodes.status.textContent,/DRAFT_VERIFIED/);
});
test('invalid save locks UI until authoritative refresh and never auto-approves old data', async t => {
  const { app }=await setup(t);const ui=mount(app.origin);await ui.app.ready;await click(ui,'approve');ui.nodes.rate.input('75.00');
  await click(ui,'save');assert.equal(ui.nodes.approve.disabled,true);assert.equal(ui.nodes.success.disabled,true);assert.match(ui.nodes.result.textContent,/Rate differs/);
  await click(ui,'refresh');assert.equal(ui.nodes.rate.value,'50.00');assert.equal(ui.nodes.success.disabled,true);assert.equal((await api(app.origin)).body.state.revision,1);
  await click(ui,'discard-edits');assert.equal(ui.nodes.success.disabled,false);
});
test('two mounted clients conflict safely on stale edits and refresh actual state', async t => {
  const { app }=await setup(t);const first=mount(app.origin),second=mount(app.origin);await Promise.all([first.app.ready,second.app.ready]);
  first.nodes.description.input('Synthetic first update');await click(first,'save');
  second.nodes.description.input('Synthetic stale edit');await click(second,'save');assert.match(second.nodes.result.textContent,/Stale revision/);assert.equal(second.nodes.approve.disabled,true);
  await click(second,'refresh');assert.equal(second.nodes.description.value,'Synthetic first update');assert.match(second.nodes.status.textContent,/Revision 2/);
});
test('stale approved tab cannot create after another tab edits and reapproves', async t => {
  const { app }=await setup(t);const first=mount(app.origin);await first.app.ready;await click(first,'approve');
  const second=mount(app.origin);await second.app.ready;second.nodes.description.input('Synthetic later work');await click(second,'save');await click(second,'approve');
  await click(first,'success');assert.match(first.nodes.result.textContent,/Stale approval/);assert.equal(first.nodes.success.disabled,true);assert.equal((await api(app.origin)).body.state.operationId,null);
});
for(const action of ['unknown','failure']) test(`DOM ${action} stays terminal after refresh and new mounted client`,async t=>{
  const {app}=await setup(t);const ui=mount(app.origin);await ui.app.ready;await click(ui,'approve');await click(ui,action);
  await click(ui,'refresh');const fresh=mount(app.origin);await fresh.app.ready;assert.match(fresh.nodes.status.textContent,action==='unknown'?/UNKNOWN/:/FAILED/);assert.equal(fresh.nodes.success.disabled,true);
});
test('double click sends one request while waiting for database response',async t=>{
  const {app}=await setup(t);let release:()=>void=()=>{};const gate=new Promise<void>(resolve=>{release=resolve;});
  const ui=mount(app.origin,{fetcher:async(path,init)=>{if(path==='/api/simulate')await gate;return fetch(app.origin+path,{...init,headers:{...(init.headers??{}),Origin:app.origin}});}});
  await ui.app.ready;await click(ui,'approve');ui.nodes.success.click();ui.nodes.success.click();ui.nodes.unknown.click();
  assert.equal(ui.requests.filter(r=>r.path==='/api/simulate').length,1);assert.equal(ui.nodes.refresh.disabled,true);
  release();await ui.app.idle();assert.match(ui.nodes.status.textContent,/DRAFT_VERIFIED/);
});
test('lost HTTP response after commit locks controls, refresh restores terminal state without retry',async t=>{
  const {app}=await setup(t);const ui=mount(app.origin,{fetcher:async(path,init)=>{const r=await fetch(app.origin+path,{...init,headers:{...(init.headers??{}),Origin:app.origin}});if(path==='/api/simulate')throw Error('synthetic dropped response');return r;}});
  await ui.app.ready;await click(ui,'approve');await click(ui,'success');assert.equal(ui.nodes.success.disabled,true);assert.match(ui.nodes.result.textContent,/No retry/);
  await click(ui,'refresh');assert.match(ui.nodes.status.textContent,/DRAFT_VERIFIED/);assert.equal(ui.requests.filter(r=>r.path==='/api/simulate').length,1);
});
test('database error through live UI locks all mutations until refresh',async t=>{
  const {app,dbPath}=await setup(t,{busyTimeoutMs:20});const ui=mount(app.origin);await ui.app.ready;await click(ui,'approve');
  const db=new DatabaseSync(dbPath);db.exec('BEGIN IMMEDIATE');try{await click(ui,'success');assert.match(ui.nodes.result.textContent,/Storage unavailable/);for(const id of ['save','approve','success','unknown','failure'])assert.equal(ui.nodes[id].disabled,true);}finally{db.exec('ROLLBACK');db.close();}
  await click(ui,'refresh');assert.match(ui.nodes.status.textContent,/APPROVED/);assert.equal(ui.requests.filter(r=>r.path==='/api/simulate').length,1);
});
test('initial server failure leaves controls locked and has no in-memory simulation fallback',async()=>{
  const ui=mount('http://127.0.0.1:1',{fetcher:async()=>{throw Error('offline');}});await ui.app.ready;
  assert.match(ui.nodes.status.textContent,/unavailable/);for(const id of ['save','approve','success','unknown','failure','recover','reconcile'])assert.equal(ui.nodes[id].disabled,true);
});
test('UI reflects interrupted durable operation and reconciles only saved synthetic receipt',async t=>{
  const {app,dbPath}=await setup(t);const approval=await approve(app.origin);const crashing=await childServer(t,dbPath,'recordOutcome');
  await assert.rejects(()=>api(crashing.origin,'/api/simulate',{approval,outcome:'DRAFT'}));await crashing.ended;
  const ui=mount(app.origin);await ui.app.ready;assert.match(ui.nodes.status.textContent,/CREATING/);assert.equal(ui.nodes.success.disabled,true);
  await click(ui,'recover');assert.match(ui.nodes.status.textContent,/UNKNOWN/);await click(ui,'reconcile');assert.match(ui.nodes.status.textContent,/DRAFT_VERIFIED/);
});
test('HTML and browser client have no external network/data paths or reset control',()=>{
  for(const page of ['index.html','lab.html','proof.html']){const html=readFileSync(join(UI,page),'utf8');for(const match of html.matchAll(/(?:src|href)="([^"]+)"/g))assert.ok(!/^https?:/.test(match[1]),page);}
  const source=readFileSync(join(UI,'client.js'),'utf8');assert.doesNotMatch(source,/https?:\/\//);assert.doesNotMatch(source,/localStorage|sessionStorage|indexedDB|WebSocket|XMLHttpRequest|sendBeacon/);
  const html=readFileSync(join(UI,'lab.html'),'utf8');assert.doesNotMatch(html,/id="(?:reset|send|pay)"/);assert.match(html,/no invoice is sent or paid/);
});
test('client timeout aborts exactly one request and does not attempt an automatic retry',async()=>{
  const context=createContext({AbortController,setTimeout,clearTimeout});runInContext(readFileSync(join(UI,'client.js'),'utf8'),context);
  let requests=0,aborts=0;
  const client=new context.InvoiceProofLocal.Client(async(_path:string,init:RequestInit)=>{
    requests++;
    return await new Promise((_resolve,reject)=>{init.signal!.addEventListener('abort',()=>{aborts++;reject(Error('synthetic timeout'));},{once:true});});
  },20);
  await assert.rejects(()=>client.simulate('a'.repeat(64),'DRAFT'),/No retry/);assert.equal(requests,1);assert.equal(aborts,1);
});
test('malformed JSON response leaves the UI locked',async()=>{
  const ui=mount('http://127.0.0.1:1',{fetcher:async()=>new Response('{',{status:200,headers:{'Content-Type':'application/json'}})});await ui.app.ready;
  assert.match(ui.nodes.result.textContent,/response failed/);assert.equal(ui.nodes.approve.disabled,true);assert.equal(ui.nodes.success.disabled,true);
});
test('null or structurally incomplete successful response never enables UI mutations',async()=>{
  for(const payload of [null,{ok:true,state:{synthetic:true}},{ok:true,state:{synthetic:false}}]){
    const ui=mount('http://127.0.0.1:1',{fetcher:async()=>new Response(JSON.stringify(payload),{status:200,headers:{'Content-Type':'application/json'}})});await ui.app.ready;
    assert.match(ui.nodes.result.textContent,/Invalid server/);assert.equal(ui.nodes.approve.disabled,true);assert.equal(ui.nodes.success.disabled,true);
  }
});
test('unknown or approval-inconsistent server state is rejected by the client',async t=>{
  const {app}=await setup(t);const real=(await api(app.origin)).body;
  for(const change of [{status:'MADE_UP'},{status:'APPROVED',approval:null},{revision:0}]){
    const payload={...real,state:{...real.state,...change}};
    const ui=mount(app.origin,{fetcher:async()=>new Response(JSON.stringify(payload),{status:200,headers:{'Content-Type':'application/json'}})});await ui.app.ready;
    assert.match(ui.nodes.result.textContent,/Invalid server state/);assert.equal(ui.nodes.success.disabled,true);
  }
});
test('two mounted clients race simulations with one authoritative durable claim',async t=>{
  const {app}=await setup(t);await approve(app.origin);const first=mount(app.origin),second=mount(app.origin);await Promise.all([first.app.ready,second.app.ready]);
  first.nodes.success.click();second.nodes.unknown.click();await Promise.all([first.app.idle(),second.app.idle()]);
  const messages=[first.nodes.result.textContent,second.nodes.result.textContent];
  assert.equal(messages.filter(s=>s.startsWith('SIMULATED:')).length,1);assert.equal(messages.filter(s=>s.startsWith('Existing operation')).length,1);
  await Promise.all([click(first,'refresh'),click(second,'refresh')]);assert.equal(first.nodes.status.textContent,second.nodes.status.textContent);
});
test('terminal states block all mutation endpoints despite a stale client',async t=>{
  const {app}=await setup(t);const approval=await approve(app.origin);await api(app.origin,'/api/simulate',{approval,outcome:'UNKNOWN'});
  assert.equal((await api(app.origin,'/api/edit',{expectedRevision:1,description:'Synthetic retry',quantity:'2',rate:'50.00'})).status,409);
  assert.equal((await api(app.origin,'/api/approve',{expectedRevision:1})).status,409);
  assert.equal((await api(app.origin)).body.state.status,'UNKNOWN');
});
test('link-only mock create receipt is persisted then independently DRAFT-verified',async t=>{
  const {app}=await setup(t);const approval=await approve(app.origin);
  const result=await api(app.origin,'/api/simulate',{approval,outcome:'LINK_RECEIPT'});
  assert.equal(result.body.state.status,'DRAFT_VERIFIED');assert.equal(result.body.state.recoveryCode,'MATCHED_DRAFT');assert.equal(result.body.state.readChecks,1);
});
test('saved-receipt pause creates a recoverable state without claiming verification',async t=>{
  const {app}=await setup(t);const approval=await approve(app.origin);const r=await api(app.origin,'/api/simulate',{approval,outcome:'RECEIPT_SAVED'});
  assert.equal(r.body.state.status,'CREATING');assert.equal(r.body.state.recoveryCode,'RECEIPT_SAVED');assert.equal(r.body.state.readChecks,0);
  assert.equal(r.body.state.recovery.canReadStoredReceipt,true);assert.equal(r.body.state.recovery.canCreateRetry,false);
});
for(const [scenario,code] of [['TIMEOUT','READ_TIMEOUT'],['NOT_FOUND','READ_NOT_FOUND'],['MALFORMED','READ_MALFORMED'],['UNAVAILABLE','READ_UNAVAILABLE'],['WRONG_ID','READ_MISMATCH'],['SENT','READ_MISMATCH']])test(`read-only ${scenario} persists reason without authorizing another create`,async t=>{
  const {app,open}=await setup(t);const approval=await approve(app.origin);await api(app.origin,'/api/simulate',{approval,outcome:'RECEIPT_SAVED'});
  const r=await api(app.origin,'/api/reconcile',{scenario});assert.equal(r.status,200);assert.equal(r.body.state.status,'UNKNOWN');assert.equal(r.body.state.recoveryCode,code);assert.equal(r.body.state.readChecks,1);
  const second=await open();const restored=(await api(second.origin)).body.state;assert.equal(restored.recoveryCode,code);assert.equal(restored.readChecks,1);assert.equal(restored.recovery.canCreateRetry,false);
  const duplicate=await api(second.origin,'/api/simulate',{approval,outcome:'DRAFT'});assert.equal(duplicate.body.started,false);assert.equal(duplicate.body.state.status,'UNKNOWN');
});
test('repeated read-only checks preserve operation identity and can later verify matching DRAFT',async t=>{
  const {app}=await setup(t);const approval=await approve(app.origin);await api(app.origin,'/api/simulate',{approval,outcome:'RECEIPT_SAVED'});
  await api(app.origin,'/api/reconcile',{scenario:'TIMEOUT'});await api(app.origin,'/api/reconcile',{scenario:'NOT_FOUND'});
  const result=await api(app.origin,'/api/reconcile',{scenario:'DRAFT'});assert.equal(result.body.state.status,'DRAFT_VERIFIED');assert.equal(result.body.state.readChecks,3);
  assert.equal(result.body.state.operationId,'synthetic-ui-operation-1');assert.equal((await api(app.origin,'/api/simulate',{approval,outcome:'DRAFT'})).body.started,false);
});
test('missing receipt recovery explains hard stop and never enables lookup',async t=>{
  const {app}=await setup(t);const ui=mount(app.origin);await ui.app.ready;await click(ui,'approve');await click(ui,'unknown');
  assert.match(ui.nodes['recovery-summary'].textContent,/no durable invoice receipt/);assert.match(ui.nodes['recovery-next-step'].textContent,/Do not create again/);
  assert.equal(ui.nodes.reconcile.disabled,true);assert.equal(ui.nodes['read-scenario'].disabled,true);assert.match(ui.nodes['recovery-code'].textContent,/OUTCOME_UNKNOWN/);
});
test('UI recovery reason and read count update on timeout, refresh, and eventual DRAFT',async t=>{
  const {app}=await setup(t);const ui=mount(app.origin);await ui.app.ready;await click(ui,'approve');await click(ui,'receipt');
  assert.match(ui.nodes.status.textContent,/CREATING/);assert.equal(ui.nodes.success.disabled,true);assert.equal(ui.nodes.reconcile.disabled,false);
  ui.nodes['read-scenario'].value='TIMEOUT';await click(ui,'reconcile');assert.match(ui.nodes.result.textContent,/Still unresolved: READ_TIMEOUT/);assert.match(ui.nodes['recovery-code'].textContent,/Read checks: 1/);
  await click(ui,'refresh');assert.match(ui.nodes['recovery-code'].textContent,/READ_TIMEOUT/);assert.equal(ui.nodes.success.disabled,true);
  ui.nodes['read-scenario'].value='DRAFT';await click(ui,'reconcile');assert.match(ui.nodes.status.textContent,/DRAFT_VERIFIED/);assert.match(ui.nodes['recovery-code'].textContent,/Read checks: 2/);
});
test('unknown read scenario is rejected without mutating recovery state',async t=>{
  const {app}=await setup(t);const approval=await approve(app.origin);await api(app.origin,'/api/simulate',{approval,outcome:'RECEIPT_SAVED'});
  const result=await api(app.origin,'/api/reconcile',{scenario:'MAKE_SUCCESS'});assert.equal(result.status,400);assert.equal(result.body.state.readChecks,0);assert.equal(result.body.state.status,'CREATING');
});
test('HTML contains every recovery control used by the UI code',()=>{
  const html=readFileSync(join(UI,'lab.html'),'utf8');
  for(const id of ['receipt','read-scenario','recovery-summary','recovery-next-step','recovery-receipt','recovery-code'])assert.match(html,new RegExp(`id="${id}"`));
  assert.match(html,/404 or empty result never proves/);
});
test('four server processes record read-only failures without losing counters or creating again',async t=>{
  const {app,dbPath}=await setup(t);const approval=await approve(app.origin);await api(app.origin,'/api/simulate',{approval,outcome:'RECEIPT_SAVED'});
  const children=await Promise.all(Array.from({length:4},()=>childServer(t,dbPath)));
  const reads=await Promise.all(children.map(child=>api(child.origin,'/api/reconcile',{scenario:'TIMEOUT'})));assert.ok(reads.every(r=>r.status===200));
  const result=(await api(app.origin)).body.state;assert.equal(result.status,'UNKNOWN');assert.equal(result.readChecks,4);assert.equal(result.recovery.canCreateRetry,false);
  assert.equal((await api(app.origin,'/api/simulate',{approval,outcome:'DRAFT'})).body.started,false);
});
test('initial load exposes busy state then clears it without stealing focus',async t=>{
  const {app}=await setup(t);const ui=mount(app.origin);assert.equal(ui.nodes['app-root'].getAttribute('aria-busy'),'true');
  await ui.app.ready;assert.equal(ui.nodes['app-root'].getAttribute('aria-busy'),'false');assert.equal(ui.document.activeElement,null);assert.equal(ui.nodes['error-summary'].hidden,true);
});
test('save focuses the next review action and terminal simulation focuses its result',async t=>{
  const {app}=await setup(t);const ui=mount(app.origin);await ui.app.ready;ui.nodes.description.input('Synthetic focus test');await click(ui,'save');
  assert.equal(ui.document.activeElement.id,'approve');await click(ui,'approve');assert.equal(ui.document.activeElement.id,'result');await click(ui,'success');assert.equal(ui.document.activeElement.id,'result');assert.match(ui.nodes.result.textContent,/DRAFT_VERIFIED/);
});
test('rate mismatch identifies the field and focuses one assertive error summary',async t=>{
  const {app}=await setup(t);const ui=mount(app.origin);await ui.app.ready;ui.nodes.rate.input('75.00');await click(ui,'save');
  assert.equal(ui.nodes.rate.getAttribute('aria-invalid'),'true');assert.equal(ui.nodes.rate.getAttribute('aria-errormessage'),'error-summary');assert.equal(ui.nodes.quantity.getAttribute('aria-invalid'),'false');
  assert.equal(ui.document.activeElement.id,'error-summary');assert.equal(ui.nodes['error-summary'].hidden,false);assert.match(ui.nodes['error-summary'].textContent,/unsaved values are preserved/);assert.equal(ui.nodes.result.getAttribute('aria-live'),'off');
});
test('description validation identifies the field without moving to a disabled input',async t=>{
  const {app}=await setup(t);const ui=mount(app.origin);await ui.app.ready;ui.nodes.description.input('');await click(ui,'save');
  assert.equal(ui.nodes.description.getAttribute('aria-invalid'),'true');assert.equal(ui.document.activeElement.id,'error-summary');assert.equal(ui.nodes.description.disabled,true);
});
test('stale edit comparison preserves local and server values without saving either automatically',async t=>{
  const {app}=await setup(t);const first=mount(app.origin),second=mount(app.origin);await Promise.all([first.app.ready,second.app.ready]);
  first.nodes.description.input('Synthetic server version');await click(first,'save');second.nodes.description.input('Synthetic unsaved version');await click(second,'save');
  assert.equal(second.nodes['comparison-panel'].hidden,false);assert.match(second.nodes['local-values'].textContent,/Synthetic unsaved version/);assert.match(second.nodes['server-values'].textContent,/Synthetic server version/);
  assert.match(second.nodes['comparison-caption'].textContent,/revision 2/);assert.equal(second.nodes['restore-edits'].disabled,true);assert.equal((await api(app.origin)).body.state.revision,2);
});
test('restore after conflict is local-only and requires a fresh save and approval',async t=>{
  const {app}=await setup(t);const first=mount(app.origin),second=mount(app.origin);await Promise.all([first.app.ready,second.app.ready]);
  first.nodes.description.input('Synthetic server version');await click(first,'save');second.nodes.description.input('Synthetic restored version');await click(second,'save');await click(second,'refresh');
  assert.equal(second.document.activeElement.id,'comparison-heading');assert.equal(second.nodes.approve.disabled,true);const count=second.requests.length;
  await click(second,'restore-edits');assert.equal(second.requests.length,count);assert.equal(second.document.activeElement.id,'description');assert.equal(second.nodes.description.value,'Synthetic restored version');assert.equal(second.nodes.approve.disabled,true);assert.equal(second.nodes.success.disabled,true);assert.match(second.nodes.status.textContent,/Local edits are unapproved/);
  await click(second,'save');assert.match(second.nodes.status.textContent,/Revision 3/);assert.equal(second.nodes.success.disabled,true);await click(second,'approve');assert.equal(second.nodes.success.disabled,false);
});
test('terminal database state prevents restoring stale edits after a conflict',async t=>{
  const {app}=await setup(t);const stale=mount(app.origin);await stale.app.ready;stale.nodes.description.input('Synthetic stale local edit');
  const approval=await approve(app.origin);await api(app.origin,'/api/simulate',{approval,outcome:'UNKNOWN'});await click(stale,'save');await click(stale,'refresh');
  assert.match(stale.nodes.status.textContent,/UNKNOWN/);assert.equal(stale.nodes['restore-edits'].disabled,true);assert.match(stale.nodes['local-values'].textContent,/stale local edit/);
  const count=stale.requests.length;await click(stale,'restore-edits');assert.equal(stale.requests.length,count);assert.equal(stale.nodes.success.disabled,true);
});
test('explicit discard resolves preserved-edit choice without writing the database',async t=>{
  const {app}=await setup(t);const ui=mount(app.origin);await ui.app.ready;await click(ui,'approve');ui.nodes.rate.input('75.00');await click(ui,'save');await click(ui,'refresh');
  const count=ui.requests.length;assert.equal(ui.nodes.success.disabled,true);await click(ui,'discard-edits');assert.equal(ui.requests.length,count);assert.equal(ui.nodes['comparison-panel'].hidden,true);assert.equal(ui.nodes.success.disabled,false);assert.equal((await api(app.origin)).body.state.revision,1);
});
test('manual refresh of dirty fields preserves them and blocks approval until a choice',async t=>{
  const {app}=await setup(t);const ui=mount(app.origin);await ui.app.ready;ui.nodes.description.input('Synthetic local draft');await click(ui,'refresh');
  assert.equal(ui.nodes.description.value,'Synthetic design work');assert.match(ui.nodes['local-values'].textContent,/Synthetic local draft/);assert.equal(ui.nodes.approve.disabled,true);assert.equal(ui.document.activeElement.id,'comparison-heading');
});
test('failed refresh preserves dirty fields until a later successful read and explicit restore',async t=>{
  const {app}=await setup(t);let fail=false;const ui=mount(app.origin,{fetcher:async(path,init)=>{if(fail){fail=false;throw Error('synthetic disconnect');}return fetch(app.origin+path,{...init,headers:{...(init.headers??{}),Origin:app.origin}});}});
  await ui.app.ready;ui.nodes.description.input('Synthetic retained text');fail=true;await click(ui,'refresh');assert.match(ui.nodes['local-values'].textContent,/retained text/);assert.equal(ui.nodes['restore-edits'].disabled,true);
  await click(ui,'refresh');assert.equal(ui.nodes['restore-edits'].disabled,false);await click(ui,'restore-edits');assert.equal(ui.nodes.description.value,'Synthetic retained text');
});
test('lost save response never automatically repeats the edit or uses stale approval',async t=>{
  const {app}=await setup(t);const ui=mount(app.origin,{fetcher:async(path,init)=>{const r=await fetch(app.origin+path,{...init,headers:{...(init.headers??{}),Origin:app.origin}});if(path==='/api/edit')throw Error('lost saved response');return r;}});
  await ui.app.ready;ui.nodes.description.input('Synthetic committed edit');await click(ui,'save');assert.match(ui.nodes.status.textContent,/Last read state/);await click(ui,'refresh');
  assert.equal((await api(app.origin)).body.state.revision,2);assert.equal(ui.requests.filter(r=>r.path==='/api/edit').length,1);assert.equal(ui.nodes.approve.disabled,true);assert.equal(ui.nodes.success.disabled,true);
});
test('error comparison uses literal text rather than interpreting user HTML',async t=>{
  const {app}=await setup(t);const ui=mount(app.origin);await ui.app.ready;ui.nodes.description.input('<img src=x onerror=alert(1)>');await click(ui,'refresh');
  assert.match(ui.nodes['local-values'].textContent,/<img src=x/);assert.doesNotMatch(readFileSync(join(UI,'app.js'),'utf8'),/innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
});
test('native form submit is prevented and cannot silently approve or simulate',async t=>{
  const {app}=await setup(t);const ui=mount(app.origin);await ui.app.ready;let prevented=false;const count=ui.requests.length;ui.nodes['draft-form'].events.submit({preventDefault(){prevented=true;}});
  assert.equal(prevented,true);assert.equal(ui.requests.length,count);assert.equal((await api(app.origin)).body.state.status,'NEEDS_REVIEW');
});
test('HTML uses native labeled controls, skip target and no positive tabindex',()=>{
  const html=readFileSync(join(UI,'lab.html'),'utf8');assert.match(html,/class="skip-link" href="#flow-title"/);assert.match(html,/id="flow-title" tabindex="-1"/);assert.match(html,/id="draft-title" tabindex="-1"/);assert.doesNotMatch(html,/tabindex="[1-9]/);
  for(const match of html.matchAll(/<(input|select)\b[^>]*\bid="([^"]+)"[^>]*>/g))assert.match(html,new RegExp(`<label for="${match[2]}"`));
  for(const match of html.matchAll(/<button\b[^>]*>/g))assert.match(match[0],/type="button"/);
});
test('all description references resolve to unique elements and focus targets are programmatically focusable',()=>{
  for(const page of ['index.html','lab.html','proof.html']){const html=readFileSync(join(UI,page),'utf8');const ids=[...html.matchAll(/\bid="([^"]+)"/g)].map(m=>m[1]);assert.equal(new Set(ids).size,ids.length,page);
    for(const match of html.matchAll(/aria-(?:describedby|labelledby)="([^"]+)"/g))for(const id of match[1].split(' '))assert.ok(ids.includes(id),`${page} ${id}`);}
  const html=readFileSync(join(UI,'lab.html'),'utf8');
  for(const id of ['error-summary','result','comparison-heading'])assert.match(html,new RegExp(`id="${id}"[^>]*tabindex="-1"`));
});
test('page has one polite result region and one initially hidden alert',()=>{
  const html=readFileSync(join(UI,'lab.html'),'utf8');assert.equal([...html.matchAll(/aria-live="polite"/g)].length,1);assert.equal([...html.matchAll(/role="alert"/g)].length,1);
  assert.match(html,/id="error-summary"[^>]*role="alert"[^>]*hidden/);assert.match(html,/id="result"[^>]*aria-atomic="true"/);
});
test('CSS retains visible focus, hidden-state enforcement, 44px controls and wrapping',()=>{
  const css=readFileSync(join(UI,'style.css'),'utf8');assert.match(css,/focus-visible/);assert.match(css,/\[hidden\]\{display:none!important\}/);assert.match(css,/min-height:44px/);assert.match(css,/overflow-wrap:anywhere/);assert.match(css,/prefers-reduced-motion:reduce/);
});
test('declared primary text and focus colors meet selected contrast thresholds',()=>{
  const css=readFileSync(join(UI,'style.css'),'utf8');
  assert.match(css,/:root\{[^}]*color:#182b3b;background:#f3f6f8/);assert.match(css,/button\{[^}]*background:#155c65;color:white/);
  assert.match(css,/\.muted,footer\{color:#4b6070/);assert.match(css,/a\{color:#005a83/);assert.match(css,/#error-summary\{[^}]*background:#fff1f0;color:#641010/);assert.match(css,/outline:3px solid #c45a00/);
  function l(hex:string){const c=hex.match(/[a-f0-9]{2}/gi)!.map(x=>parseInt(x,16)/255).map(x=>x<=0.04045?x/12.92:((x+0.055)/1.055)**2.4);return c[0]*0.2126+c[1]*0.7152+c[2]*0.0722;}
  function ratio(a:string,b:string){const values=[l(a),l(b)].sort((x,y)=>y-x);return(values[0]+0.05)/(values[1]+0.05);}
  for(const [fg,bg] of [['182b3b','f3f6f8'],['ffffff','155c65'],['4b6070','ffffff'],['005a83','ffffff'],['641010','fff1f0']])assert.ok(ratio(fg,bg)>=4.5,`${fg}/${bg}`);
  assert.ok(ratio('c45a00','ffffff')>=3); // Selected declared colors only, not rendered contrast certification.
});
test('machine-readable conflicts distinguish stale revisions from invalid input',async t=>{
  const {app}=await setup(t);await api(app.origin,'/api/edit',{expectedRevision:1,description:'Synthetic updated',quantity:'2',rate:'50.00'});
  const stale=await api(app.origin,'/api/approve',{expectedRevision:1});assert.equal(stale.body.errorCode,'STALE_REVISION');
  const invalid=await api(app.origin,'/api/approve',{expectedRevision:'one'});assert.equal(invalid.body.errorCode,'INVALID_REQUEST');assert.equal(invalid.body.state.revision,2);
});
test('malformed state on an error cannot populate an authoritative comparison',async()=>{
  const ui=mount('http://127.0.0.1:1',{fetcher:async()=>new Response(JSON.stringify({ok:false,error:'Synthetic failure',errorCode:'STALE_REVISION',state:{synthetic:true,draft:{lines:[null]}}}),{status:409,headers:{'Content-Type':'application/json'}})});
  await ui.app.ready;assert.equal(ui.nodes['comparison-panel'].hidden,true);assert.equal(ui.nodes.approve.disabled,true);assert.equal(ui.document.activeElement.id,'error-summary');
});
test('connection uncertainty labels prior state as stale and hides a validated total',async t=>{
  const {app}=await setup(t);const ui=mount(app.origin,{fetcher:async(path,init)=>{const r=await fetch(app.origin+path,{...init,headers:{...(init.headers??{}),Origin:app.origin}});if(path==='/api/simulate')throw Error('synthetic lost response');return r;}});
  await ui.app.ready;await click(ui,'approve');await click(ui,'success');assert.match(ui.nodes.status.textContent,/May be outdated/);assert.doesNotMatch(ui.nodes.total.textContent,/100\.00/);assert.equal(ui.nodes.success.disabled,true);
});
test('storage failures do not mark a particular input invalid and refresh restores polite results',async t=>{
  const {app,dbPath}=await setup(t,{busyTimeoutMs:20});const ui=mount(app.origin);await ui.app.ready;await click(ui,'approve');const db=new DatabaseSync(dbPath);db.exec('BEGIN IMMEDIATE');
  try{await click(ui,'success');for(const id of ['description','quantity','rate'])assert.equal(ui.nodes[id].getAttribute('aria-invalid'),'false');}finally{db.exec('ROLLBACK');db.close();}
  await click(ui,'refresh');assert.equal(ui.nodes['error-summary'].hidden,true);assert.equal(ui.nodes.result.getAttribute('aria-live'),'polite');
});
