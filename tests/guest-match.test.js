const test = require('node:test');
const assert = require('node:assert/strict');
const { decide, cleanParts, similarity, cartSignature } = require('../lib/guest-match');

const now = Date.parse('2026-10-15T12:00:00Z');
const parts = (over = {}) => ({ gpu: 'aaaaaaaa11', screen: 'bbbbbbbb22', canvas: 'cccccccc33', audio: 'dddddddd44', fonts: 'eeeeeeee55', tz: 'ffffffff66', hw: '1111111177', platform: '2222222288', lang: '3333333399', ...over });
const behavior = { interactions: 4, activeSeconds: 20 };
const own = (over = {}) => ({ parts: parts(), fp: 'f'.repeat(16), ipHash: 'ip1', ipPrefixHash: 'pre1', cartHash: '', behavior, ...over });
const other = (over = {}) => ({ parts: parts(), fp: 'e'.repeat(16), ipHash: 'ip1', ipPrefixHash: 'pre1', cartHash: '', lastSeenAt: new Date(now - 3600e3).toISOString(), convertedUserIds: [], ...over });

test('same device parts, same network, seen recently, unique fingerprint: linked', () => {
  const r = decide(own(), other(), 1, now);
  assert.equal(r.link, true); assert.ok(r.reasons.includes('same_ip'));
});

test('the same device parts without any network support never link', () => {
  assert.equal(decide(own(), other({ ipHash: 'x', ipPrefixHash: 'y' }), 1, now).link, false);
});

test('a basket alone can never link two guests', () => {
  const r = decide(own({ cartHash: 'sid:1', ipHash: 'a', ipPrefixHash: 'b' }), other({ cartHash: 'sid:1', ipHash: 'c', ipPrefixHash: 'd' }), 1, now);
  assert.equal(r.link, false);
});

test('a common device (fingerprint on more than 3 guests) is refused even on the same network', () => {
  assert.equal(decide(own(), other(), 4, now).link, false);
});

test('a shared fingerprint (2-3 guests) needs much more support than a unique one', () => {
  assert.equal(decide(own(), other({ lastSeenAt: new Date(now - 3 * 86400e3).toISOString() }), 2, now).link, false);
  assert.equal(decide(own({ cartHash: 's:1', fp: 'e'.repeat(16) }), other({ cartHash: 's:1' }), 2, now).link, true);
});

test('a different graphics card or screen breaks the match', () => {
  assert.equal(decide(own(), other({ parts: parts({ gpu: '9999999999' }) }), 1, now).link, false);
  assert.equal(decide(own(), other({ parts: parts({ screen: '8888888888' }) }), 1, now).link, false);
});

test('too few comparable parts is not enough evidence', () => {
  const thin = { gpu: 'aaaaaaaa11', screen: 'bbbbbbbb22', tz: 'ffffffff66' };
  assert.equal(decide(own({ parts: thin }), other({ parts: thin }), 1, now).link, false);
});

test('two different registered people are never linked', () => {
  assert.equal(decide(own({ convertedUserIds: ['u1'] }), other({ convertedUserIds: ['u2'] }), 1, now).link, false);
  assert.equal(decide(own({ convertedUserIds: ['u1'] }), other({ convertedUserIds: ['u1'] }), 1, now).link, true);
  assert.equal(decide(own(), other({ convertedUserIds: ['u1'] }), 1, now).link, false, 'an anonymous guest is not attached to a registered person');
});

test('a visit with no real interaction is not trusted to create links', () => {
  assert.equal(decide(own({ behavior: { interactions: 0, activeSeconds: 0 } }), other(), 1, now).link, false);
  assert.equal(decide(own({ behavior: { interactions: 3, activeSeconds: 2 } }), other(), 1, now).link, false);
});

test('parts are cleaned: unknown keys and non-hex values are dropped', () => {
  assert.deepEqual(cleanParts({ gpu: 'aaaaaaaa11', evil: 'aaaaaaaa11', tz: '<script>' }), { gpu: 'aaaaaaaa11' });
  assert.equal(similarity({ gpu: 'aaaaaaaa11' }, {}).comparable, 0);
});

test('basket signature ignores order and empty rows', () => {
  assert.equal(cartSignature([{ sid: 'b', q: 1 }, { sid: 'a', q: 2 }]), cartSignature([{ sid: 'a', q: 2 }, { sid: 'b', q: 1 }]));
  assert.equal(cartSignature([]), '');
});
