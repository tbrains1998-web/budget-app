// Unit test for the Gecko test harness (test/lib/bidi.mjs): the BiDi connection never leaves a command hanging, and opening the fresh tab after a browser (re)start survives
// the start tab being replaced meanwhile ("no such frame", DiscardedBrowsingContextError; once seen in
// `gecko.mjs --firefox`, item 15). A fake BiDi connection, no browser.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { BidiConnection, isGoneContextError, openFreshTab } from '../lib/bidi.mjs';

const GONE = 'browsingContext.create: no such frame DiscardedBrowsingContextError: BrowsingContext does no longer exist';

/** A fake connection: `script` maps a method to a list of results (an Error is thrown), used in order. */
function fakeConn(script) {
  const calls = [];
  return {
    calls,
    async send(method, params = {}) {
      calls.push([method, params.context || null]);
      const list = script[method];
      const next = list && list.length > 1 ? list.shift() : list && list[0];
      if (next instanceof Error) throw next;
      return typeof next === 'function' ? next(params) : next;
    },
  };
}

test('openFreshTab: one try when nothing goes wrong; closes the start tabs, not the new one', async () => {
  const conn = fakeConn({
    'browsingContext.getTree': [{ contexts: [{ context: 'start-1' }, { context: 'start-2' }] }],
    'browsingContext.create': [{ context: 'new-1' }],
    'browsingContext.close': [{}],
  });
  assert.deepEqual(await openFreshTab(conn, { waitMs: 1 }), { context: 'new-1', attempts: 1 });
  assert.deepEqual(conn.calls, [['browsingContext.getTree', null], ['browsingContext.create', null],
    ['browsingContext.close', 'start-1'], ['browsingContext.close', 'start-2']]);
});

test('openFreshTab: a start tab replaced during create -> waits and tries again, reading the tabs again', async () => {
  const conn = fakeConn({
    'browsingContext.getTree': [{ contexts: [{ context: 'start-1' }] }, { contexts: [{ context: 'start-1b' }, { context: 'left-over' }] }],
    'browsingContext.create': [new Error(GONE), { context: 'new-2' }],
    'browsingContext.close': [{}],
  });
  assert.deepEqual(await openFreshTab(conn, { waitMs: 1 }), { context: 'new-2', attempts: 2 });
  assert.deepEqual(conn.calls.filter(([m]) => m === 'browsingContext.close').map(([, c]) => c), ['start-1b', 'left-over']);
});

test('openFreshTab: a start tab that is already gone when it is closed is fine', async () => {
  const conn = fakeConn({
    'browsingContext.getTree': [{ contexts: [{ context: 'start-1' }] }],
    'browsingContext.create': [{ context: 'new-3' }],
    'browsingContext.close': [new Error('browsingContext.close: no such frame Browsing context with id start-1 not found')],
  });
  assert.deepEqual(await openFreshTab(conn, { waitMs: 1 }), { context: 'new-3', attempts: 1 });
});

test('openFreshTab: other errors are not retried; a tab that keeps going away fails after `tries`', async () => {
  const other = fakeConn({ 'browsingContext.getTree': [{ contexts: [] }], 'browsingContext.create': [new Error('browsingContext.create: unknown error boom')] });
  await assert.rejects(openFreshTab(other, { waitMs: 1 }), /boom/);
  assert.equal(other.calls.filter(([m]) => m === 'browsingContext.create').length, 1);
  const always = fakeConn({ 'browsingContext.getTree': [{ contexts: [] }], 'browsingContext.create': [new Error(GONE)] });
  await assert.rejects(openFreshTab(always, { tries: 3, waitMs: 1 }), /DiscardedBrowsingContextError/);
  assert.equal(always.calls.filter(([m]) => m === 'browsingContext.create').length, 3);
});

test('isGoneContextError: only the "tab or frame is gone" errors', () => {
  assert.ok(isGoneContextError(new Error(GONE)));
  assert.ok(isGoneContextError(new Error('browsingContext.close: no such window x')));
  assert.ok(!isGoneContextError(new Error('script.evaluate: javascript error')));
  assert.ok(!isGoneContextError(null));
});

// ---- BidiConnection: a command to a browser that already quit must reject, never hang. Before, a
// failed restart in gecko.mjs item 15 left S.b on the quit browser; the next command was written to the closed socket
// (WebSocket.send does not throw then), its answer never came, and Node ended the run half way without its summary
// (exit code 13, "unsettled top-level await").

