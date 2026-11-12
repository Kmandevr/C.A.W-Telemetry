// Tests for the relay: the schema allow-list, every endpoint against a real SQLite standing in for D1, and the
// scheduled run against a fake GitHub. Run with `npm test` (Node 22.5+, for node:sqlite).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import worker, { summarise, isoWeek, compareVersions } from '../src/index.js';
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
const today = () => new Date().toISOString().slice(0, 10);

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
  const r = cleanReport({ ...report(), extra: 'x', device: { ...report().device, name: "Kim's phone", serial: 'R5CT1234' } });
  assert.equal(r.extra, undefined);
  assert.equal(r.device.name, undefined, 'a user-set device name is never kept');
  assert.equal(r.device.serial, undefined);
  assert.deepEqual(r.device.maxClockMHz, [3000, 2500, 1800]);
  assert.equal(r.perf.worstCallbackPct, 85);
  assert.equal(r.perf.startupMs, 1250);
  assert.equal(r.usage.minutesOpen, 45);
  assert.equal(r.usage.builtins.other, 2);
  assert.equal(r.usage.builtins['My Secret Synth'], undefined);
});

test('schema: platform, architecture, device, screen and peripherals', () => {
  const d = {
    ...report().device, platform: 'linux', arch: 'arm64', osName: 'Ubuntu', osVersion: '24.04',
    manufacturer: 'Raspberry Pi', model: 'Raspberry Pi 5 Model B', formFactor: 'desktop',
    screen: { widthPx: 2556, heightPx: 1179, dpi: 458, displays: 1 },
    audio: { ...report().device.audio, output: 'usb' },
    peripherals: [
      { kind: 'audio-interface', connection: 'usb', model: 'Scarlett 2i2 4th Gen', vendorId: '1235', productId: '8219', channels: 2, inUse: true, name: 'My studio' },
      { kind: 'midi', connection: 'bluetooth', inUse: false },
    ],
  };
  const r = cleanReport(report({ device: d }));
  assert.equal(r.device.arch, 'arm64');
  assert.equal(r.device.osVersion, '24.04');
  assert.equal(r.device.model, 'Raspberry Pi 5 Model B');
  assert.deepEqual(r.device.screen, { widthPx: 2560, heightPx: 1180, dpi: 460, displays: 1 });
  assert.equal(r.device.peripherals.length, 2);
  assert.equal(r.device.peripherals[0].name, undefined, 'peripheral names the user can set are dropped');
  assert.equal(r.device.peripherals[0].model, 'Scarlett 2i2 4th Gen');
  for (const p of ['ios', 'macos', 'windows', 'android']) assert.equal(cleanReport(report({ device: { ...d, platform: p } })).device.platform, p);
  assert.throws(() => cleanReport(report({ device: { ...d, arch: 'arm64e' } })));
  assert.throws(() => cleanReport(report({ device: { ...d, osVersion: '24.04 (Noble) build 5' } })));
  assert.throws(() => cleanReport(report({ device: { ...d, peripherals: [{ kind: 'midi', connection: 'usb', vendorId: 'XYZ1' }] } })));
  // The older, shorter device record still passes.
  assert.equal(cleanReport(report()).device.arch, undefined);
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

test('status: reports the token and repository access, under either secret name', async () => {
  const e = { ...env(), GITHUB_TOKEN: undefined, Github_Token: 'x' };
  globalThis.fetch = async (url, init) => {
    assert.equal(init.headers.authorization, 'Bearer x');
    return new Response(JSON.stringify({ full_name: 'Kmandevr/C.A.W-Telemetry', permissions: { push: true } }));
  };
  const res = await worker.fetch(req('GET', '/v1/status'), e);
  assert.deepEqual(await res.json(), { github: 'ok', repo: 'Kmandevr/C.A.W-Telemetry', canWrite: true, reportsWaiting: 0, feedbackWaiting: 0 });
  const none = await worker.fetch(req('GET', '/v1/status'), { ...env(), GITHUB_TOKEN: undefined });
  assert.deepEqual(await none.json(), { github: 'no token set' });
});

test('versions: ordered newest first, kept apart in the summary, optional build id checked', () => {
  const sorted = ['0.9.0', '1.0.0-beta.10', '1.0.0', '1.0.0-beta.2', '1.0.0-beta.1'].sort((a, b) => compareVersions(b, a));
  assert.deepEqual(sorted, ['1.0.0', '1.0.0-beta.10', '1.0.0-beta.2', '1.0.0-beta.1', '0.9.0']);
  const old = cleanReport(report({ receipt: receipt(2), app: { version: '1.0.0-beta.1', engineVersion: '1', capiVersion: 23 } }));
  const cur = cleanReport(report({ receipt: receipt(3), app: { version: '1.0.0-beta.2', engineVersion: '1', capiVersion: 24, build: 'abc1234' } }));
  cur.device.cpu = 'Newest CPU';
  const md = summarise([old, cur], '2026-W46', '- none');
  assert.match(md, /## Newest version: 1\.0\.0-beta\.2 \(abc1234\)/);
  assert.ok(md.indexOf('| 1.0.0-beta.2 (abc1234) | 1 + 0 |') < md.indexOf('| 1.0.0-beta.1 | 1 + 0 |'), 'newest row first');
  const newest = md.slice(md.indexOf('## Newest version'));
  assert.match(newest, /Newest CPU/);
  assert.ok(!newest.includes('Cortex-X2'), "the old version's devices stay out of the newest breakdown");
  assert.throws(() => cleanReport(report({ app: { version: '1.0.0', engineVersion: '1', capiVersion: 1, build: 'main' } })));
});

test('dashboard: served, in sync with its HTML; facts: compact rows of published reports only', async () => {
  const html = readFileSync(new URL('../src/dashboard.html', import.meta.url), 'utf8');
  const { DASHBOARD } = await import('../src/dashboard.js');
  assert.equal(DASHBOARD, html, 'src/dashboard.js is stale: run npm run build');
  const e = env();
  const page = await worker.fetch(new Request('https://relay.example/dashboard'), e);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /C\.A\.W Beta Telemetry/);
  globalThis.fetch = fakeGitHub().fetch;
  const d = { ...report().device, arch: 'arm64', model: 'SM-S906B', manufacturer: 'samsung',
    peripherals: [{ kind: 'midi', connection: 'usb', model: 'KeyStep 37' }] };
  await worker.fetch(req('POST', '/v1/report', report({ day: today(), device: d })), e);
  await worker.fetch(req('POST', '/v1/report', report({ receipt: receipt(9), day: today() })), e);
  await worker.scheduled({ scheduledTime: Date.now() }, e);
  await worker.fetch(req('POST', '/v1/report', report({ receipt: receipt(10), day: today() })), e);  // not yet published
  assert.equal((await worker.fetch(new Request('https://relay.example/v1/facts?days=3'), e)).status, 400);
  const res = await worker.fetch(new Request('https://relay.example/v1/facts?days=7'), e);
  const j = await res.json();
  assert.equal(j.rows.length, 2, 'only published reports');
  const rows = j.rows.map((r) => Object.fromEntries(j.columns.map((c, i) => [c, r[i]])));
  const s22 = rows.find((r) => r.model === 'SM-S906B');
  assert.equal(s22.arch, 'arm64');
  assert.deepEqual(s22.peripherals, [{ kind: 'midi', connection: 'usb', model: 'KeyStep 37' }]);
  assert.equal(s22.cpuLoad.length, 10);
  assert.ok(!JSON.stringify(j).includes('deleteHash'));
});

test('unknown measurements are null, never 0, and stay out of medians', () => {
  const r = cleanReport(report({
    device: { ...report().device, ramGB: null, refreshHz: undefined, maxClockMHz: [null, 2500], cpu: null, osVersion: null },
    perf: { ...report().perf, startupMs: null, cpuLoadHistogram: null, frames: { p50ms: null, p99ms: 9, slowPct: null } },
  }));
  assert.equal(r.device.ramGB, null);
  assert.equal(r.device.refreshHz, null);
  assert.deepEqual(r.device.maxClockMHz, [null, 2500]);
  assert.equal(r.device.cpu, null);
  assert.equal(r.perf.startupMs, null);
  assert.equal(r.perf.cpuLoadHistogram, null);
  const known = cleanReport(report({ receipt: receipt(4) }));
  const md = summarise([r, known], '2026-W46', '- none');
  assert.match(md, /Median startup: 1250 ms/, 'the unknown startup is skipped, not counted as 0');
  assert.match(summarise([r], '2026-W46', '- none'), /Median startup: unknown ms/);
});

test('report kind: stress runs count in stress results, not in device counts', () => {
  assert.equal(cleanReport(report()).kind, 'daily');
  assert.throws(() => cleanReport(report({ kind: 'hourly' })));
  const stressRun = { tiers: { normal: 'comfortable', heavy: 'tight', extreme: 'over' }, limits: { tracks: 20, voices: 40, effects: 30 },
    scenarios: {}, topCosts: [{ component: 'org.caw.flagship', pct: 40 }], version: 1 };
  const daily = cleanReport(report());
  const runs = [5, 6, 7].map((n) => cleanReport(report({ receipt: receipt(n), kind: 'stress', stress: stressRun,
    device: { ...report().device, cpu: 'Benchmark Fan CPU' } })));
  const md = summarise([daily, ...runs], '2026-W46', '- none');
  assert.match(md, /\| 1\.0\.0-beta\.1 \| 1 \+ 3 \|/);
  assert.ok(!md.includes('Benchmark Fan CPU'), 'stress runs do not count as extra devices');
  assert.match(md, /normal comfortable, heavy tight, extreme over \| 3 \|/);
});

test('isoWeek and summarise handle edges', () => {
  assert.equal(isoWeek(new Date('2026-01-01T00:00:00Z')), '2026-W01');
  assert.equal(isoWeek(new Date('2027-01-01T00:00:00Z')), '2026-W53');
  assert.match(summarise([], '2026-W46', '- none'), /0 reports/);
});
