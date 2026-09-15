import { applyUpdate } from './transcript.js';

export function stampActiveAssistant(messages, turn) {
  if (!turn?.turnId || !turn.startedAt) return messages;
  const last = messages.at(-1);
  if (last?.role !== 'assistant' || last.endedAt || last.durationMs != null) return messages;
  if (last.turnId && last.turnId !== turn.turnId) return messages;
  return [...messages.slice(0, -1), { ...last, turnId: turn.turnId, startedAt: turn.startedAt }];
}

export function applyTimedUpdate(messages, update, turn) {
  return stampActiveAssistant(applyUpdate(messages, update), turn);
}

export function finishTimedTurn(messages, turn) {
  return messages.map(message => message.role === 'assistant' && message.turnId === turn.turnId
    ? { ...message, startedAt: turn.startedAt, endedAt: turn.endedAt, durationMs: turn.durationMs }
    : message);
}

export function finishActiveTurn(active, turn) {
  if (active[turn.sessionId]?.turnId !== turn.turnId) return active;
  const next = { ...active };
  delete next[turn.sessionId];
  return next;
}
