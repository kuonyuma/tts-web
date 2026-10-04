// Checked-in output keeps production/Docker independent of npm or a CDN.
const fs = require('node:fs');
const path = require('node:path');
const { build } = require('esbuild');
const root = path.resolve(__dirname, '..');
(async () => {
  await build({
    entryPoints: [path.join(__dirname, 'article_editor_dependencies.mjs')],
    outfile: path.join(root, 'frontend/vendor/codemirror.js'),
    bundle: true, format: 'esm', platform: 'browser', target: 'es2022',
    minify: true, legalComments: 'external',
  });
  const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
  const licenses = Object.keys(lock.packages).filter(name => name && !lock.packages[name].dev).map(name => {
    const dir = path.join(root, name);
    const file = ['LICENSE', 'LICENSE.md', 'LICENSE.txt'].find(file => fs.existsSync(path.join(dir, file)));
    if (!file) throw new Error('Missing license for ' + name);
    return `${name} ${lock.packages[name].version}\n${fs.readFileSync(path.join(dir, file), 'utf8')}`;
  });
  fs.writeFileSync(path.join(root, 'frontend/vendor/LICENSES.txt'), licenses.join('\n\n'));
  console.log('Built local CodeMirror bundle and dependency licenses');
})().catch(error => { console.error(error); process.exitCode = 1; });
