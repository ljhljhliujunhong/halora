const { Worker, isMainThread, parentPort, workerData } = require('node:worker_threads');
const allowed = new Set(['review', 'archives', 'sessions', 'maintenance']);
function job(service, method, args) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(__filename, { workerData: { service, method, args } });
    worker.once('message', msg => msg.error ? reject(new Error(msg.error)) : resolve(msg.value));
    worker.once('error', reject);
    worker.once('exit', code => { if (code) reject(new Error(`后台操作退出 (${code})`)); });
  });
}
if (!isMainThread) {
  Promise.resolve().then(() => {
    if (!allowed.has(workerData.service)) throw new Error('无效的后台操作');
    return require(`./${workerData.service}.cjs`)[workerData.method](...workerData.args);
  }).then(value => parentPort.postMessage({ value }), error => parentPort.postMessage({ error: error.message }));
}
module.exports = { job };
