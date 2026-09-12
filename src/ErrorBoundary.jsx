import React from 'react';
export class ErrorBoundary extends React.Component {
  state = { error: null };
  static getDerivedStateFromError(error) { return { error }; }
  componentDidCatch(error, info) { window.workshop?.reportError(String(error) + '\n' + info.componentStack).catch(() => {}); }
  render() {
    if (!this.state.error) return this.props.children;
    return <main style={{padding:32}}><h1>界面遇到问题</h1><p>你可以重新加载，或导出日志以便排查。</p><button onClick={() => location.reload()}>重新加载</button><button onClick={() => window.workshop?.exportDiagnostics()}>导出诊断日志</button></main>;
  }
}
