// Fails when a commit made through GitHub's web "upload / edit" screen touches editor files.
// Those commits overwrite whole files and have rolled the editor back before.
const { execSync } = require('node:child_process');
const range = process.argv[2];
if (!range || /^0+\.\./.test(range)) process.exit(0);
const PROTECTED = /^(design-layer|design-schema|edit-mode|edit-boot|elan-host-bridge)\.js$|^editor\/|^railway\/editor|^tests\/editor/;
const WEB = /^(Add files via upload|Update [\w./-]+|Delete [\w./-]+|Create [\w./-]+)$/;
let bad = [];
try {
  const log = execSync(`git log --format=%H%x09%s ${range}`, { encoding: 'utf8' }).trim().split('\n').filter(Boolean);
  for (const line of log) {
    const [sha, subject] = line.split('\t');
    if (!WEB.test(subject)) continue;
    const files = execSync(`git show --name-only --format= ${sha}`, { encoding: 'utf8' }).split('\n').filter((f) => PROTECTED.test(f));
    if (files.length) bad.push(`${sha.slice(0, 7)} "${subject}" -> ${files.join(', ')}`);
  }
} catch (e) { process.exit(0); }
if (bad.length) {
  console.error('Blocked: web upload/edit commit touched editor files. Ask Claude to merge instead.\n' + bad.join('\n'));
  process.exit(1);
}
