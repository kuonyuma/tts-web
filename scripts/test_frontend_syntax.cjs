// Exercise the cross-platform checker with valid, invalid and missing inputs.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const checker = path.join(__dirname, 'check_frontend.cjs');
const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tts-syntax-'));
const run = (directory) => spawnSync(process.execPath, [checker, directory], { encoding: 'utf8' });

try {
  const valid = path.join(fixtureRoot, 'valid modules');
  fs.mkdirSync(path.join(valid, 'nested'), { recursive: true });
  fs.writeFileSync(path.join(valid, 'app.js'), 'import { value } from "./nested/value.js"; export default await Promise.resolve(value);');
  fs.writeFileSync(path.join(valid, 'nested', 'value.js'), 'export const value = 42;');
  fs.writeFileSync(path.join(valid, 'style.css'), 'This is not JavaScript');
  const success = run(valid);
  assert.equal(success.status, 0, success.stderr);
  assert.match(success.stdout, /Checked modules: 2/);
  console.log('PASS all nested ES modules are checked, including paths with spaces');

  fs.writeFileSync(path.join(valid, 'nested', 'value.js'), 'export const value = ;');
  const invalid = run(valid);
  assert.equal(invalid.status, 1);
  assert.match(invalid.stderr, /value\.js/);
  assert.match(invalid.stderr, /SyntaxError/);
  console.log('PASS syntax errors identify the failing file and return a nonzero exit');

  const empty = path.join(fixtureRoot, 'empty');
  fs.mkdirSync(empty);
  const noModules = run(empty);
  assert.equal(noModules.status, 1);
  assert.match(noModules.stderr, /No JavaScript modules/);
  const missing = run(path.join(fixtureRoot, 'missing'));
  assert.equal(missing.status, 1);
  console.log('PASS empty or missing module directories cannot report success');
} finally {
  assert.equal(path.dirname(path.resolve(fixtureRoot)), path.resolve(os.tmpdir()));
  assert(path.basename(fixtureRoot).startsWith('tts-syntax-'));
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
}
