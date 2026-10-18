const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const match = require('../lib/guest-match');

const NOW = Date.parse('2026-10-18T12:00:00Z');
const h = (c) => c.repeat(14);
const parts = () => ({ gpu: h('a'), screen: h('b'), canvas: h('c'), fonts: h('d'), tz: h('e'), hw: h('f'), platform: h('1'), lang: h('2') });
const behavior = { interactions: 3, activeSeconds: 20, pages: 1 };
function pair(ownNetwork, otherNetwork) {
  return [
    { parts: parts(), fp: h('9'), behavior, ...ownNetwork },
    { parts: parts(), fp: h('8'), lastSeenAt: new Date(NOW - 3600 * 1000).toISOString(), ...otherNetwork },
  ];
}

test('an exact address shared with at most one other look-alike still counts as evidence', () => {
  const [own, other] = pair({ ipHash: h('7'), ipPrefixHash: h('6') }, { ipHash: h('7'), ipPrefixHash: h('6') });
  const alone = match.decide(own, other, 1, NOW);
  assert.equal(alone.link, true);
  assert.ok(alone.reasons.includes('same_ip'));
  const withOne = match.decide(own, other, 1, NOW, { crowd: { ip: 1, prefix: 1 } });
  assert.equal(withOne.link, true);
});

test('an address shared by two or more other look-alikes proves nothing and never links', () => {
  const [own, other] = pair({ ipHash: h('7'), ipPrefixHash: h('6') }, { ipHash: h('7'), ipPrefixHash: h('6') });
  const verdict = match.decide(own, other, 1, NOW, { crowd: { ip: match.LIMITS.maxIpCrowd, prefix: match.LIMITS.maxIpCrowd } });
  assert.equal(verdict.link, false);
  assert.deepEqual(verdict.reasons, ['crowded_network']);
});

test('a crowded exact address does not fall back to the shared /24 prefix', () => {
  const [own, other] = pair({ ipHash: h('7'), ipPrefixHash: h('6') }, { ipHash: h('7'), ipPrefixHash: h('6') });
  const verdict = match.decide(own, other, 1, NOW, { crowd: { ip: 2, prefix: 3 } });
  assert.equal(verdict.link, false);
  assert.deepEqual(verdict.reasons, ['crowded_network']);
});

test('the /24 prefix helps only until the prefix itself is crowded', () => {
  const [own, other] = pair({ ipHash: h('7'), ipPrefixHash: h('6') }, { ipHash: h('5'), ipPrefixHash: h('6') });
  const open = match.decide(own, other, 1, NOW, { crowd: { ip: 0, prefix: match.LIMITS.maxPrefixCrowd - 1 } });
  assert.equal(open.link, true);
  assert.ok(open.reasons.includes('same_ip_prefix'));
  const crowded = match.decide(own, other, 1, NOW, { crowd: { ip: 0, prefix: match.LIMITS.maxPrefixCrowd } });
  assert.equal(crowded.link, false);
  assert.deepEqual(crowded.reasons, ['crowded_network']);
});

test('without any network match the reason is still no_network_support, and a basket alone never links', () => {
  const [own, other] = pair({ ipHash: h('7'), ipPrefixHash: h('6'), cartHash: h('4') }, { ipHash: h('3'), ipPrefixHash: h('2'), cartHash: h('4') });
  const verdict = match.decide(own, other, 1, NOW, { crowd: { ip: 0, prefix: 0 } });
  assert.equal(verdict.link, false);
  assert.deepEqual(verdict.reasons, ['no_network_support']);
});

test('the old four-argument call behaves exactly as before', () => {
  const [own, other] = pair({ ipHash: h('7'), ipPrefixHash: h('6') }, { ipHash: h('7'), ipPrefixHash: h('6') });
  assert.equal(match.decide(own, other, 1, NOW).link, true);
});

test('guest identify counts the look-alikes on the same address and passes that crowd to the matcher', () => {
  const api = fs.readFileSync(path.join(__dirname, '..', 'api', 'guest-cart.js'), 'utf8');
  assert.match(api, /const crowd = \{ ip: distinct\('ipHash', own\.ipHash\), prefix: distinct\('ipPrefixHash', own\.ipPrefixHash\) \};/);
  assert.match(api, /match\.decide\(own, c, Number\(c\.popularity\) \|\| 1, Date\.now\(\), \{ crowd \}\)/);
});
