import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import './workbench.css';
import { diffRows, diffSections } from './diff.mjs';

function GlassSelect({ value, onChange, options, ariaLabel }) {
  const [open, setOpen] = useState(false);
  const [box, setBox] = useState(null);
  const root = useRef(null);
  const pop = useRef(null);
  const current = options.find((item) => item.value === value) || options[0];
  useLayoutEffect(() => {
    if (!open) return;
    const btn = root.current?.querySelector('.glass-select-btn');
    if (!btn) return;
    const rect = btn.getBoundingClientRect();
    const width = Math.max(rect.width, 168);
    let left = rect.left;
    if (left + width > window.innerWidth - 12) left = Math.max(12, window.innerWidth - width - 12);
    if (left < 12) left = 12;
    let top = rect.bottom + 8;
    const estHeight = Math.min(options.length * 44 + 16, 280);
    if (top + estHeight > window.innerHeight - 12) top = Math.max(12, rect.top - estHeight - 8);
    setBox({ top, left, width });
  }, [open, options.length]);
  useEffect(() => {
    if (!open) return;
    const close = (event) => {
      if (root.current?.contains(event.target) || pop.current?.contains(event.target)) return;
      setOpen(false);
    };
    const onKey = (event) => {
      if (event.key === 'Escape') setOpen(false);
    };
    const onScroll = (event) => {
      if (pop.current?.contains(event.target)) return;
      setOpen(false);
    };
    document.addEventListener('pointerdown', close);
    document.addEventListener('keydown', onKey);
    document.addEventListener('scroll', onScroll, true);
    return () => {
      document.removeEventListener('pointerdown', close);
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('scroll', onScroll, true);
    };
  }, [open]);
  return (
    <div className={`glass-select ${open ? 'open' : ''}`} ref={root}>
      <button
        type="button"
        className="glass-select-btn"
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((next) => !next)}
      >
        <span>{current?.label || value}</span>
      </button>
      {open && box
        ? createPortal(
            <div
              ref={pop}
              className="glass-select-pop"
              data-theme={document.querySelector('.app')?.getAttribute('data-theme') || 'light'}
              role="listbox"
              style={{ top: box.top, left: box.left, width: box.width }}
            >
              {options.map((item) => (
                <button
                  type="button"
                  key={String(item.value)}
                  role="option"
                  aria-selected={item.value === value}
                  className={item.value === value ? 'active' : ''}
                  onClick={() => {
                    onChange(item.value);
                    setOpen(false);
                  }}
                >
                  <span>{item.label}</span>
                  <em>{item.value === value ? '✓' : ''}</em>
                </button>
              ))}
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}
const api = window.workshop;
const labels = { review: '改动审查', checkpoints: '检查点', settings: '设置', archives: '导出与备份' };
const when = at => at ? new Date(at).toLocaleString() : '未知';

export function DiffContent({ patch, compact }) {
  if (!patch) return <p>读取差异…</p>;
  if (patch.binary) return <p>{patch.text}</p>;
  if (!patch.text) return <p>内容未改变，可能是文件模式或重命名。</p>;
  const rows = compact ? diffSections(patch.text) : diffRows(patch.text);
  return <pre className="diff-code">{rows.map((row, index) => row.kind === 'unmodified'
    ? <span key={index} className="diff-line diff-unmodified"><span className="diff-fold">{row.text}</span></span>
    : <span key={index} className={`diff-line diff-${row.kind}`}><span className="diff-number" aria-label="原行号">{row.old}</span><span className="diff-number" aria-label="新行号">{row.next}</span><span className="diff-text">{row.text || ' '}</span></span>)}</pre>;
}

const needsStage = f => f.untracked || f.status[1] !== ' ';
const syncLabel = review => review.ahead && !review.behind ? `推送 ${review.ahead}` : review.behind && !review.ahead ? `拉取 ${review.behind}` : '同步';
const remoteLine = review => [review.branch, review.ahead ? `领先 ${review.ahead}` : '', review.behind ? `落后 ${review.behind}` : ''].filter(Boolean).join(' · ');

export function Workbench({ page, state, onState, onClose }) {
  const [busy, setBusy] = useState(false);
  const [busyLabel, setBusyLabel] = useState('');
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
  const restoreBox = useRef(null);
  const cwd = state.cwd;
  const projectRunning = (state.projects || []).find(p => p.cwd === cwd)?.sessions.some(s => (state.runningIds || []).includes(s.id));
  const act = async (fn, label = '') => {
    if (actionLock.current) return;
    actionLock.current = true;
    setBusy(true); setBusyLabel(label); setError(''); setResult(null);
    try { return await fn(); } catch (e) { setError(String(e.message || e).replace(/^Error invoking remote method '[^']+': Error: /, '')); }
    finally { actionLock.current = false; setBusy(false); setBusyLabel(''); }
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
  useEffect(() => {
    if (!restore) return;
    restoreBox.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [restore]);
  const field = (key, value) => setPrefs(p => ({ ...p, [key]: value }));
  return <section className={page === 'review' ? 'workbench wb-fill' : 'workbench'}>
    <header className="wb-head"><div><small>{cwd?.split(/[\\/]/).pop() || 'Halora'}</small><h1>{labels[page]}</h1></div>
      <div className="wb-actions">{['review', 'checkpoints'].includes(page) && <button className="btn ghost" disabled={busy || !cwd} onClick={() => act(load)}>刷新</button>}<button className="btn ghost" onClick={onClose}>返回对话</button></div>
    </header>
    {error && <div className="wb-error" role="alert">{error}</div>}
    {result && <div className="wb-result">{result.path || result.backup || result.text}{(result.path || result.backup) && <button className="btn ghost" onClick={() => api.showInFolder(result.path || result.backup).catch(e => setError(e.message))}>在文件夹中显示</button>}{result.relaunch && <button type="button" className="btn primary" onClick={() => api.relaunchApp()}>重启星环</button>}</div>}
    {busy && <div className="wb-progress" role="status">{busyLabel || '正在处理…'}</div>}
    {page === 'settings' && <form className="wb-settings" onSubmit={e => { e.preventDefault(); act(async () => { onState(await api.savePreferences(prefs)); setResult({text:'设置已保存'}); }); }}>
      <h2>对话</h2>
      <label>默认模型<GlassSelect ariaLabel="默认模型" value={prefs.modelId || ''} onChange={(value) => field('modelId', value)} options={[...new Set([prefs.modelId, ...(state.models || []).map(m => m.id)])].filter(Boolean).map(id => ({ value: id, label: id }))} /></label>
      <label>默认思考强度<GlassSelect ariaLabel="默认思考强度" value={prefs.effort === 'minimal' || prefs.effort === 'none' ? 'low' : (prefs.effort || '')} onChange={(value) => field('effort', value)} options={[{ value: '', label: '跟随模型' }, { value: 'low', label: '低' }, { value: 'medium', label: '中' }, { value: 'high', label: '高' }, { value: 'xhigh', label: '最高' }]} /></label>
      <label>默认权限模式<GlassSelect ariaLabel="默认权限模式" value={prefs.permissionMode || 'agent'} onChange={(value) => field('permissionMode', value)} options={[{ value: 'agent', label: '代理 · 执行前询问' }, { value: 'plan', label: '规划' }, { value: 'yolo', label: '自动允许工具操作' }]} /></label>
      <label>自动压缩阈值 <span><input type="number" min="50" max="95" value={prefs.autoCompact ?? 85} onChange={e => field('autoCompact', Number(e.target.value))} /> %</span></label>
      <label>发送快捷键<GlassSelect ariaLabel="发送快捷键" value={prefs.sendKey || 'enter'} onChange={(value) => field('sendKey', value)} options={[{ value: 'enter', label: 'Enter' }, { value: 'ctrl-enter', label: 'Ctrl + Enter' }]} /></label>
      <label>默认项目<div className="wb-actions"><input value={prefs.defaultCwd || ''} onChange={e => field('defaultCwd', e.target.value)} /><button type="button" className="btn ghost" onClick={() => act(async () => { const dir = await api.pickFolder(); if (dir) field('defaultCwd', dir); })}>选择</button></div></label>
      <h2>外观</h2>
      {state.settingsWarning && <p role="alert">{state.settingsWarning}</p>}
      <label>主题<GlassSelect ariaLabel="主题" value={prefs.theme || 'light'} onChange={(value) => field('theme', value)} options={[{ value: 'light', label: '浅色' }, { value: 'dark', label: '深色' }, { value: 'system', label: '跟随系统' }]} /></label>
      <label>字号 <span><input type="number" min="12" max="20" value={prefs.fontSize ?? 14} onChange={e => field('fontSize', Number(e.target.value))} /> px</span></label>
      <h2>恢复</h2>
      <label>任务运行时确认退出<input type="checkbox" checked={prefs.confirmExit !== false} onChange={e => field('confirmExit', e.target.checked)} /></label>
      <label>发送前建立文件检查点<input type="checkbox" checked={prefs.checkpoints !== false} onChange={e => field('checkpoints', e.target.checked)} /></label>
      <h2>更新</h2>
      <label>Grok Build<div className="wb-actions">{busyLabel ? <span>{busyLabel}</span> : grokUpdate && <span>{grokUpdate.pendingRestart ? `${grokUpdate.current || grokUpdate.latest} · 重启后生效` : grokUpdate.available ? `${grokUpdate.current} → ${grokUpdate.latest}` : `${grokUpdate.current} · 已是最新`}</span>}<button type="button" className="btn ghost" disabled={busy} onClick={() => act(async () => setGrokUpdate(await api.grokCheckUpdate()), '正在检查更新…')}>检查更新</button>{grokUpdate?.available && !grokUpdate.pendingRestart && <button type="button" className="btn primary" disabled={busy} onClick={() => act(async () => { const info = await api.grokInstallUpdate(); if (info) setGrokUpdate(info); }, '正在更新 Grok Build…')}>更新</button>}{grokUpdate?.pendingRestart && <button type="button" className="btn primary" disabled={busy} onClick={() => api.relaunchApp()}>重启星环</button>}</div></label>
      <h2>存储与诊断</h2>
      <div className="wb-actions"><button type="button" className="btn ghost" disabled={busy} onClick={() => act(async () => setStorage(await api.storageInspect()))}>查看存储</button><button type="button" className="btn ghost" disabled={busy} onClick={() => act(async () => setResult(await api.exportDiagnostics()))}>导出诊断日志</button></div>
      {storage && <div>{storage.usage.map(row => <p key={row.name}>{({checkpoints:'检查点','turn-changes':'对话修改记录',inbox:'附件',backups:'恢复备份','rewind-backups':'回退备份',trash:'已删除对话',logs:'日志'})[row.name]} · {(row.bytes / 1048576).toFixed(1)} MB</p>)}<button type="button" className="btn ghost" disabled={busy || !storage.removable.length} onClick={() => act(async () => setStorage(await api.storageCleanup(storage.removable.map(row => row.path))))}>清理过期数据 · {storage.removable.length} 项</button></div>}
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
      <div className="wb-records">{checkpoints.map(c => <article key={c.id} className={`wb-record${restore?.id === c.id ? ' open' : ''}`}>
        <div className="wb-record-main"><div><b>{c.label}</b><small>{when(c.at)} · {c.count} 个文件</small></div><div className="wb-actions"><button className="btn ghost" disabled={busy || projectRunning} onClick={() => { if (restore?.id === c.id) { setRestore(null); return; } act(async () => setRestore(await api.previewRestore({ cwd, id: c.id })), '正在对比文件…'); }}>恢复</button><button className="btn ghost" disabled={busy || projectRunning} onClick={() => act(async () => {setCheckpoints(await api.deleteCheckpoint({cwd,id:c.id})); setRestore(null);})}>删除</button></div></div>
        {restore?.id === c.id && <div className="wb-restore" ref={restoreBox}>{restore.files.length ? <ul className="wb-restore-files">{restore.files.map(f => <li key={f.path}><em>{f.action}</em><span>{f.path}</span></li>)}</ul> : <p>没有需要改回的文件。</p>}<div className="wb-actions">{restore.files.length > 0 && <button type="button" className="btn ghost" disabled={busy || projectRunning} onClick={() => act(async () => { const r = await api.restoreCheckpoint({ cwd, ...restore }); if (!r.canceled) { await load(); } })}>确认恢复</button>}<button type="button" className="btn ghost" disabled={busy} onClick={() => setRestore(null)}>取消</button></div></div>}
      </article>)}</div>
      <h2>对话回退</h2>{pointError && <p className="wb-error">{pointError}</p>}{!state.sessionId ? <p>先打开一次对话。</p> : !points.length && !pointError ? <p>当前对话还没有回退点。</p> : null}
      <div className="wb-records">{points.map(p => <article key={p.index}><div><b>{String(p.label)}</b><small>{p.at ? when(p.at) : `第 ${p.index + 1} 轮`}</small></div><div className="wb-actions"><button className="btn ghost" disabled={busy || projectRunning} onClick={() => act(async () => { const r = await api.rewindExecute({ cwd, sessionId: state.sessionId, index: p.index }); if (!r.canceled) { setResult(r); await load(); } })}>回到此处</button></div></article>)}</div>
    </>)}
    {page === 'archives' && <div className="wb-settings">
      <h2>导出当前对话</h2><label>格式<GlassSelect ariaLabel="导出格式" value={format} onChange={setFormat} options={[{ value: 'md', label: 'Markdown' }, { value: 'json', label: 'JSON' }, { value: 'html', label: 'HTML' }]} /></label><button className="btn primary" disabled={busy || !state.sessionId || state.running} onClick={() => act(async () => setResult(await api.exportChat({ cwd, sessionId: state.sessionId, format })))}>导出对话</button>
      <h2>数据备份</h2><label>加密密码（可选）<input type="password" autoComplete="new-password" value={backupPassword} onChange={e => setBackupPassword(e.target.value)} /></label><button className="btn primary" disabled={busy || state.runningIds?.length > 0} onClick={() => act(async () => {setResult(await api.backupCreate(backupPassword)); setBackupPassword('');})}>{backupPassword ? '创建加密备份' : '创建未加密备份'}</button>
      <h2>恢复备份</h2><label>备份密码<input type="password" autoComplete="off" value={restorePassword} onChange={e => setRestorePassword(e.target.value)} /></label><button className="btn ghost" disabled={busy} onClick={() => act(async () => {setBackup(await api.backupInspect(restorePassword)); setRestorePassword('');})}>选择备份</button>{backup && <div className="wb-restore"><p>{backup.path}</p><p>{when(backup.at)} · {backup.count} 个文件</p><button className="btn danger" disabled={busy || state.runningIds?.length > 0} onClick={() => act(async () => setResult(await api.backupRestore()))}>恢复并重启</button></div>}
    </div>}
  </section>;
}
