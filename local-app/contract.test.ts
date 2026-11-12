import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { normalizeCreate, normalizeRead, describeCreateRequest, OfflinePayPalMock } from './paypal-contract.ts';
import { fixture } from '../offline-core/fixture.ts';
const remoteId = 'INV2-SYNTHETIC-0001';
test('documented full create representation becomes receipt, not verified success', () => {
  assert.deepEqual(normalizeCreate(201,{id:remoteId,status:'DRAFT'}),{kind:'receipt',remoteId,format:'representation'});
});
test('documented href create response extracts a validated sandbox invoice ID', () => {
  assert.deepEqual(normalizeCreate(201,{href:`https://api-m.sandbox.paypal.com/v2/invoicing/invoices/${remoteId}`,rel:'self',method:'GET'}),{kind:'receipt',remoteId,format:'self-link'});
});
for(const href of [
  `http://api-m.sandbox.paypal.com/v2/invoicing/invoices/${remoteId}`,
  `https://api-m.paypal.com/v2/invoicing/invoices/${remoteId}`,
  `https://attacker.invalid/v2/invoicing/invoices/${remoteId}`,
  `https://user:password@api-m.sandbox.paypal.com/v2/invoicing/invoices/${remoteId}`,
  `https://api-m.sandbox.paypal.com/v2/invoicing/invoices/${remoteId}?token=x`,
  `https://api-m.sandbox.paypal.com/v2/invoicing/invoices/${remoteId}#x`,
  `https://api-m.sandbox.paypal.com/v2/invoicing/invoices/${remoteId}/send`,
  'https://api-m.sandbox.paypal.com/v2/payments/captures/CAPTURE',
  'https://api-m.sandbox.paypal.com/v2/invoicing/invoices/INV2-%2fmalicious',
  'not a url',
]) test(`reject unsafe or non-sandbox receipt href: ${href}`,()=>{
  assert.equal(normalizeCreate(201,{href,rel:'self',method:'GET'}).kind,'unknown');
});
test('wrong link rel or method never grants a receipt',()=>{
  const href=`https://api-m.sandbox.paypal.com/v2/invoicing/invoices/${remoteId}`;
  assert.equal(normalizeCreate(201,{href,rel:'send',method:'POST'}).kind,'unknown');
  assert.equal(normalizeCreate(201,{href}).kind,'unknown');
});
test('conflicting top-level ID and href remain UNKNOWN',()=>{
  assert.equal(normalizeCreate(201,{id:remoteId,href:'https://api-m.sandbox.paypal.com/v2/invoicing/invoices/INV2-OTHER',rel:'self',method:'GET'}).kind,'unknown');
});
test('non-DRAFT create representation does not claim a successful draft',()=>{
  assert.equal(normalizeCreate(201,{id:remoteId,status:'SENT'}).kind,'unknown');
});
for(const status of [200,400,401,409,429,500,503]) test(`HTTP ${status} create alone never proves creation or definite absence`,()=>{
  assert.equal(normalizeCreate(status,{id:remoteId,status:'DRAFT'}).kind,'unknown');
});
test('missing or malformed create response remains UNKNOWN',()=>{
  for(const body of [null,[],{},'', {id:'not-invoice-id'}, {id:123}]) assert.equal(normalizeCreate(201,body).kind,'unknown');
});
test('GET result is independently normalized and still requires matching ledger receipt',()=>{
  assert.deepEqual(normalizeRead(200,{id:remoteId,status:'DRAFT'}),{kind:'invoice',remoteId,status:'DRAFT'});
  assert.deepEqual(normalizeRead(200,{id:remoteId,status:'SENT'}),{kind:'invoice',remoteId,status:'SENT'});
});
test('GET passes on the number and total as returned, and leaves out a malformed one',()=>{
  assert.deepEqual(normalizeRead(200,{id:remoteId,status:'DRAFT',detail:{invoice_number:'IP-0A1B'},amount:{currency_code:'USD',value:'196.00'}}),{kind:'invoice',remoteId,status:'DRAFT',number:'IP-0A1B',total:'USD 196.00',currency:'USD',value:'196.00'});
  assert.deepEqual(normalizeRead(200,{id:remoteId,status:'DRAFT',detail:{invoice_number:'<b>x</b>'},amount:{currency_code:'usd',value:196}}),{kind:'invoice',remoteId,status:'DRAFT'});
});
test('GET 404 is unresolved, not proof of non-creation',()=>{
  assert.deepEqual(normalizeRead(404,{}),{kind:'unavailable',code:'READ_NOT_FOUND'});
});
test('read timeout/server/auth errors or malformed bodies cannot verify',()=>{
  for(const status of [401,429,500,503]) assert.deepEqual(normalizeRead(status,{}),{kind:'unavailable',code:'READ_UNAVAILABLE'});
  for(const body of [null,[],{}, {id:remoteId}, {id:'x',status:'DRAFT'}, {id:remoteId,status:1}]) assert.deepEqual(normalizeRead(200,body),{kind:'unavailable',code:'READ_MALFORMED'});
});
test('request description reuses persisted ID, exact fixture amounts and contains no auth material',()=>{
  const request=describeCreateRequest(fixture(),'synthetic-op-1');
  assert.equal(request.path,'/v2/invoicing/invoices');assert.equal(request.headers['PayPal-Request-Id'],'synthetic-op-1');
  assert.equal(request.body.items[0].quantity,'2');assert.equal(request.body.items[0].unit_amount.value,'50.00');
  assert.deepEqual(request,describeCreateRequest(fixture(),'synthetic-op-1'));
  assert.doesNotMatch(JSON.stringify(request),/Authorization|Bearer|client_secret|access_token/);
});
test('request description rejects unvalidated data and unpersistable ID formats',()=>{
  const invalid=fixture();invalid.lines[0].rate='99.00';assert.throws(()=>describeCreateRequest(invalid,'op'));
  for(const id of ['', 'x'.repeat(39),'has space','한글'])assert.throws(()=>describeCreateRequest(fixture(),id));
});
test('contract is explicitly USD-only rather than promising all core currencies',()=>{
  const draft=fixture();draft.currency='EUR';draft.lines[0].currency='EUR';draft.evidence[0].currency='EUR';assert.throws(()=>describeCreateRequest(draft,'op'),/USD/);
});
test('mock supports both documented create response variants without a transport',()=>{
  const mock=new OfflinePayPalMock();assert.equal(mock.createDraft(fixture(),'op','DRAFT').kind,'receipt');assert.equal(mock.createDraft(fixture(),'op','LINK_RECEIPT').kind,'receipt');
  assert.equal(mock.createDraft(fixture(),'op','UNKNOWN').kind,'unknown');assert.equal(mock.createDraft(fixture(),'op','FAILED').kind,'failed');
  assert.equal(mock.createDraft(fixture(),'op','invalid' as never).kind,'unknown');assert.deepEqual(mock.readInvoice(remoteId,'invalid' as never),{kind:'unavailable',code:'READ_MALFORMED'});
});
test('provider module has no network, authentication, shell, token or payment implementation',()=>{
  const source=readFileSync(new URL('./paypal-contract.ts',import.meta.url),'utf8');
  assert.doesNotMatch(source,/\b(fetch|XMLHttpRequest|WebSocket|exec|spawn)\s*\(/);
  assert.doesNotMatch(source,/from ['"]node:(http|https|net|tls|child_process)/);
});
test('representation self-link must agree with top-level receipt ID',()=>{
  const link={href:'https://api-m.sandbox.paypal.com/v2/invoicing/invoices/INV2-OTHER',rel:'self',method:'GET'};
  assert.equal(normalizeCreate(201,{id:remoteId,status:'DRAFT',links:[link]}).kind,'unknown');
});
test('representation self-link with unsafe host or malformed links fails closed',()=>{
  assert.equal(normalizeCreate(201,{id:remoteId,status:'DRAFT',links:[{href:`https://attacker.invalid/v2/invoicing/invoices/${remoteId}`,rel:'self',method:'GET'}]}).kind,'unknown');
  assert.equal(normalizeCreate(201,{id:remoteId,status:'DRAFT',links:'invalid'}).kind,'unknown');
});
test('representation with matching self-link accepts receipt and never follows action links',()=>{
  const self={href:`https://api-m.sandbox.paypal.com/v2/invoicing/invoices/${remoteId}`,rel:'self',method:'GET'};
  assert.equal(normalizeCreate(201,{id:remoteId,status:'DRAFT',links:[self,{href:'https://attacker.invalid/send',rel:'send',method:'POST'}]}).kind,'receipt');
});
