const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const migrationDir = path.join(__dirname, '..', 'supabase', 'migrations');
const recovered = new Map([
  ['20261102074625_store_order_commissions_and_merchant_evidence.sql', '92d08e84679c7e96f6eb27cbe4532e6a0a665d2f9288b2239476b170b2aaa8d7'],
  ['20261102074705_order_base_guard_allows_aging_dates.sql', 'd0fb65a4a7bcbe99cd06ab2454570acd68ad11a42b4c8b9e45f1cf3204ba9dbe'],
  ['20261102075101_purchase_notice_correction_may_change_amounts.sql', '21dfb152947a721f46cd77a9d7c40564d494479b6d111896daad915804748afd'],
  ['20261102184350_customer_mail_log.sql', '720147ea3590795ae48d413f3df5f9c265a60a0b1d5da238d829f0e8b99ba7d4']
]);

test('recovered applied migration sources retain their exact live-ledger SHA-256 digests', () => {
  for (const [filename, expected] of recovered) {
    const source = fs.readFileSync(path.join(migrationDir, filename));
    const actual = crypto.createHash('sha256').update(source).digest('hex');
    assert.equal(actual, expected, `${filename} must remain byte-for-byte identical to the recovered live migration`);
  }
});
