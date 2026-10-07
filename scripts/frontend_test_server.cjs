const fs = require('node:fs');
const path = require('node:path');

const frontend = path.resolve(__dirname, '../frontend');
const types = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html' };

function serveFrontend(response, pathname) {
  const file = path.resolve(frontend, pathname === '/' ? 'index.html' : pathname.slice(1));
  if (file.startsWith(frontend + path.sep) && fs.existsSync(file) && fs.statSync(file).isFile()) {
    response.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'text/plain' });
    return response.end(fs.readFileSync(file));
  }
  response.writeHead(404);
  response.end();
}

module.exports = { serveFrontend };
