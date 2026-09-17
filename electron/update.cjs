const { execFile } = require('node:child_process');

function runGrok(bin, args, timeout) {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.SMOKE_TEST;
  return new Promise((resolve, reject) => execFile(bin, args, {
    windowsHide: true, encoding: 'utf8', timeout, maxBuffer: 8 * 1024 * 1024, env,
  }, (error, stdout, stderr) => {
    if (!error) return resolve(stdout);
    const detail = String(stderr || stdout || error.message || '').trim();
    if (error.killed) reject(new Error('更新超时'));
    else reject(new Error(detail || '更新失败'));
  }));
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

async function install(bin, run = runGrok, version) {
  if (!bin) throw new Error('找不到 Grok Build');
  const args = ['update'];
  const want = String(version || '').trim();
  if (want) args.push('--version', want);
  await run(bin, args, 600000);
  try {
    return await check(bin, run);
  } catch {
    // The binary may already be mid-replace; restart applies the download.
    return { current: want, latest: want, available: false };
  }
}

module.exports = { parseCheck, check, install, runGrok };
