const test = require('node:test');
const assert = require('node:assert/strict');
const { placeTurnChanges } = require('../src/turn-changes-place.mjs');

test('matched file lists stay on their own replies', () => {
  const messages = [
    { id: 'a1', role: 'assistant', turnId: 't1', startedAt: 1000, text: 'old' },
    { id: 'u2', role: 'user', sentAt: 5000, text: 'new' },
    { id: 'a2', role: 'assistant', turnId: 't2', startedAt: 5100, text: 'reply' },
  ];
  const records = [
    { id: 'r1', turnId: 't1', startedAt: 1000 },
    { id: 'r2', turnId: 't2', startedAt: 5100 },
  ];
  const { cards, byIndex } = placeTurnChanges(messages, records);
  assert.equal(cards.get('a1').id, 'r1');
  assert.equal(cards.get('a2').id, 'r2');
  assert.equal(byIndex.size, 0);
});

test('an older file list stays above a later question when its reply has no turn id', () => {
  const messages = [
    { id: 'a-old', role: 'assistant', text: 'thirty nine files' },
    { id: 'u-mid', role: 'user', text: '继续执行' },
    { id: 'a-eight', role: 'assistant', turnId: 't8', startedAt: 3000, text: 'eight' },
    { id: 'u-new', role: 'user', sentAt: 5000, text: '加个 exe' },
    { id: 'a-live', role: 'assistant', turnId: 't-live', startedAt: 5100, text: '启动程序' },
  ];
  const records = [
    { id: 'r39', turnId: 't39', startedAt: 2000 },
    { id: 'r8', turnId: 't8', startedAt: 3000 },
  ];
  const { cards, byIndex } = placeTurnChanges(messages, records);
  assert.equal(cards.get('a-eight').id, 'r8');
  assert.equal(cards.has('a-live'), false);
  assert.deepEqual(byIndex.get(1).map(record => record.id), ['r39']);
});

test('sending a new question does not leave the previous file list below it', () => {
  const messages = [
    { id: 'a1', role: 'assistant', text: 'old work' },
    { id: 'u2', role: 'user', sentAt: 5000, text: '新问题' },
  ];
  const { cards, byIndex } = placeTurnChanges(messages, [{ id: 'r1', turnId: 't1', startedAt: 1000 }]);
  assert.equal(cards.size, 0);
  assert.deepEqual(byIndex.get(1).map(record => record.id), ['r1']);
  assert.equal(byIndex.has(2), false);
});

test('a later reply cannot inherit an older file list', () => {
  const messages = [
    { id: 'a1', role: 'assistant', text: 'old' },
    { id: 'u2', role: 'user', sentAt: 5000, text: 'new' },
    { id: 'a2', role: 'assistant', turnId: 't1', startedAt: 5100, text: 'stolen' },
  ];
  const { cards, byIndex } = placeTurnChanges(messages, [{ id: 'r1', turnId: 't1', startedAt: 1000 }]);
  assert.equal(cards.has('a2'), false);
  assert.deepEqual(byIndex.get(1).map(record => record.id), ['r1']);
});

test('the earliest reply keeps the list when a later one repeats its turn id', () => {
  const messages = [
    { id: 'a1', role: 'assistant', turnId: 't1', startedAt: 1000 },
    { id: 'u2', role: 'user', sentAt: 5000, text: 'new' },
    { id: 'a2', role: 'assistant', turnId: 't1', startedAt: 5100 },
  ];
  const { cards, byIndex } = placeTurnChanges(messages, [{ id: 'r1', turnId: 't1', startedAt: 1000 }]);
  assert.equal(cards.get('a1').id, 'r1');
  assert.equal(byIndex.size, 0);
});
