const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const migration = fs.readFileSync(path.join(__dirname, '..', 'supabase', 'migrations', '20261017020000_expire_editor_sections.sql'), 'utf8');

test('section expiry archives existing rows and preserves manual product items', () => {
  assert.match(migration, /create or replace function public\.expire_editor_sections\(\)/i);
  assert.match(migration, /update public\.editor_sections/i);
  assert.match(migration, /status = 'archived'/i);
  assert.match(migration, /archive_reason = 'timer_expired'/i);
  assert.match(migration, /where status = 'active'[\s\S]*?ends_at <= clock_timestamp\(\)/i);
  assert.doesNotMatch(migration, /delete\s+from\s+public\.editor_(?:sections|section_items)/i);
  assert.match(migration, /cron\.schedule\([\s\S]*?'expire-editor-sections'[\s\S]*?'\* \* \* \* \*'/i);
  assert.match(migration, /cron\.unschedule\(previous_job\)/i);
});
