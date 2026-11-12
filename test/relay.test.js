// Tests for the relay: the schema allow-list, every endpoint against a real SQLite standing in for D1, and the
// scheduled run against a fake GitHub. Run with `npm test` (Node 22.5+, for node:sqlite).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import worker, { summarise, isoWeek } from '../src/index.js';
import { cleanReport, cleanFeedback } from '../src/schema.js';

// D1's API over node:sqlite.
function fakeD1() {
  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync(new URL('../schema/d1.sql', import.meta.url), 'utf8'));
  const stmt = (sql, args = []) => ({
    bind: (...a) => stmt(sql, a),
    first: async () => db.prepare(sql).get(...args) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...args) }),
    run: async () => { const r = db.prepare(sql).run(...args); return { meta: { changes: r.changes } }; },
  });
  return { db, prepare: (sql) => stmt(sql), batch: async (list) => Promise.all(list.map((s) => s.run())) };
}

// GitHub's API, recording what the relay sends.
function fakeGitHub() {
  const calls = [];
  let issue = 0;
  const fetch = async (url, init = {}) => {
    const path = new URL(url).pathname.replace('/repos/Kmandevr/C.A.W-Telemetry', '');
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ method: init.method, path, body });
    const ok = (v, status = 200) => new Response(JSON.stringify(v), { status });
    if (path === '/issues') { issue++; return ok({ number: issue, html_url: `https://github.com/x/${issue}` }, 201); }
    if (path === '/git/ref/heads/main') return ok({ object: { sha: 'head' } });
    if (path.startsWith('/git/commits/')) return ok({ tree: { sha: 'tree0' } });
    if (path === '/git/trees') return ok({ sha: 'tree1' });
    if (path === '/git/commits') return ok({ sha: 'commit1' });
    if (path === '/git/refs/heads/main') return ok({});
    return new Response('{}', { status: 404 });
  };
  return { calls, fetch };
}

const KEY = 'a'.repeat(64);
const hashOf = (hex) => createHash('sha256').update(Buffer.from(hex, 'hex')).digest('hex');
const receipt = (n) => n.toString(16).padStart(32, '0');

function report(over = {}) {
  return {
    schema: 1, receipt: receipt(1), deleteHash: hashOf(KEY), channel: 'beta', day: '2026-11-16',
    app: { version: '1.0.0-beta.1', engineVersion: '1.0.0', capiVersion: 24 },
    device: {
      platform: 'android', osVersion: '14', cpu: 'Cortex-X2/A710/A510', cores: { big: 1, little: 4, other: 3 },
      maxClockMHz: [2995, 2496, 1804], ramGB: 8, gpu: 'Mali-G710', refreshHz: 120,
      audio: { backend: 'aaudio', exclusive: true, lowLatency: true, bufferFrames: 192, sampleRate: 48000 },
      profile: 'full', eco: false,
    },
    perf: {
      cpuLoadHistogram: [0.5, 0.2, 0.1, 0.1, 0.05, 0.05, 0, 0, 0, 0], dropouts: 2, worstCallbackPct: 83,
      frames: { p50ms: 4.17, p99ms: 9.04, slowPct: 1 }, startupMs: 1234, thermalEvents: 0, batterySaverMinutes: 0,
      schedHint: 'on', callbackCoreType: 'big',
    },
    usage: {
      minutesOpen: 47, minutesPlaying: 21, screens: { arrange: 30, build: 12 },
      builtins: { 'org.caw.flagship': 3, 'reverb.pro': 1, 'My Secret Synth': 2 },
      projectSize: { tracks: '5-8', clips: '11-50' },
    },
    stress: null,
    errors: [{ type: 'StateError', where: 'lib/ui/shell.dart:120', count: 1 }],
    ...over,
  };
}

function env() {
  return { DB: fakeD1(), REPO: 'Kmandevr/C.A.W-Telemetry', APP_KEYS: 'k1', GITHUB_TOKEN: 't' };
}