/** A stand-in for an open WebSocket: send() silently drops data once closed, as a real one does. */
class FakeSocket extends EventTarget {
  readyState = 1;
  sent = [];
  send(text) {
    if (this.readyState !== 1) return; // a real WebSocket discards it without an error
    this.sent.push(JSON.parse(text));
  }
  close() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.dispatchEvent(new Event('close'));
  }
  answer(id, result) {
    const ev = new Event('message');
    ev.data = JSON.stringify({ type: 'success', id, result });
    this.dispatchEvent(ev);
  }
}

/** Rejects with HANG when p does not settle within ms. */
function settlesWithin(p, ms = 500) {
  let timer;
  const hang = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('HANG: the command never settled')), ms);
  });
  return Promise.race([p, hang]).finally(() => clearTimeout(timer));
}

test('BidiConnection: answers resolve; a command still waiting when the socket closes rejects', async () => {
  const ws = new FakeSocket();
  const conn = BidiConnection.attach(ws);
  const first = conn.send('browsingContext.getTree', { maxDepth: 0 });
  assert.equal(ws.sent[0].method, 'browsingContext.getTree');
  ws.answer(ws.sent[0].id, { contexts: [] });
  assert.deepEqual(await settlesWithin(first), { contexts: [] });
  const waiting = conn.send('script.evaluate', {});
  ws.close();
  await assert.rejects(settlesWithin(waiting), /BiDi connection closed/);
  assert.equal(conn.closed, true);
});

test('BidiConnection: a command sent after the browser quit rejects at once (it used to hang)', async () => {
  const ws = new FakeSocket();
  const conn = BidiConnection.attach(ws);
  ws.close();
  await assert.rejects(settlesWithin(conn.send('browsingContext.captureScreenshot', {})), /captureScreenshot: BiDi connection closed/);
  assert.equal(ws.sent.length, 0, 'nothing was written to the closed socket');
  // A socket that dropped without a close event yet (readyState CLOSING / CLOSED) is closed too.
  const ws2 = new FakeSocket();
  const conn2 = BidiConnection.attach(ws2);
  ws2.readyState = 2;
  await assert.rejects(settlesWithin(conn2.send('script.evaluate', {})), /BiDi connection closed/);
  conn2.close();
});

test('BidiConnection: an error thrown by send() rejects the command (no hang)', async () => {
  const ws = new FakeSocket();
  ws.send = () => {
    throw new Error('InvalidStateError: still connecting');
  };
  const conn = BidiConnection.attach(ws);
  await assert.rejects(settlesWithin(conn.send('session.status', {})), /still connecting/);
});

test('gecko-lib uses this connection class (one copy, so the e2e runs get the same fix)', async () => {
  const src = await readFile(new URL('../e2e/gecko-lib.mjs', import.meta.url), 'utf8');
  assert.match(src, /import \{[^}]*\bBidiConnection\b[^}]*\} from '\.\.\/lib\/bidi\.mjs'/);
  assert.doesNotMatch(src, /class BidiConnection\b/);
});

test('openFreshTab: by default it keeps trying for several seconds (a restart can replace the start tab for a while)', async () => {
  const conn = fakeConn({
    'browsingContext.getTree': [{ contexts: [] }],
    'browsingContext.create': [new Error(GONE), new Error(GONE), new Error(GONE), new Error(GONE), new Error(GONE), new Error(GONE), { context: 'new-7' }],
  });
  // 6 failures (more than the 5 tries used before), then a tab: waitMs shortened, the default number of tries kept.
  assert.deepEqual(await openFreshTab(conn, { waitMs: 1 }), { context: 'new-7', attempts: 7 });
});

test('openFreshTab: no new tab in all tries -> drives a start tab that still answers (reused), else throws', async () => {
  const conn = fakeConn({
    'browsingContext.getTree': [{ contexts: [{ context: 'start-old' }, { context: 'start-new' }] }],
    'browsingContext.create': [new Error(GONE)],
    'browsingContext.navigate': [(p) => {
      if (p.context === 'start-new') throw new Error('browsingContext.navigate: no such frame gone');
      return { navigation: 'n1', url: 'about:blank' };
    }],
  });
  assert.deepEqual(await openFreshTab(conn, { tries: 3, waitMs: 1 }), { context: 'start-old', attempts: 3, reused: true });
  assert.equal(conn.calls.filter(([m]) => m === 'browsingContext.create').length, 3);
  assert.deepEqual(conn.calls.filter(([m]) => m === 'browsingContext.navigate').map(([, c]) => c), ['start-new', 'start-old']);
  const none = fakeConn({ 'browsingContext.getTree': [{ contexts: [{ context: 's' }] }], 'browsingContext.create': [new Error(GONE)],
    'browsingContext.navigate': [new Error('browsingContext.navigate: no such frame gone')] });
  await assert.rejects(openFreshTab(none, { tries: 2, waitMs: 1 }), /DiscardedBrowsingContextError/);
});
