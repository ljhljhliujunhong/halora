// A file list belongs to the turn that produced it. If that turn's reply
// cannot be identified, keep the list ahead of any later question instead of
// pinning it to the bottom of the thread.

function messageTime(message) {
  return message?.startedAt || message?.sentAt || 0;
}

function afterLaterQuestion(messages, message, record) {
  if (!record.startedAt) return false;
  const index = messages.indexOf(message);
  for (let i = 0; i < index; i += 1) {
    const sent = messages[i].sentAt || 0;
    if (messages[i].role === 'user' && sent > record.startedAt) return true;
  }
  return false;
}

function matchMessage(messages, record, used) {
  const open = messages.filter(item => item.role === 'assistant' && item.id && !used.has(item.id) && !afterLaterQuestion(messages, item, record));
  if (record.turnId) {
    const exact = open.find(item => item.turnId === record.turnId && (!record.startedAt || !item.startedAt || item.startedAt === record.startedAt));
    if (exact) return exact;
  }
  if (record.startedAt) {
    const byTime = open.find(item => item.startedAt === record.startedAt && (!item.turnId || item.turnId === record.turnId));
    if (byTime) return byTime;
  }
  return null;
}

function anchorIndex(messages, record) {
  if (!record.startedAt) return messages.length;
  for (let i = 0; i < messages.length; i += 1) {
    const time = messageTime(messages[i]);
    if (!time || time <= record.startedAt) continue;
    if (messages[i].role !== 'assistant') return i;
    let cursor = i - 1;
    while (cursor >= 0 && messages[cursor].kind === 'compact') cursor -= 1;
    if (cursor >= 0 && messages[cursor].role === 'user') return cursor;
    return i;
  }
  return messages.length;
}

export function placeTurnChanges(messages, records) {
  const cards = new Map();
  const used = new Set();
  const loose = [];
  const sorted = [...(records || [])].sort((a, b) => (a.startedAt || 0) - (b.startedAt || 0));
  for (const record of sorted) {
    const message = matchMessage(messages || [], record, used);
    if (message) {
      cards.set(message.id, record);
      used.add(message.id);
    } else loose.push(record);
  }
  const byIndex = new Map();
  for (const record of loose) {
    const index = anchorIndex(messages || [], record);
    const list = byIndex.get(index);
    if (list) list.push(record);
    else byIndex.set(index, [record]);
  }
  return { cards, byIndex };
}