const req = (method, path, body, key = 'k1') => new Request(`https://relay.example${path}`, {
  method, headers: { 'x-caw-app-key': key, 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.9' },
  body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
});

test('schema: rounds, drops unknown fields, turns unknown ids into "other"', () => {
  const r = cleanReport({ ...report(), extra: 'x', device: { ...report().device, model: 'SM-S906B' } });
  assert.equal(r.extra, undefined);
  assert.equal(r.device.model, undefined);
  assert.deepEqual(r.device.maxClockMHz, [3000, 2500, 1800]);
  assert.equal(r.perf.worstCallbackPct, 85);
  assert.equal(r.perf.startupMs, 1250);
  assert.equal(r.usage.minutesOpen, 45);
  assert.equal(r.usage.builtins.other, 2);
  assert.equal(r.usage.builtins['My Secret Synth'], undefined);
});

test('schema: rejects wrong types and bad formats', () => {
  assert.throws(() => cleanReport(report({ receipt: 'nothex' })));
  assert.throws(() => cleanReport(report({ channel: 'nightly' })));
  assert.throws(() => cleanReport({ ...report(), perf: { ...report().perf, dropouts: '2' } }));
  assert.throws(() => cleanReport({ ...report(), errors: [{ type: 'X', where: '/home/me/file.dart:1', count: 1 }] }));
  assert.throws(() => cleanFeedback({ schema: 1, kind: 'bug', text: '   ', appVersion: '1.0.0', platform: 'android' }));
  assert.throws(() => cleanFeedback({ schema: 1, kind: 'bug', text: 'x', appVersion: '1.0.0', platform: 'android', contact: 'not an email' }));
});

test('app key is required', async () => {
  const res = await worker.fetch(req('POST', '/v1/report', report(), 'wrong'), env());
  assert.equal(res.status, 401);
});

test('report: accepted, looked up as queued, then published and found', async () => {
  const e = env();
  const gh = fakeGitHub();
  globalThis.fetch = gh.fetch;
  assert.equal((await worker.fetch(req('POST', '/v1/report', report()), e)).status, 202);
  assert.equal((await worker.fetch(req('POST', '/v1/report', report()), e)).status, 400, 'a receipt is used once');
  assert.equal((await worker.fetch(req('GET', `/v1/report/${receipt(1)}`), e)).status, 202);
  await worker.scheduled({ scheduledTime: Date.parse('2026-11-17T03:17:00Z') }, e);
  const tree = gh.calls.find((c) => c.path === '/git/trees').body.tree;
  assert.equal(tree[0].path, `data/00/${receipt(1)}.json`);
  const file = JSON.parse(tree[0].content);
  assert.equal(file.deleteHash, undefined, 'the delete hash is never published');
  assert.equal(file.receipt, receipt(1));
  const got = await worker.fetch(req('GET', `/v1/report/${receipt(1)}`), e);
  assert.equal(got.status, 200);
  assert.deepEqual(await got.json(), file);
});

test('report: size limit, bad JSON, per-sender limit', async () => {
  const e = env();
  assert.equal((await worker.fetch(req('POST', '/v1/report', 'x'.repeat(9000)), e)).status, 413);
  assert.equal((await worker.fetch(req('POST', '/v1/report', '{oops'), e)).status, 400);
  for (let i = 0; i < 10; i++)
    assert.equal((await worker.fetch(req('POST', '/v1/report', report({ receipt: receipt(100 + i) })), e)).status, 202);
  assert.equal((await worker.fetch(req('POST', '/v1/report', report({ receipt: receipt(200) })), e)).status, 429);
});

test('no IP address is stored anywhere', async () => {
  const e = env();
  await worker.fetch(req('POST', '/v1/report', report()), e);
  const dump = JSON.stringify(['reports', 'senders', 'salts', 'quota'].map((t) => e.DB.db.prepare(`SELECT * FROM ${t}`).all()));
  assert.ok(!dump.includes('203.0.113.9'));
});

test('delete: the right key deletes, a wrong key does not, and the file is removed from data/', async () => {
  const e = env();
  const gh = fakeGitHub();
  globalThis.fetch = gh.fetch;
  await worker.fetch(req('POST', '/v1/report', report()), e);
  await worker.scheduled({ scheduledTime: Date.parse('2026-11-17T03:17:00Z') }, e);
  const wrong = await worker.fetch(req('POST', '/v1/delete', { items: [{ receipt: receipt(1), deleteKey: 'b'.repeat(64) }] }), e);
  assert.deepEqual(await wrong.json(), { deleted: 0 });
  const right = await worker.fetch(req('POST', '/v1/delete', { items: [{ receipt: receipt(1), deleteKey: KEY }] }), e);
  assert.deepEqual(await right.json(), { deleted: 1 });
  assert.equal((await worker.fetch(req('GET', `/v1/report/${receipt(1)}`), e)).status, 404);
  gh.calls.length = 0;
  await worker.scheduled({ scheduledTime: Date.parse('2026-11-18T03:17:00Z') }, e);
  const tree = gh.calls.find((c) => c.path === '/git/trees').body.tree;
  assert.deepEqual(tree, [{ path: `data/00/${receipt(1)}.json`, mode: '100644', type: 'blob', sha: null }]);
});

test('feedback: posted as a fenced issue, contact kept private, queued when GitHub fails', async () => {
  const e = env();
  const gh = fakeGitHub();
  globalThis.fetch = gh.fetch;
  const fb = { schema: 1, kind: 'bug', text: 'Crash @everyone ```` ![x](http://e/x.png)', appVersion: '1.0.0-beta.1',
    platform: 'android', contact: 'me@example.com', attachments: { device: report().device } };
  const res = await worker.fetch(req('POST', '/v1/feedback', fb), e);
  assert.equal(res.status, 201);
  const issue = gh.calls.find((c) => c.path === '/issues').body;
  assert.deepEqual(issue.labels, ['beta-feedback', 'fb-bug']);
  assert.ok(issue.body.includes('`````text\nCrash @everyone'), 'the text is fenced beyond its own backticks');
  assert.ok(!issue.title.includes('@'));
  assert.ok(!issue.body.includes('me@example.com'), 'the contact is never published');
  assert.equal(e.DB.db.prepare('SELECT contact FROM contacts').get().contact, 'me@example.com');

  globalThis.fetch = async () => new Response('{}', { status: 502 });
  assert.equal((await worker.fetch(req('POST', '/v1/feedback', { ...fb, contact: undefined }), e)).status, 202);
  assert.equal(e.DB.db.prepare('SELECT COUNT(*) AS n FROM feedback_queue').get().n, 1);
  globalThis.fetch = gh.fetch;
  await worker.scheduled({ scheduledTime: Date.parse('2026-11-18T03:17:00Z') }, e);
  assert.equal(e.DB.db.prepare('SELECT COUNT(*) AS n FROM feedback_queue').get().n, 0);
});

test('weekly summary on Mondays only', async () => {
  const e = env();
  const gh = fakeGitHub();
  globalThis.fetch = gh.fetch;
  await worker.fetch(req('POST', '/v1/report', report({ day: '2026-11-12' })), e);
  await worker.scheduled({ scheduledTime: Date.parse('2026-11-15T03:17:00Z') }, e);  // Sunday
  assert.ok(!gh.calls.some((c) => Array.isArray(c.body?.tree) && c.body.tree.some((t) => t.path.startsWith('summaries/'))));
  await worker.scheduled({ scheduledTime: Date.parse('2026-11-16T03:17:00Z') }, e);  // Monday
  const t = gh.calls.filter((c) => c.path === '/git/trees').flatMap((c) => c.body.tree).find((x) => x.path.startsWith('summaries/'));
  assert.equal(t.path, 'summaries/2026-W46.md');
  assert.match(t.content, /1 reports/);
  assert.match(t.content, /Cortex-X2/);
});

test('isoWeek and summarise handle edges', () => {
  assert.equal(isoWeek(new Date('2026-01-01T00:00:00Z')), '2026-W01');
  assert.equal(isoWeek(new Date('2027-01-01T00:00:00Z')), '2026-W53');
  assert.match(summarise([], '2026-W46', '- none'), /0 reports/);
});
