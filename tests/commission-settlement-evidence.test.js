const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const migration = fs.readFileSync(path.join(__dirname, '..', 'supabase', 'migrations', '20261106130000_commission_settlement_evidence.sql'), 'utf8');
const api = fs.readFileSync(path.join(__dirname, '..', 'api', 'platform-commission-settlement.js'), 'utf8');
const ui = fs.readFileSync(path.join(__dirname, '..', 'platform-dashboard.js'), 'utf8');

test('evidence policy is private, bounded to 10 MiB, and accepts only PDF/JPEG/PNG', () => {
  assert.match(migration, /commission-payment-evidence/);
  assert.match(migration, /public = false/);
  assert.match(migration, /10485760/);
  assert.match(migration, /application\/pdf/);
  assert.match(migration, /image\/jpeg/);
  assert.match(migration, /image\/png/);
  assert.match(migration, /alter table public\.commission_settlement_evidence enable row level security/);
});

test('API validates file signatures instead of trusting the browser MIME type and uses ten-minute signed URLs', () => {
  assert.match(api, /MAX_EVIDENCE_BYTES = 10 \* 1024 \* 1024/);
  assert.match(api, /EVIDENCE_URL_TTL_SECONDS = 600/);
  assert.match(api, /bytes\.subarray\(0, 5\)\.toString\('ascii'\) === '%PDF-'/);
  assert.match(api, /bytes\[0\] === 0xff/);
  assert.match(api, /Buffer\.from\(\[0x89, 0x50, 0x4e, 0x47/);
  assert.match(api, /object\/sign/);
});

test('dashboard requires an actual evidence file and exposes a ten-minute signed-view action', () => {
  assert.match(ui, /type="file" accept="application\/pdf,image\/jpeg,image\/png" required/);
  assert.match(ui, /data-settlement-action="sign_evidence"/);
  assert.match(ui, /FileReader/);
});
