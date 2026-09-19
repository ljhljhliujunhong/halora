import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { DiffContent } from './Workbench.jsx';
import './turn-changes.css';

const api = window.workshop;
const errorText = error => String(error.message || error).replace(/^Error invoking remote method '[^']+': Error: /, '');
const pathKey = cwd => String(cwd || '').replace(/\\/g, '/').replace(/\/$/, '').toLowerCase();
const ChangeReviewContext = createContext(null);

export function useTurnChanges(cwd, sessionId) {
  const [state, setState] = useState({ key: '', records: [] });
  const key = JSON.stringify([cwd, sessionId]);
  useEffect(() => {
    if (!cwd || !sessionId) return;
    let active = true;
    const incoming = new Map();
    const off = api.onEvent(event => {
      const row = event.payload;
      if (event.type !== 'turn-changes' || row.sessionId !== sessionId || pathKey(row.cwd) !== pathKey(cwd)) return;
      incoming.set(row.id, row);
      setState(prev => ({ key, records: [...(prev.key === key ? prev.records : []).filter(r => r.id !== row.id), row].sort((a, b) => a.startedAt - b.startedAt) }));
    });
    api.turnChanges({ cwd, sessionId }).then(records => {
      if (!active) return;
      const merged = new Map(records.map(r => [r.id, r]));
      for (const [id, row] of incoming) merged.set(id, row);
      setState({ key, records: [...merged.values()].sort((a, b) => a.startedAt - b.startedAt) });
    }).catch(error => {
      if (active) setState({ key, records: [...incoming.values(), { id: 'load-error', files: [], warning: `修改记录读取失败：${errorText(error)}` }] });
    });
    return () => { active = false; off(); };
  }, [cwd, sessionId, key]);
  return state.key === key ? state.records : [];
}

export function ChangeReviewProvider({ cwd, sessionId, parked, children }) {
  const [review, setReview] = useState(null);
  useEffect(() => { setReview(null); }, [cwd, sessionId, parked]);
  const open = useCallback((record, file) => setReview({ record, file }), []);
  const close = useCallback(() => setReview(null), []);
  const toggle = useCallback((record, file) => setReview(prev => prev?.record.id === record.id && prev.file === file ? null : { record, file }), []);
  const value = useMemo(() => ({ review, open, close, toggle }), [review, open, close, toggle]);
  return <ChangeReviewContext.Provider value={value}>{children}</ChangeReviewContext.Provider>;
}

export function useChangeReview() {
  return useContext(ChangeReviewContext);
}

export function ChangeReviewShell({ parked, children }) {
  const { review } = useChangeReview();
  const [shown, setShown] = useState(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    let frame = 0, timer = 0;
    if (review && !parked) {
      setShown(review);
      frame = requestAnimationFrame(() => { frame = requestAnimationFrame(() => setOpen(true)); });
      return () => cancelAnimationFrame(frame);
    }
    setOpen(false);
    timer = window.setTimeout(() => setShown(null), 320);
    return () => clearTimeout(timer);
  }, [review, parked]);
  return <div className={`main-stage${parked ? ' is-parked' : ''}${open ? ' is-reviewing' : ''}`}>
    <div className="main-stage-chat">{children}</div>
    {shown && !parked ? <ChangeReviewPane session={shown} /> : null}
  </div>;
}

function Counts({ added, removed }) {
  if (added == null || removed == null) return <span className="change-file-kind">文件内容变更</span>;
  return <span className="change-counts"><span className="change-added">+{added}</span><span className="change-removed">-{removed}</span></span>;
}

function ChangeReviewPane({ session }) {
  const { close, open } = useChangeReview();
  const { record, file } = session;
  const [patch, setPatch] = useState(null);
  const [patchError, setPatchError] = useState('');
  const current = record.files.find(item => item.path === file) || record.files[0];
  useEffect(() => {
    let active = true;
    setPatch(null); setPatchError('');
    api.turnChangeDiff({ cwd: record.cwd, id: record.id, file })
      .then(value => { if (active) setPatch(value); })
      .catch(error => { if (active) setPatchError(errorText(error)); });
    return () => { active = false; };
  }, [record.cwd, record.id, file]);
  useEffect(() => {
    const onKey = event => { if (event.key === 'Escape') close(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [close]);
  return <aside className="change-drawer" aria-label={`${file} 本轮改动对比`}>
    <header className="change-drawer-head">
      <div className="change-drawer-title">
        <strong title={file}>{file}</strong>
        <span>{current?.action}</span>
      </div>
      <Counts added={current?.added} removed={current?.removed} />
      <button type="button" className="change-drawer-x" aria-label="关闭" onClick={close}>
        <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" /></svg>
      </button>
    </header>
    {record.files.length > 1 && <div className="change-drawer-files">{record.files.map(item => <button type="button" key={item.path} className={item.path === file ? 'selected' : ''} title={item.path} onClick={() => open(record, item.path)}>{item.path.split(/[\\/]/).pop()}</button>)}</div>}
    <div className="change-drawer-body wb-patch" tabIndex={0} role="region" aria-label={`${file} 本轮改动对比`}>{patchError ? <p className="change-error" role="alert">{patchError}</p> : <DiffContent patch={patch} compact />}</div>
  </aside>;
}

export function TurnChangesCard({ record, projectRunning }) {
  const { review, open, close, toggle } = useChangeReview();
  const [expanded, setExpanded] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const active = review?.record.id === record.id;
  const selected = active ? review.file : '';
  const undo = async () => {
    if (lock.current) return;
    lock.current = true; setBusy(true); setError('');
    try { await api.undoTurnChanges({ cwd: record.cwd, id: record.id }); }
    catch (error) { setError(errorText(error)); }
    finally { lock.current = false; setBusy(false); }
  };
  if (record.warning) return <div className="change-warning" role="status">{record.warning}</div>;
  if (!record.files.length) return null;
  const visible = expanded ? record.files : record.files.slice(0, 3);
  return <section className={`turn-changes${record.undone ? ' is-undone' : ''}`} aria-label="本轮文件修改">
    <header className="change-head">
      <span className="change-icon" aria-hidden="true">▤</span>
      <div className="change-summary"><strong>{record.undone ? '已撤销' : '已编辑'} {record.files.length} 个文件</strong><Counts added={record.added} removed={record.removed} /></div>
      <div className="change-actions">
        <button type="button" className="btn ghost" disabled={busy || projectRunning || record.undone} onClick={undo}>{busy ? '撤销中…' : record.undone ? '已撤销' : '撤销'} <span aria-hidden="true">↶</span></button>
        <button type="button" className="btn change-review-button" aria-expanded={active} onClick={() => { if (active) close(); else open(record, selected || record.files[0].path); }}>{active ? '收起' : '审核'}</button>
      </div>
    </header>
    <div className="change-files">{visible.map(file => <button type="button" key={file.path} className={`change-file${selected === file.path ? ' selected' : ''}`} title={`${file.action} · ${file.path}`} aria-expanded={selected === file.path} onClick={() => toggle(record, file.path)}>
      <span className="change-path">{file.path}</span><Counts added={file.added} removed={file.removed} />
    </button>)}</div>
    {record.files.length > 3 && <button type="button" className="change-expand" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>{expanded ? '收起文件' : `再显示 ${record.files.length - 3} 个文件`} <span className="change-chevron" aria-hidden="true"><svg viewBox="0 0 12 12" width="12" height="12"><path d="M2.5 4.5 6 8l3.5-3.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg></span></button>}
    {error && <p className="change-error" role="alert">{error}</p>}
  </section>;
}
