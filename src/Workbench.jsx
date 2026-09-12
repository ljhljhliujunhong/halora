import { useEffect, useRef, useState } from 'react';
import './workbench.css';
import { diffRows } from './diff.mjs';
const api = window.workshop;
const labels = { review: '改动审查', checkpoints: '检查点', settings: '设置', archives: '导出与备份' };
const when = at => at ? new Date(at).toLocaleString() : '未知';

function DiffContent({ patch }) {
  if (!patch) return <p>读取差异…</p>;
  if (!patch.text) return <p>内容未改变，可能是文件模式或重命名。</p>;
  return <pre className="diff-code">{diffRows(patch.text).map((row, index) => <span key={index} className={`diff-line diff-${row.kind}`}><span className="diff-number" aria-label="原行号">{row.old}</span><span className="diff-number" aria-label="新行号">{row.next}</span><span className="diff-text">{row.text || ' '}</span></span>)}</pre>;
}

const needsStage = f => f.untracked || f.status[1] !== ' ';
const syncLabel = review => review.ahead && !review.behind ? `推送 ${review.ahead}` : review.behind && !review.ahead ? `拉取 ${review.behind}` : '同步';
const remoteLine = review => [review.branch, review.ahead ? `领先 ${review.ahead}` : '', review.behind ? `落后 ${review.behind}` : ''].filter(Boolean).join(' · ');

