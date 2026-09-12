const { execFile } = require('node:child_process');

function runGrok(bin, args, timeout) {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.SMOKE_TEST;
  return new Promise((resolve, reject) => execFile(bin, args, {
    windowsHide: true, encoding: 'utf8', timeout, maxBuffer: 2 * 1024 * 1024, env,
  }, (error, stdout, stderr) => error ? reject(new Error(String(stderr || error.message).trim())) : resolve(stdout)));
}

function parseCheck(raw) {
  const text = String(raw || '').trim();
  const lines = text.split(/\r?\n/).reverse();
  let data = null;
  for (const line of lines) {
    const s = line.trim();
    if (!s.startsWith('{')) continue;
    try { data = JSON.parse(s); break; } catch {}
  }
  if (!data) {
    try { data = JSON.parse(text); } catch { throw new Error('无法读取版本信息'); }
  }
  if (data.error) throw new Error(String(data.error));
  const current = String(data.currentVersion || '').trim();
  const latest = String(data.latestVersion || '').trim();
  if (!current && !latest) throw new Error('无法读取版本信息');
  return { current, latest: latest || current, available: Boolean(data.updateAvailable) && current !== latest };
}

async function check(bin, run = runGrok) {
  if (!bin) throw new Error('找不到 Grok Build');
  return parseCheck(await run(bin, ['update', '--check', '--json'], 30000));
}

async function install(bin, run = runGrok) {
  if (!bin) throw new Error('找不到 Grok Build');
  await run(bin, ['update'], 180000);
  const info = await check(bin, run);
  if (info.available) throw new Error('更新没有完成');
  return info;
}

module.exports = { parseCheck, check, install, runGrok };
