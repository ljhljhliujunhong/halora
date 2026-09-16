// Queue of things Grok is waiting on the user for: permission prompts, plan
// approvals and clarifying questions. `answer(requestId, option, item, extra)`
// is expected to deliver the reply over ACP; `changed(items)` mirrors the queue
// to the renderer.
class PermissionQueue {
  constructor(answer, changed) { this.items = []; this.answer = answer; this.changed = changed; }
  add(item) {
    if (this.items.some(p => p.requestId === item.requestId)) return;
    this.items.push(item); this.changed(this.items);
  }
  resolve(id, option, extra) {
    const item = this.items.find(p => p.requestId === id);
    if (!item) throw new Error('这项请求已结束');
    if (option !== '__cancel__' && !item.options.some(p => p.id === option)) throw new Error('无效的权限选项');
    this.answer(id, option, item, extra);
    this.items = this.items.filter(p => p !== item); this.changed(this.items);
  }
  cancelSession(id) {
    for (const item of [...this.items]) if (item.sessionId === id) {
      try { this.answer(item.requestId, '__cancel__', item); } catch {}
      this.items = this.items.filter(p => p !== item);
    }
    this.changed(this.items);
  }
  clear() { this.items = []; this.changed(this.items); }
}
module.exports = { PermissionQueue };
