const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { parseQuota } = require('../electron/billing.cjs');
const { applyTimedUpdate, finishTimedTurn, finishActiveTurn, stampActiveAssistant } = require('../src/turn-timing.mjs');

const zeroCredits = () => ({ config: {
  currentPeriod: { type: 'USAGE_PERIOD_TYPE_WEEKLY', start: '2026-09-15T04:21:27Z', end: '2026-09-22T04:21:27Z' },
  isUnifiedBillingUser: true, onDemandCap: { val: 0 }, onDemandUsed: {}, prepaidBalance: {},
} });

test('credits rollover accepts omitted proto zero but rejects missing or malformed quota', () => {
  assert.equal(parseQuota(zeroCredits()).percent, 0);
  for (const config of [{}, { currentPeriod: zeroCredits().config.currentPeriod },
    { ...zeroCredits().config, creditUsagePercent: null },
    { ...zeroCredits().config, creditUsagePercent: '' },
    { ...zeroCredits().config, creditUsagePercent: false },
    { ...zeroCredits().config, creditUsagePercent: 101 },
    { ...zeroCredits().config, currentPeriod: { type: 'USAGE_PERIOD_TYPE_WEEKLY' } },
    { ...zeroCredits().config, productUsage: [{ product: 'PRODUCT_CHAT', usagePercent: 12 }] },
  ]) assert.equal(parseQuota({ config }), null);
  assert.equal(parseQuota({ config: { creditUsagePercent: 71, productUsage: [{ product: 'PRODUCT_GROK_BUILD', usagePercent: 20 }] } }).percent, 71);
  assert.equal(parseQuota({ config: { productUsage: [{ product: 'PRODUCT_GROK_BUILD', usagePercent: 20 }] } }).percent, 20);
});

function billingHarness(fetch) {
  const sandbox = { module: { exports: {} }, Buffer, fetch, AbortController, setTimeout, clearTimeout,
    require: name => name === './grok-path.cjs' ? { grokHome: () => 'fixture' }
      : name === 'node:fs' ? { readFileSync: () => JSON.stringify({ test: { key: 'test-token' } }) } : require(name) };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../electron/billing.cjs'), 'utf8'), sandbox);
  return sandbox.module.exports;
}

test('manual refresh bypasses cached old usage and recovers from failures to a new zero-usage period', async () => {
  let requests = 0, fail = false, rollover = false;
  const billing = billingHarness(async url => {
    if (url.includes('/billing?')) {
      requests++;
      if (fail) throw new Error('network unavailable');
      return { ok: true, json: async () => rollover ? zeroCredits() : { creditUsagePercent: 77 } };
    }
    if (url.includes('/settings')) return { ok: true, json: async () => ({ subscription_tier_display: 'SuperGrok' }) };
    throw new Error('optional resets unavailable');
  });
  assert.equal((await billing.fetchQuota()).percent, 77);
  await billing.fetchQuota(); assert.equal(requests, 1);
  fail = true;
  await assert.rejects(billing.fetchQuota({ force: true }), /network/);
  fail = false; rollover = true;
  const results = await Promise.all([billing.fetchQuota({ force: true }), billing.fetchQuota({ force: true })]);
  assert.equal(requests, 3);
  assert.equal(results[0].percent, 0);
  assert.equal(results[0].resetAt, '2026-09-22T04:21:27Z');
  assert.equal(results[0].resets, null);
});

test('steering keeps a new timer when an old completion is applied after the new response', () => {
  const old = { sessionId: 'a', turnId: 'a:1', startedAt: 1000, endedAt: 5000, durationMs: 4000 };
  const next = { sessionId: 'a', turnId: 'a:2', startedAt: 6000 };
  const chunk = text => ({ sessionUpdate: 'agent_message_chunk', content: { text } });
  let messages = applyTimedUpdate([{ id: 'local-1', role: 'user', text: 'first' }], chunk('first reply'), old);
  messages.push({ id: 'local-2', role: 'user', text: 'steering' });
  messages = applyTimedUpdate(messages, chunk('next reply'), next);
  messages = finishTimedTurn(messages, old);
  const active = finishActiveTurn({ a: next, b: { turnId: 'b:1', startedAt: 3000 } }, old);
  assert.equal(active.a.startedAt, 6000);
  assert.equal(messages[1].durationMs, 4000);
  assert.equal(messages[3].startedAt, 6000);
  assert.equal(messages[3].endedAt, undefined);
  assert.equal(11000 - messages[3].startedAt, 5000);
  const done = { ...next, endedAt: 13000, durationMs: 7000 };
  messages = finishTimedTurn(messages, done);
  assert.equal(messages[3].durationMs, 7000);
  assert.equal(finishActiveTurn(active, done).b.turnId, 'b:1');
  assert.equal(finishActiveTurn(active, done).a, undefined);
});

test('restoring a live transcript recovers its timer without altering completed history', () => {
  const turn = { sessionId: 'a', turnId: 'a:2', startedAt: 6000 };
  const history = [{ role: 'assistant', text: 'old', durationMs: 1000 }, { role: 'user', text: 'next' }, { role: 'assistant', text: 'live' }];
  const restored = stampActiveAssistant(history, turn);
  assert.equal(restored[0].durationMs, 1000);
  assert.equal(restored[2].startedAt, 6000);
  assert.equal(history[2].startedAt, undefined);
  assert.equal(stampActiveAssistant(history.slice(0, 1), turn)[0].startedAt, undefined);
});
