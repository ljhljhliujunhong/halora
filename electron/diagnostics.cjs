const fs = require('node:fs');
const path = require('node:path');
function log(root, type, error) {
  try {
    const dir = path.join(root, 'logs'); fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'halora.log');
    if (fs.existsSync(file) && fs.statSync(file).size > 1024 * 1024) fs.renameSync(file, file + '.previous');
    const detail = String(error?.stack || error?.message || error || '').replace(/(Bearer\s+|(?:token|password|key)\s*[=:]\s*)\S+/gi, '$1[redacted]').slice(0, 4000);
    fs.appendFileSync(file, JSON.stringify({ at: new Date().toISOString(), type, detail }) + '\n');
  } catch {}
}
module.exports = { log };
