const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { serveFrontend } = require('./frontend_test_server.cjs');

(async () => {
  const server = http.createServer((req, res) => serveFrontend(res, req.url));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const request = pathname => new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: server.address().port, path: pathname }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, type: response.headers['content-type'], body: Buffer.concat(chunks) }));
    }).on('error', reject);
  });
  try {
    for (const [url, file, type] of [
      ['/', 'index.html', 'text/html'],
      ['/api.js', 'api.js', 'text/javascript'],
      ['/chat.css', 'chat.css', 'text/css'],
      ['/vendor/codemirror.js', 'vendor/codemirror.js', 'text/javascript'],
      ['/vendor/LICENSES.txt', 'vendor/LICENSES.txt', 'text/plain'],
    ]) {
      const response = await request(url);
      assert.equal(response.status, 200, url);
      assert.equal(response.type, type, url);
      assert.deepEqual(response.body, fs.readFileSync(path.join(__dirname, '../frontend', file)), url);
    }
    for (const url of ['/missing.js', '/vendor', '/../package.json', '/..\\package.json']) {
      assert.equal((await request(url)).status, 404, url);
    }
    console.log('PASS shared frontend fixture serves exact assets and MIME types, rejects missing files, directories and path escapes');
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
