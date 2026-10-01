// Check native ES modules without relying on shell wildcard expansion.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function collectModules(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) return collectModules(filename);
    return entry.isFile() && entry.name.endsWith('.js') ? [filename] : [];
  }).sort();
}

try {
  const directory = path.resolve(process.argv[2] || path.join(__dirname, '..', 'frontend'));
  const modules = collectModules(directory);
  if (modules.length === 0) throw new Error(`No JavaScript modules found in ${directory}`);
  for (const filename of modules) {
    const result = spawnSync(process.execPath, ['--input-type=module', '--check'], {
      input: fs.readFileSync(filename, 'utf8'),
      encoding: 'utf8',
    });
    if (result.error || result.status !== 0) {
      throw new Error(`${filename}\n${result.error?.message || result.stderr || 'Syntax check failed'}`);
    }
    console.log(`PASS ${path.relative(directory, filename)}`);
  }
  console.log(`Checked modules: ${modules.length}`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
