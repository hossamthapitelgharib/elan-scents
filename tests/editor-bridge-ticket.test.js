const test = require('node:test');
const assert = require('node:assert/strict');
const tickets = require('../railway/editor-bridge-ticket.js');

const env = {
  SUPABASE_SERVICE_ROLE_KEY: 'test-only-signing-secret',
  ELAN_EDITOR_ORIGIN: 'https://editor.example.test',
  ELAN_STORE_ORIGIN: 'https://store.example.test'
};

test('editor bridge tickets are signed for the exact editor and storefront origins', () => {
  const now = Date.now();
  const token = tickets.issue('https://store.example.test', env, now);
  assert.ok(token);
  const claims = tickets.verify(token, env, now + 1000);
  assert.equal(claims.iss, 'https://editor.example.test');
  assert.equal(claims.aud, 'https://store.example.test');
  assert.equal(claims.role, 'platform_admin');
  assert.equal(claims.exp - claims.iat, tickets.TTL_SECONDS);
});

test('bridge tickets are rejected after expiry or when the signature, issuer, audience, or role is wrong', () => {
  const now = Date.now();
  const token = tickets.issue('https://store.example.test', env, now);
  assert.equal(tickets.verify(token, env, now + (tickets.TTL_SECONDS + 1) * 1000), null);
  assert.equal(tickets.verify(token + 'x', env, now + 1000), null);
  assert.equal(tickets.verify(token, { ...env, SUPABASE_SERVICE_ROLE_KEY: 'different-secret' }, now + 1000), null);
  assert.equal(tickets.verify(token, { ...env, ELAN_EDITOR_ORIGIN: 'https://attacker.example' }, now + 1000), null);
  assert.equal(tickets.verify(token, { ...env, ELAN_STORE_ORIGIN: 'https://attacker.example' }, now + 1000), null);
  assert.equal(tickets.verify(tickets.issue('https://attacker.example', env, now), env, now + 1000), null);
});

test('a ticket cannot be issued without a server-only signing secret or a valid HTTPS audience', () => {
  assert.equal(tickets.issue('https://store.example.test', { ELAN_EDITOR_ORIGIN: env.ELAN_EDITOR_ORIGIN }), '');
  assert.equal(tickets.issue('http://store.example.test', env), '');
  assert.equal(tickets.verify('not-a-ticket', env), null);
});
