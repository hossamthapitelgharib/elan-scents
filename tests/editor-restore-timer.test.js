const test = require('node:test');
const assert = require('node:assert/strict');
const { editBrowser, plain } = require('./browser-fixture');

/* Restoring an archived section (owner's list, 2026-11-08): the old timer must not come back. A section's timer lives only in its own row
   (editor_sections), never in the design file, so a restored block can carry none: whatever timer fields an old archive row holds are dropped. */
const REF = '11111111-1111-4111-8111-111111111111';
const OLD = { id: 'x-a1b2c', type: 'smart', ref: REF, kind: 'section', style: { align: 'center', size: 'md' },
  timer: { mode: 'window', starts_at: '2020-01-01T00:00:00Z', ends_at: '2020-01-02T00:00:00Z' }, timer_mode: 'window', starts_at: '2020-01-01T00:00:00Z', ends_at: '2020-01-02T00:00:00Z', duration_hours: 3 };

test('restoring an archived section puts the block back without any timer field', async () => {
  const b = await editBrowser();
  await b.mode.execute('archive.restore', { elementId: OLD.id, payload: { format: 'elan-element-v1', element: OLD } });
  const block = plain(b.mode.state().design.blocks).find((x) => x.id === OLD.id);
  assert.ok(block, 'the section is back in the design');
  assert.equal(block.ref, REF, 'still pointing at the same section row');
  assert.deepEqual(Object.keys(block).filter((k) => /timer|starts_at|ends_at|duration/i.test(k)), [], 'no timer of the old section came with it: ' + JSON.stringify(block));
  assert.doesNotMatch(JSON.stringify(plain(b.mode.state().design)), /timer|starts_at|ends_at|duration_hours/i, 'and nothing of it in the saved design');
});
