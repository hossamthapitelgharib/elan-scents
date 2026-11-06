const crypto = require('node:crypto');
const { getContext, requireRoles } = require('./_auth');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EVIDENCE_BUCKET = 'commission-payment-evidence';
const EVIDENCE_URL_TTL_SECONDS = 600;
const MAX_EVIDENCE_BYTES = 10 * 1024 * 1024;
const EVIDENCE_TYPES = {
  'application/pdf': { extension: 'pdf', magic: bytes => bytes.subarray(0, 5).toString('ascii') === '%PDF-' },
  'image/jpeg': { extension: 'jpg', magic: bytes => bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff },
  'image/png': { extension: 'png', magic: bytes => bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) }
};
function reply(res, status, body) { res.setHeader('Cache-Control', 'no-store'); res.setHeader('Content-Type', 'application/json'); return res.status(status).json(body); }
const READ_FIELDS = 'id,commission_id,store_id,amount,currency,status,requested_at,submitted_at,verified_at,paid_at,payment_reference,evidence_reference,created_at,updated_at,stores(name)';
const COMMISSION_FIELDS = 'id,store_id,amount,status,created_at,updated_at,stores(name)';
const EVIDENCE_FIELDS = 'id,settlement_id,original_filename,mime_type,file_size,sha256,uploaded_by,uploaded_at,storage_path';
const ACTIONS = {
  request: { rpc: 'platform_request_commission_settlement', id: 'commissionId', params: (body, actor) => ({ p_commission_id: body.commissionId, p_actor: actor }) },
  submit: { rpc: 'platform_submit_commission_settlement', id: 'settlementId', params: (body, actor) => ({ p_settlement_id: body.settlementId, p_payment_reference: body.paymentReference, p_evidence_reference: body.evidenceReference || null, p_actor: actor }) },
  verify: { rpc: 'platform_verify_commission_settlement', id: 'settlementId', params: (body, actor) => ({ p_settlement_id: body.settlementId, p_actor: actor }) },
  paid: { rpc: 'platform_mark_commission_settlement_paid', id: 'settlementId', params: (body, actor) => ({ p_settlement_id: body.settlementId, p_payment_reference: body.paymentReference || null, p_actor: actor }) }
};
function safeFilename(name) { return String(name || 'evidence').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 255) || 'evidence'; }
function decodeEvidence(file) {
  if (!file || typeof file !== 'object') return { error: 'evidence_file_required' };
  const type = String(file.type || '').toLowerCase();
  const spec = EVIDENCE_TYPES[type];
  if (!spec) return { error: 'unsupported_evidence_type' };
  const encoded = String(file.data || '');
  if (!encoded || encoded.length > Math.ceil(MAX_EVIDENCE_BYTES / 3) * 4 + 8 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded) || encoded.length % 4 !== 0) return { error: 'invalid_evidence_file' };
  const bytes = Buffer.from(encoded, 'base64');
  if (!bytes.length) return { error: 'evidence_file_required' };
  if (bytes.length > MAX_EVIDENCE_BYTES) return { error: 'evidence_file_too_large' };
  if (!spec.magic(bytes)) return { error: 'invalid_evidence_file' };
  return { type, spec, bytes, filename: safeFilename(file.name) };
}
async function storageRequest(context, path, options = {}) {
  return fetch(`${context.supabaseUrl}/storage/v1${path}`, {
    ...options,
    headers: { apikey: context.serviceRoleKey, Authorization: `Bearer ${context.serviceRoleKey}`, ...(options.headers || {}) }
  });
}
async function uploadEvidence(context, settlementId, actor, file) {
  const decoded = decodeEvidence(file);
  if (decoded.error) return { error: decoded.error };
  const objectId = crypto.randomUUID();
  const storagePath = `${settlementId}/${objectId}.${decoded.spec.extension}`;
  const upload = await storageRequest(context, `/object/${EVIDENCE_BUCKET}/${storagePath}`, { method: 'POST', headers: { 'Content-Type': decoded.type, 'Cache-Control': 'no-store', 'x-upsert': 'false' }, body: decoded.bytes });
  if (!upload.ok) return { error: 'evidence_upload_failed' };
  const sha256 = crypto.createHash('sha256').update(decoded.bytes).digest('hex');
  const recordResponse = await fetch(`${context.supabaseUrl}/rest/v1/commission_settlement_evidence`, {
    method: 'POST',
    headers: { apikey: context.serviceRoleKey, Authorization: `Bearer ${context.serviceRoleKey}`, 'Content-Type': 'application/json', Prefer: 'return=representation' },
    body: JSON.stringify({ settlement_id: settlementId, storage_path: storagePath, original_filename: decoded.filename, mime_type: decoded.type, file_size: decoded.bytes.length, sha256, uploaded_by: actor })
  });
  let records = null; try { records = await recordResponse.json(); } catch (_) { records = null; }
  if (!recordResponse.ok || !Array.isArray(records) || !records[0]) {
    await storageRequest(context, `/object/${EVIDENCE_BUCKET}/${storagePath}`, { method: 'DELETE' }).catch(() => {});
    return { error: 'evidence_record_failed' };
  }
  return { record: records[0] };
}
async function signEvidence(context, record) {
  const response = await storageRequest(context, `/object/sign/${EVIDENCE_BUCKET}/${encodeURIComponent(record.storage_path)}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expiresIn: EVIDENCE_URL_TTL_SECONDS }) });
  let data = null; try { data = await response.json(); } catch (_) { data = null; }
  if (!response.ok || !data || typeof data.signedURL !== 'string') return null;
  return `${context.supabaseUrl}/storage/v1${data.signedURL}`;
}
module.exports = async function platformCommissionSettlement(req, res) {
  if (!['GET', 'POST'].includes(req.method)) return reply(res, 405, { ok: false, error: 'method_not_allowed' });
  try {
    const context = requireRoles(await getContext(req), ['platform_admin']);
    if (context.error) return reply(res, context.status, { ok: false, error: context.error });
    const headers = { apikey: context.serviceRoleKey, Authorization: `Bearer ${context.serviceRoleKey}` };
    const base = `${context.supabaseUrl}/rest/v1/`;
    if (req.method === 'GET') {
      const query = new URL(req.url || '/api/platform-commission-settlement', 'http://localhost').searchParams;
      const limit = Math.min(100, Math.max(1, Number.parseInt(query.get('limit') || '100', 10) || 100));
      const offset = Math.max(0, Number.parseInt(query.get('offset') || '0', 10) || 0);
      const requestedStatus = query.get('status');
      const allowedStatuses = new Set(['payable', 'payment_requested', 'payment_submitted', 'payment_verified', 'paid', 'rejected', 'cancelled']);
      if (requestedStatus && !allowedStatuses.has(requestedStatus)) return reply(res, 400, { ok: false, error: 'invalid_settlement_status' });
      const settlementQuery = new URLSearchParams({ select: READ_FIELDS, order: 'updated_at.desc', limit: String(limit), offset: String(offset) });
      const commissionQuery = new URLSearchParams({ select: COMMISSION_FIELDS, status: 'eq.payable', order: 'updated_at.desc', limit: String(limit), offset: String(offset) });
      if (requestedStatus && requestedStatus !== 'payable') settlementQuery.set('status', `eq.${requestedStatus}`);
      const [settlementResponse, commissionResponse] = await Promise.all([
        requestedStatus === 'payable' ? Promise.resolve(new Response('[]', { status: 200 })) : fetch(`${base}commission_settlements?${settlementQuery}`, { headers }),
        !requestedStatus || requestedStatus === 'payable' ? fetch(`${base}commissions?${commissionQuery}`, { headers }) : Promise.resolve(new Response('[]', { status: 200 }))
      ]);
      const [settlements, payable] = await Promise.all([settlementResponse.json(), commissionResponse.json()]);
      if (!settlementResponse.ok || !commissionResponse.ok || !Array.isArray(settlements) || !Array.isArray(payable)) return reply(res, 502, { ok: false, error: 'settlement_data_unavailable' });
      const settlementIds = settlements.map(row => row.id).filter(id => UUID.test(String(id)));
      let evidence = [];
      if (settlementIds.length) {
        const evidenceResponse = await fetch(`${base}commission_settlement_evidence?select=${encodeURIComponent(EVIDENCE_FIELDS)}&settlement_id=in.(${settlementIds.join(',')})&order=uploaded_at.desc`, { headers });
        evidence = evidenceResponse.ok ? await evidenceResponse.json() : [];
        if (!Array.isArray(evidence)) evidence = [];
      }
      const evidenceBySettlement = new Map();
      for (const item of evidence) if (!evidenceBySettlement.has(item.settlement_id)) evidenceBySettlement.set(item.settlement_id, item);
      const settlementCommissionIds = new Set(settlements.map(settlement => settlement.commission_id));
      const records = [
        ...payable.filter(commission => !settlementCommissionIds.has(commission.id)).map(commission => ({ id: null, commissionId: commission.id, storeId: commission.store_id, amount: commission.amount, currency: commission.currency || 'EGP', status: 'payable', createdAt: commission.created_at, updatedAt: commission.updated_at, storeName: commission.stores && commission.stores.name })),
        ...settlements.map(settlement => { const attachment = evidenceBySettlement.get(settlement.id); return { ...settlement, commissionId: settlement.commission_id, storeId: settlement.store_id, requestedAt: settlement.requested_at, submittedAt: settlement.submitted_at, verifiedAt: settlement.verified_at, paidAt: settlement.paid_at, paymentReference: settlement.payment_reference, evidenceReference: settlement.evidence_reference, createdAt: settlement.created_at, updatedAt: settlement.updated_at, storeName: settlement.stores && settlement.stores.name, evidence: attachment ? { id: attachment.id, name: attachment.original_filename, type: attachment.mime_type, size: attachment.file_size, uploadedAt: attachment.uploaded_at } : null }; })
      ];
      records.sort((a, b) => new Date(b.updatedAt || b.createdAt || 0) - new Date(a.updatedAt || a.createdAt || 0));
      return reply(res, 200, { ok: true, settlements: records, limit, offset, hasMore: settlements.length === limit || payable.length === limit });
    }
    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
    const action = String(body.action || '');
    if (action === 'sign_evidence') {
      const settlementId = String(body.settlementId || '');
      const evidenceId = String(body.evidenceId || '');
      if (!UUID.test(settlementId) || !UUID.test(evidenceId)) return reply(res, 400, { ok: false, error: 'invalid_evidence_identifier' });
      const evidenceResponse = await fetch(`${base}commission_settlement_evidence?select=${encodeURIComponent(EVIDENCE_FIELDS)}&id=eq.${evidenceId}&settlement_id=eq.${settlementId}&limit=1`, { headers });
      const records = evidenceResponse.ok ? await evidenceResponse.json() : [];
      if (!evidenceResponse.ok || !Array.isArray(records) || !records[0]) return reply(res, 404, { ok: false, error: 'evidence_not_found' });
      const signedURL = await signEvidence(context, records[0]);
      if (!signedURL) return reply(res, 502, { ok: false, error: 'evidence_sign_failed' });
      return reply(res, 200, { ok: true, url: signedURL, expiresIn: EVIDENCE_URL_TTL_SECONDS, evidence: { id: records[0].id, name: records[0].original_filename } });
    }
    const spec = ACTIONS[action];
    if (!spec) return reply(res, 400, { ok: false, error: 'invalid_settlement_action' });
    const id = String(body[spec.id] || '');
    if (!UUID.test(id)) return reply(res, 400, { ok: false, error: `invalid_${spec.id}` });
    if ((action === 'submit' || action === 'paid') && body.paymentReference !== undefined && (typeof body.paymentReference !== 'string' || body.paymentReference.trim().length > 160)) return reply(res, 400, { ok: false, error: 'invalid_payment_reference' });
    if (action === 'submit' && body.evidenceReference !== undefined && (typeof body.evidenceReference !== 'string' || body.evidenceReference.trim().length > 200)) return reply(res, 400, { ok: false, error: 'invalid_evidence_reference' });
    if (action === 'submit' && !String(body.paymentReference || '').trim()) return reply(res, 400, { ok: false, error: 'payment_reference_required' });
    if (action === 'submit' && !body.evidenceFile && !String(body.evidenceReference || '').trim()) return reply(res, 400, { ok: false, error: 'evidence_file_required' });
    const actor = UUID.test(String(context.user && context.user.id || '')) ? context.user.id : null;
    let uploaded = null;
    if (action === 'submit' && body.evidenceFile) {
      uploaded = await uploadEvidence(context, id, actor, body.evidenceFile);
      if (uploaded.error) return reply(res, uploaded.error === 'evidence_file_too_large' ? 413 : 400, { ok: false, error: uploaded.error });
      body.evidenceReference = `file:${uploaded.record.id}`;
    }
    const response = await fetch(`${context.supabaseUrl}/rest/v1/rpc/${spec.rpc}`, { method: 'POST', headers: { apikey: context.serviceRoleKey, Authorization: `Bearer ${context.serviceRoleKey}`, 'Content-Type': 'application/json' }, body: JSON.stringify(spec.params({ ...body, [spec.id]: id }, actor)) });
    let result = null; try { result = await response.json(); } catch (_) { result = null; }
    if (!response.ok) {
      if (uploaded && uploaded.record) {
        await fetch(`${base}commission_settlement_evidence?id=eq.${uploaded.record.id}`, { method: 'DELETE', headers: { ...headers, Prefer: 'return=minimal' } }).catch(() => {});
        await storageRequest(context, `/object/${EVIDENCE_BUCKET}/${uploaded.record.storage_path}`, { method: 'DELETE' }).catch(() => {});
      }
      const message = result && typeof result.message === 'string' ? result.message : '';
      if (/not found/i.test(message)) return reply(res, 404, { ok: false, error: 'settlement_or_commission_not_found' });
      if (/not payable|not awaiting|not submitted|not verified|evidence is required/i.test(message)) return reply(res, 409, { ok: false, error: 'settlement_state_conflict' });
      if (/reference is required/i.test(message)) return reply(res, 400, { ok: false, error: 'payment_reference_required' });
      return reply(res, 502, { ok: false, error: 'commission_settlement_failed' });
    }
    return reply(res, 200, { ok: true, settlement: result, evidence: uploaded && uploaded.record ? { id: uploaded.record.id, name: uploaded.record.original_filename, type: uploaded.record.mime_type, size: uploaded.record.file_size } : null });
  } catch (_) { return reply(res, 502, { ok: false, error: 'commission_settlement_failed' }); }
};
