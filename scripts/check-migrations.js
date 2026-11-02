#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const migrationsDir = path.join(root, 'supabase', 'migrations');
const rollbackDir = path.join(root, 'supabase', 'rollback');
const policyPath = path.join(rollbackDir, 'irreversible.json');
const files = (dir) => fs.readdirSync(dir).filter((name) => name.endsWith('.sql')).sort();
const migrations = files(migrationsDir);
const rollbacks = new Set(files(rollbackDir));
const policy = JSON.parse(fs.readFileSync(policyPath, 'utf8'));
const entries = new Map();
for (const entry of policy.exceptions || []) {
  if (!entry || typeof entry.migration !== 'string') throw new Error('invalid rollback exception entry');
  if (entries.has(entry.migration)) throw new Error(`duplicate rollback exception: ${entry.migration}`);
  if (entry.backupRequired !== true || typeof entry.reason !== 'string' || entry.reason.trim().length < 20) {
    throw new Error(`rollback exception needs reason and backupRequired=true: ${entry.migration}`);
  }
  entries.set(entry.migration, entry);
}
const errors = [];
for (const migration of migrations) {
  if (!rollbacks.has(migration) && !entries.has(migration)) errors.push(`missing rollback or exception: ${migration}`);
}
for (const migration of entries.keys()) {
  if (!migrations.includes(migration)) errors.push(`stale rollback exception: ${migration}`);
}
if (errors.length) {
  console.error(errors.join('\n'));
  process.exitCode = 1;
} else {
  const reversible = migrations.filter((name) => rollbacks.has(name)).length;
  console.log(`migration rollback policy OK: ${migrations.length} migrations, ${reversible} rollback files, ${entries.size} explicit irreversible exceptions`);
}
