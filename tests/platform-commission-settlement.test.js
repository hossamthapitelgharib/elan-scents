const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const handler = require(path.join(__dirname, '..', 'api', 'platform-commission-settlement'));
const adminId = '45a6e52c-46c6-42e9-a730-9e5bec3dd201';
const commissionId = 'c38b94c6-3c67-44f4-95e1-0957c1b4aa52';
const settlementId = 'd38b94c6-3c67-44f4-95e1-0957c1b4aa52';
const savedFetch = global.fetch;
const savedEnv = Object.fromEntries(['SUPABASE_URL','SUPABASE_SERVICE_ROLE_KEY'].map(k => [k, process.env[k]]));
test.after(() => { global.fetch = savedFetch; for (const [k,v] of Object.entries(savedEnv)) v === undefined ? delete process.env[k] : process.env[k] = v; });
function response(data, status=200) { return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } }); }
function recorder() { const out={headers:{}}; return { out, status(v){out.status=v;return this;}, setHeader(k,v){out.headers[k]=v;return this;}, json(b){out.body=b;return this;} }; }
async function run(role, body, rpcBody={ id: settlementId, status: 'payment_requested' }, rpcStatus=200) {
  process.env.SUPABASE_URL='https://test.supabase.co'; process.env.SUPABASE_SERVICE_ROLE_KEY='service-key'; const requests=[];
  global.fetch=async (input, options={}) => { const url=new URL(String(input)); requests.push({url,options}); if(url.pathname==='/auth/v1/user') return response({id:adminId}); if(url.pathname==='/rest/v1/profiles') return response([{id:adminId,role}]); return response(rpcBody,rpcStatus); };
  const res=recorder(); await handler({method:'POST',body,headers:{authorization:'Bearer token'}},res); return {res:res.out,requests};
}
test('settlement API requires platform administrator', async()=>{ const {res,requests}=await run('store_admin',{action:'request',commissionId}); assert.equal(res.status,403); assert.equal(requests.length,2); });
test('settlement API validates action and identifiers before RPC', async()=>{ for(const body of [{action:'unknown',commissionId},{action:'request',commissionId:'bad'},{action:'submit',settlementId,paymentReference:'x'}]) { const {res,requests}=await run('platform_admin',body); assert.equal(res.status,400); assert.equal(requests.filter(r=>r.url.pathname.includes('/rpc/')).length,0); } });
test('request action calls the request RPC with authenticated actor', async()=>{ const {res,requests}=await run('platform_admin',{action:'request',commissionId}); assert.equal(res.status,200); const rpc=requests.find(r=>r.url.pathname.endsWith('/rpc/platform_request_commission_settlement')); assert.deepEqual(JSON.parse(rpc.options.body),{p_commission_id:commissionId,p_actor:adminId}); });
test('submit action requires bounded payment and evidence references', async()=>{ const {res,requests}=await run('platform_admin',{action:'submit',settlementId,paymentReference:'BANK-1',evidenceReference:'receipt-1'}); assert.equal(res.status,200); const rpc=requests.find(r=>r.url.pathname.endsWith('/rpc/platform_submit_commission_settlement')); assert.deepEqual(JSON.parse(rpc.options.body),{p_settlement_id:settlementId,p_payment_reference:'BANK-1',p_evidence_reference:'receipt-1',p_actor:adminId}); });
test('state conflict from database is surfaced as 409', async()=>{ const {res}=await run('platform_admin',{action:'verify',settlementId},{message:'Settlement is not submitted'},400); assert.equal(res.status,409); assert.equal(res.body.error,'settlement_state_conflict'); });