export function Workbench({ page, state, onState, onClose }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState(null);
  const [prefs, setPrefs] = useState(state.preferences || {});
  const [review, setReview] = useState(null);
  const [selected, setSelected] = useState('');
  const [patch, setPatch] = useState(null);
  const [message, setMessage] = useState('');
  const [checkpoints, setCheckpoints] = useState([]);
  const [points, setPoints] = useState([]);
  const [pointError, setPointError] = useState('');
  const [restore, setRestore] = useState(null);
  const [label, setLabel] = useState('');
  const [backup, setBackup] = useState(null);
  const [format, setFormat] = useState('md');
  const [grokUpdate, setGrokUpdate] = useState(null);
  const [storage, setStorage] = useState(null);
  const [backupPassword, setBackupPassword] = useState('');
  const [restorePassword, setRestorePassword] = useState('');
  const actionLock = useRef(false);
  const request = useRef(0);
  const cwd = state.cwd;
  const projectRunning = (state.projects || []).find(p => p.cwd === cwd)?.sessions.some(s => (state.runningIds || []).includes(s.id));
  const act = async fn => {
    if (actionLock.current) return;
    actionLock.current = true;
    setBusy(true); setError(''); setResult(null);
    try { return await fn(); } catch (e) { setError(String(e.message || e).replace(/^Error invoking remote method '[^']+': Error: /, '')); }
    finally { actionLock.current = false; setBusy(false); }
  };
  const load = async () => {
    if (page === 'review' && cwd) { const next = await api.review(cwd); setReview(next); setSelected(''); setPatch(null); }
    if (page === 'checkpoints' && cwd) {
      setCheckpoints(await api.checkpoints(cwd)); setRestore(null);
      setPointError(''); setPoints([]);
      if (state.sessionId) {
        try { setPoints(await api.rewindPoints({ cwd, sessionId: state.sessionId })); }
        catch (e) { setPointError(`无法加载对话回退点：${e.message}`); }
      }
    }
  };
  useEffect(() => {
    // Page reads are independent of mutation busy state; stale requests cannot
    // overwrite the newly selected project/page.
    let active = true;
    setReview(null); setCheckpoints([]); setPoints([]); setRestore(null); setSelected(''); setPatch(null);
    const read = async () => {
      try {
        if (page === 'review' && cwd) { const next = await api.review(cwd); if (active) setReview(next); }
        if (page === 'checkpoints' && cwd) {
          const next = await api.checkpoints(cwd); if (active) setCheckpoints(next);
          if (state.sessionId) try { const nextPoints = await api.rewindPoints({ cwd, sessionId: state.sessionId }); if (active) setPoints(nextPoints); }
          catch (e) { if (active) setPointError(e.message); }
        }
      } catch (e) { if (active) setError(e.message); }
    };
    read(); return () => { active = false; };
  }, [page, cwd, state.sessionId]);
  const preferencesKey = JSON.stringify(state.preferences || {});
  useEffect(() => { setPrefs(state.preferences || {}); }, [preferencesKey]);
  useEffect(() => {
    const id = ++request.current;
    setPatch(null);
    if (!selected) return;
    api.reviewDiff({ cwd, file: selected }).then(value => { if (request.current === id) setPatch(value); })
      .catch(e => { if (request.current === id) setError(e.message); });
  }, [selected, cwd, review]);
  const field = (key, value) => setPrefs(p => ({ ...p, [key]: value }));
  return <section className={page === 'review' ? 'workbench wb-fill' : 'workbench'}>
    <header className="wb-head"><div><small>{cwd?.split(/[\\/]/).pop() || 'Halora'}</small><h1>{labels[page]}</h1></div>
      <div className="wb-actions">{['review', 'checkpoints'].includes(page) && <button className="btn ghost" disabled={busy || !cwd} onClick={() => act(load)}>刷新</button>}<button className="btn ghost" onClick={onClose}>返回对话</button></div>
    </header>
    {error && <div className="wb-error" role="alert">{error}</div>}
    {result && <div className="wb-result">{result.path || result.backup || result.text}{(result.path || result.backup) && <button className="btn ghost" onClick={() => api.showInFolder(result.path || result.backup).catch(e => setError(e.message))}>在文件夹中显示</button>}{result.relaunch && <button type="button" className="btn primary" onClick={() => api.relaunchApp()}>重启星环</button>}</div>}
    {busy && <div className="wb-progress" role="status">正在处理…</div>}
    {page === 'settings' && <form className="wb-settings" onSubmit={e => { e.preventDefault(); act(async () => { onState(await api.savePreferences(prefs)); setResult({text:'设置已保存'}); }); }}>
      <h2>对话</h2>
      <label>默认模型<select value={prefs.modelId || ''} onChange={e => field('modelId', e.target.value)}>{[...new Set([prefs.modelId, ...(state.models || []).map(m => m.id)])].filter(Boolean).map(id => <option key={id}>{id}</option>)}</select></label>
      <label>默认权限模式<select value={prefs.permissionMode || 'agent'} onChange={e => field('permissionMode', e.target.value)}><option value="agent">代理 · 执行前询问</option><option value="plan">规划</option><option value="yolo">自动允许工具操作</option></select></label>
      <label>自动压缩阈值 <span><input type="number" min="50" max="95" value={prefs.autoCompact ?? 85} onChange={e => field('autoCompact', Number(e.target.value))} /> %</span></label>
      <label>发送快捷键<select value={prefs.sendKey || 'enter'} onChange={e => field('sendKey', e.target.value)}><option value="enter">Enter</option><option value="ctrl-enter">Ctrl + Enter</option></select></label>
      <label>默认项目<div className="wb-actions"><input value={prefs.defaultCwd || ''} onChange={e => field('defaultCwd', e.target.value)} /><button type="button" className="btn ghost" onClick={() => act(async () => { const dir = await api.pickFolder(); if (dir) field('defaultCwd', dir); })}>选择</button></div></label>
      <h2>外观</h2>
      {state.settingsWarning && <p role="alert">{state.settingsWarning}</p>}
      <label>主题<select value={prefs.theme || 'light'} onChange={e => field('theme', e.target.value)}><option value="light">浅色</option><option value="dark">深色</option><option value="system">跟随系统</option></select></label>
      <label>字号 <span><input type="number" min="12" max="20" value={prefs.fontSize ?? 14} onChange={e => field('fontSize', Number(e.target.value))} /> px</span></label>
      <h2>恢复</h2>
      <label>任务运行时确认退出<input type="checkbox" checked={prefs.confirmExit !== false} onChange={e => field('confirmExit', e.target.checked)} /></label>
      <label>发送前建立文件检查点<input type="checkbox" checked={prefs.checkpoints !== false} onChange={e => field('checkpoints', e.target.checked)} /></label>
      <h2>更新</h2>
      <label>Grok Build<div className="wb-actions">{grokUpdate && <span>{grokUpdate.available ? `${grokUpdate.current} → ${grokUpdate.latest}` : `${grokUpdate.current} · 已是最新`}</span>}<button type="button" className="btn ghost" disabled={busy} onClick={() => act(async () => setGrokUpdate(await api.grokCheckUpdate()))}>检查更新</button>{grokUpdate?.available && <button type="button" className="btn primary" disabled={busy} onClick={() => act(async () => { const info = await api.grokInstallUpdate(); if (!info) return; setGrokUpdate(info); if (!info.relaunched) setResult({ text: 'Grok Build 已更新', relaunch: true }); })}>更新</button>}</div></label>
      <h2>存储与诊断</h2>
      <div className="wb-actions"><button type="button" className="btn ghost" disabled={busy} onClick={() => act(async () => setStorage(await api.storageInspect()))}>查看存储</button><button type="button" className="btn ghost" disabled={busy} onClick={() => act(async () => setResult(await api.exportDiagnostics()))}>导出诊断日志</button></div>
      {storage && <div>{storage.usage.map(row => <p key={row.name}>{({checkpoints:'检查点',inbox:'附件',backups:'恢复备份','rewind-backups':'回退备份',trash:'已删除对话',logs:'日志'})[row.name]} · {(row.bytes / 1048576).toFixed(1)} MB</p>)}<button type="button" className="btn ghost" disabled={busy || !storage.removable.length} onClick={() => act(async () => setStorage(await api.storageCleanup(storage.removable.map(row => row.path))))}>清理过期数据 · {storage.removable.length} 项</button></div>}
      <div className="wb-actions"><button className="btn primary" disabled={busy}>保存设置</button><span>Halora · 星环 {state.version}</span></div>
    </form>}
    {page === 'review' && (!cwd ? <p>先打开一个项目。</p> : review && <>
      <div className="wb-strip"><span>{remoteLine(review)}</span><span>{review.files.length} 个改动文件</span>{projectRunning && <span>项目正在运行</span>}</div>
      <div className="wb-review"><div className="wb-files">
          <div className="wb-files-head"><span>{review.files.filter(f => f.staged).length} 已暂存</span><div className="wb-actions"><button type="button" className="btn ghost" disabled={busy || projectRunning || !review.files.some(needsStage)} onClick={() => act(async () => setReview(await api.reviewStage({ cwd, all: true, unstage: false })))}>全部暂存</button><button type="button" className="btn ghost" disabled={busy || projectRunning || !review.files.some(f => f.staged)} onClick={() => act(async () => setReview(await api.reviewStage({ cwd, all: true, unstage: true })))}>全部取消</button></div></div>
          {review.files.length === 0 && <p>工作区没有改动。</p>}{review.files.map(f => <button key={f.path} className={selected === f.path ? 'selected' : ''} onClick={() => setSelected(f.path)}><code>{f.status}</code><span>{f.path}</span><small>{f.staged ? '已暂存' : ''}</small></button>)}</div>
        <div className="wb-diff">{selected ? <><div className="wb-strip"><strong>{selected}</strong><div className="wb-actions"><button className="btn ghost" disabled={busy} onClick={() => act(() => api.openPath(selected, cwd))}>打开</button><button className="btn ghost" disabled={busy || projectRunning} onClick={() => act(async () => setReview(await api.reviewStage({ cwd, files: [selected], unstage: false })))}>暂存</button><button className="btn ghost" disabled={busy || projectRunning || !review.files.find(f => f.path === selected)?.staged} onClick={() => act(async () => setReview(await api.reviewStage({ cwd, files: [selected], unstage: true })))}>取消暂存</button></div></div>
          {patch?.truncated && <p>差异较长，仅显示前 512 KB。</p>}<div className="wb-patch" tabIndex={0} role="region" aria-label="文件改动对比"><DiffContent patch={patch} /></div></> : <p>选择文件查看差异。</p>}</div></div>
      <form className="wb-commit" onSubmit={e => { e.preventDefault(); act(async () => { setReview(await api.reviewCommit({ cwd, message })); setMessage(''); setSelected(''); }); }}><input aria-label="提交说明" placeholder="提交说明" value={message} onChange={e => setMessage(e.target.value)} /><button className="btn primary" disabled={busy || projectRunning || !message.trim() || !review.files.some(f => f.staged)}>提交</button><button type="button" className="btn ghost" disabled={busy || projectRunning} onClick={() => act(async () => setReview(await api.reviewSync({ cwd })))}>{syncLabel(review)}</button></form>
    </>)}
    {page === 'checkpoints' && (!cwd ? <p>先打开一个项目。</p> : <>
      <h2>项目文件</h2><form className="wb-commit" onSubmit={e => { e.preventDefault(); act(async () => { await api.createCheckpoint({ cwd, label }); setLabel(''); await load(); }); }}><input aria-label="检查点名称" placeholder="检查点名称" value={label} onChange={e => setLabel(e.target.value)} /><button className="btn primary" disabled={busy || projectRunning}>建立检查点</button></form>
      {state.checkpointWarning && <p className="wb-error">{state.checkpointWarning}</p>}
      {checkpoints.length === 0 && <p>还没有文件检查点。</p>}
      <div className="wb-records">{checkpoints.map(c => <article key={c.id}><div><b>{c.label}</b><small>{when(c.at)} · {c.count} 个文件</small></div><button className="btn ghost" disabled={busy || projectRunning} onClick={() => act(async () => setRestore(await api.previewRestore({ cwd, id: c.id })))}>预览恢复</button><button className="btn ghost" disabled={busy || projectRunning} onClick={() => act(async () => {setCheckpoints(await api.deleteCheckpoint({cwd,id:c.id})); setRestore(null);})}>删除</button></article>)}</div>
      {restore && <div className="wb-restore"><h3>恢复「{restore.label}」</h3>{restore.files.length ? <ul>{restore.files.map(f => <li key={f.path}><b>{f.action}</b> {f.path}</li>)}</ul> : <p>文件内容一致。</p>}<button className="btn danger" disabled={busy || projectRunning || !restore.files.length} onClick={() => act(async () => { const r = await api.restoreCheckpoint({ cwd, ...restore }); if (!r.canceled) { await load(); } })}>恢复这些文件</button></div>}
      <h2>对话回退</h2>{pointError && <p className="wb-error">{pointError}</p>}{!state.sessionId ? <p>先打开一次对话。</p> : !points.length && !pointError ? <p>当前对话还没有回退点。</p> : null}
      <div className="wb-records">{points.map(p => <article key={p.index}><div><b>{String(p.label)}</b><small>{p.at ? when(p.at) : `第 ${p.index + 1} 轮`}</small></div><button className="btn ghost" disabled={busy || projectRunning} onClick={() => act(async () => { const r = await api.rewindExecute({ cwd, sessionId: state.sessionId, index: p.index }); if (!r.canceled) { setResult(r); await load(); } })}>回到此处</button></article>)}</div>
    </>)}
    {page === 'archives' && <div className="wb-settings">
      <h2>导出当前对话</h2><label>格式<select value={format} onChange={e => setFormat(e.target.value)}><option value="md">Markdown</option><option value="json">JSON</option><option value="html">HTML</option></select></label><button className="btn primary" disabled={busy || !state.sessionId || state.running} onClick={() => act(async () => setResult(await api.exportChat({ cwd, sessionId: state.sessionId, format })))}>导出对话</button>
      <h2>数据备份</h2><label>加密密码（可选）<input type="password" autoComplete="new-password" value={backupPassword} onChange={e => setBackupPassword(e.target.value)} /></label><button className="btn primary" disabled={busy || state.runningIds?.length > 0} onClick={() => act(async () => {setResult(await api.backupCreate(backupPassword)); setBackupPassword('');})}>{backupPassword ? '创建加密备份' : '创建未加密备份'}</button>
      <h2>恢复备份</h2><label>备份密码<input type="password" autoComplete="off" value={restorePassword} onChange={e => setRestorePassword(e.target.value)} /></label><button className="btn ghost" disabled={busy} onClick={() => act(async () => {setBackup(await api.backupInspect(restorePassword)); setRestorePassword('');})}>选择备份</button>{backup && <div className="wb-restore"><p>{backup.path}</p><p>{when(backup.at)} · {backup.count} 个文件</p><button className="btn danger" disabled={busy || state.runningIds?.length > 0} onClick={() => act(async () => setResult(await api.backupRestore()))}>恢复并重启</button></div>}
    </div>}
  </section>;
}
