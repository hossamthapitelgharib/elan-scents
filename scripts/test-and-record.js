#!/usr/bin/env node
/* Run the complete Node test suite once and persist a timestamped report.
   GitHub Actions uploads reports/test-runs as an artifact after every run. */
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const testsDir = path.join(root, 'tests');
const outDir = path.join(root, 'reports', 'test-runs');
const files = fs.readdirSync(testsDir)
  .filter((name) => name.endsWith('.test.js'))
  .sort()
  .map((name) => path.join('tests', name));

const startedAt = new Date();
const result = spawnSync(process.execPath, ['--test', '--test-reporter=tap', ...files], {
  cwd: root,
  encoding: 'utf8',
  maxBuffer: 32 * 1024 * 1024
});
const finishedAt = new Date();
const output = [result.stdout || '', result.stderr || ''].filter(Boolean).join('\n');
const stamp = startedAt.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
const reportPath = path.join(outDir, `test-${stamp}.md`);
const status = result.status === 0 && !result.error ? 'PASS' : 'FAIL';
const line = (label) => { const m = new RegExp(`^# ${label}\\s+(\\d+)`, 'm').exec(output); return m ? m[1] : 'غير متاح'; };

fs.mkdirSync(outDir, { recursive: true });
const report = [
  '# تقرير تشغيل اختبارات Élan Scents',
  '',
  `- **الحالة:** ${status}`,
  `- **بدأ:** ${startedAt.toISOString()}`,
  `- **انتهى:** ${finishedAt.toISOString()}`,
  `- **الاختبارات:** ${line('tests')}`,
  `- **الناجح:** ${line('pass')}`,
  `- **الفاشل:** ${line('fail')}`,
  `- **الأمر:** \`${process.execPath} --test --test-reporter=tap ${files.join(' ')}\``,
  '',
  '## TAP output',
  '',
  '```text',
  output.trimEnd(),
  '```',
  ''
].join('\n');
fs.writeFileSync(reportPath, report);
fs.writeFileSync(path.join(outDir, 'latest.json'), JSON.stringify({
  status, startedAt: startedAt.toISOString(), finishedAt: finishedAt.toISOString(),
  tests: line('tests'), pass: line('pass'), fail: line('fail'), report: path.relative(root, reportPath)
}, null, 2) + '\n');
console.log(`Test report: ${path.relative(root, reportPath)} (${status})`);
process.stdout.write(output);
process.exitCode = result.error ? 1 : (result.status == null ? 1 : result.status);
