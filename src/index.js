// The C.A.W beta relay: a Cloudflare Worker between the app and this repository.
// - POST /v1/report, GET /v1/report/<receipt>, POST /v1/delete: anonymous telemetry, buffered in D1 and published
//   to data/ once a day by the scheduled run.
// - POST /v1/feedback: posts a public Issue in this repository; an optional contact email stays private in D1.
// The contract with the app is PLAN.md, "The contract with the app". Secrets: the GitHub token only (see PLAN.md).

import { cleanReport, cleanFeedback, SchemaError, RECEIPT, HASH } from './schema.js';

const REPORT_MAX = 8 * 1024;
const FEEDBACK_MAX = 32 * 1024;
const DELETE_MAX = 16 * 1024;
const KEEP_JSON_DAYS = 35;     // full reports stay in D1 this long, for the weekly summary and lookups
const KEEP_CONTACT_DAYS = 180;
// Free plan (Cloudflare docs, read 2026-11-12): 10 ms CPU and 50 subrequests per invocation, cron runs included.
// A run makes at most 3 commits x 5 GitHub calls + 5 for the summary + 10 feedback retries = 30 subrequests, and
// small commits keep the JSON work well under the CPU limit. The cron runs hourly, so this publishes up to
// 3,600 reports a day.
const COMMIT_BATCH = 50;       // files per commit
const COMMITS_PER_RUN = 3;
const FEEDBACK_RETRIES = 10;

const json = (status, body, extra = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...extra } });
const later = (why) => json(503, { error: why }, { 'retry-after': '86400' });

const today = () => new Date().toISOString().slice(0, 10);

async function sha256Hex(text) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function hexBytes(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(2 * i, 2 * i + 2), 16);
  return out;
}

async function bytesSha256Hex(bytes) {
  const d = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function readBody(request, max) {
  const len = Number(request.headers.get('content-length') || 0);
  if (len > max) return { tooLarge: true };
  const text = await request.text();
  if (text.length > max) return { tooLarge: true };
  try { return { value: JSON.parse(text) }; } catch { return { bad: 'not JSON' }; }
}

// Counters for the free-plan guard and per-sender limits. A sender is a SHA-256 of their address with a salt made
// fresh each UTC day and deleted the next day, so no address, or anything that links days, is ever kept.
async function senderKey(env, request) {
  const day = today();
  let row = await env.DB.prepare('SELECT salt FROM salts WHERE day = ?').bind(day).first();
  if (!row) {
    const salt = [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, '0')).join('');
    await env.DB.prepare('INSERT OR IGNORE INTO salts (day, salt) VALUES (?, ?)').bind(day, salt).run();
    row = await env.DB.prepare('SELECT salt FROM salts WHERE day = ?').bind(day).first();
  }
  const ip = request.headers.get('cf-connecting-ip') || 'none';
  return sha256Hex(`${row.salt}:${ip}`);
}

async function bump(env, table, key, limit) {
  const day = today();
  const row = await env.DB.prepare(
    `INSERT INTO ${table} (day, name, n) VALUES (?, ?, 1)
     ON CONFLICT (day, name) DO UPDATE SET n = n + 1 RETURNING n`).bind(day, key).first();
  return row.n <= limit;
}

const caps = (env) => ({
  // D1 free plan: 100,000 rows written a day. A report writes about 6 rows, a lookup 2, feedback 3: at these caps
  // the worst day is about 30,000 + 20,000 + 1,000, half the limit, before the hourly publishing's updates.
  reports: Number(env.DAILY_REPORT_CAP || 5000),
  feedback: Number(env.DAILY_FEEDBACK_CAP || 300),
  lookups: Number(env.DAILY_LOOKUP_CAP || 10000),
  reportsPerSender: 10,
  feedbackPerSender: 5,
  lookupsPerSender: 200,
});

// GitHub API. The token is the Worker secret GITHUB_TOKEN (the owner's is named Github_Token; both are read).
const githubToken = (env) => env.GITHUB_TOKEN || env.Github_Token || '';

async function gh(env, method, path, body, accept = 'application/vnd.github+json') {
  const res = await fetch(`https://api.github.com/repos/${env.REPO}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${githubToken(env)}`,
      accept,
      'user-agent': 'caw-telemetry-relay',
      'x-github-api-version': '2022-11-28',
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok && res.status !== 404) throw new Error(`GitHub ${method} ${path}: ${res.status}`);
  return res;
}

const reportPath = (receipt) => `data/${receipt.slice(0, 2)}/${receipt}.json`;
const published = (r) => { const { deleteHash, ...rest } = r; return rest; };

async function postReport(env, request) {
  const body = await readBody(request, REPORT_MAX);
  if (body.tooLarge) return json(413, { error: 'too large' });
  if (body.bad) return json(400, { error: body.bad });
  let r;
  try { r = cleanReport(body.value); } catch (e) {
    if (e instanceof SchemaError) return json(400, { error: e.message });
    throw e;
  }
  const c = caps(env);
  if (!(await bump(env, 'quota', 'reports', c.reports))) return later('daily capacity reached');
  if (!(await bump(env, 'senders', `r:${await senderKey(env, request)}`, c.reportsPerSender)))
    return json(429, { error: 'too many reports today' }, { 'retry-after': '86400' });
  const res = await env.DB.prepare(
    `INSERT OR IGNORE INTO reports (receipt, day, delete_hash, json, received) VALUES (?, ?, ?, ?, ?)`)
    .bind(r.receipt, r.day, r.deleteHash, JSON.stringify(published(r)), today()).run();
  if (!res.meta.changes) return json(400, { error: 'receipt already used' });
  return json(202, { status: 'queued' });
}

async function getReport(env, request, receipt) {
  if (!RECEIPT.test(receipt)) return json(404, { error: 'unknown' });
  const c = caps(env);
  if (!(await bump(env, 'quota', 'lookups', c.lookups))) return later('daily capacity reached');
  if (!(await bump(env, 'senders', `l:${await senderKey(env, request)}`, c.lookupsPerSender)))
    return json(429, { error: 'too many lookups today' }, { 'retry-after': '86400' });
  const row = await env.DB.prepare('SELECT json, committed, deleted FROM reports WHERE receipt = ?').bind(receipt).first();
  if (!row || row.deleted) return json(404, { error: 'unknown or deleted' });
  if (!row.committed) return json(202, { status: 'queued' });
  if (row.json) return new Response(row.json, { status: 200, headers: { 'content-type': 'application/json' } });
  const res = await gh(env, 'GET', `/contents/${reportPath(receipt)}`, null, 'application/vnd.github.raw+json');
  if (res.status === 404) return json(404, { error: 'unknown or deleted' });
  return new Response(await res.text(), { status: 200, headers: { 'content-type': 'application/json' } });
}

async function postDelete(env, request) {
  const body = await readBody(request, DELETE_MAX);
  if (body.tooLarge) return json(413, { error: 'too large' });
  if (body.bad) return json(400, { error: body.bad });
  const items = body.value && Array.isArray(body.value.items) ? body.value.items : null;
  if (!items || items.length > 100) return json(400, { error: 'items: expected a list of up to 100' });
  let deleted = 0;
  for (const it of items) {
    if (!it || typeof it.receipt !== 'string' || !RECEIPT.test(it.receipt)) continue;
    if (typeof it.deleteKey !== 'string' || !HASH.test(it.deleteKey)) continue;
    const row = await env.DB.prepare('SELECT delete_hash, committed, deleted FROM reports WHERE receipt = ?')
      .bind(it.receipt).first();
    if (!row || row.deleted) continue;
    if ((await bytesSha256Hex(hexBytes(it.deleteKey))) !== row.delete_hash) continue;
    // A committed report is removed from data/ by the next scheduled commit; until then it is hidden here.
    await env.DB.prepare('UPDATE reports SET deleted = 1, json = NULL WHERE receipt = ?').bind(it.receipt).run();
    deleted++;
  }
  return json(202, { deleted });
}

// Feedback text goes in a fenced block, so it can't mention people, embed images or run any markdown.
function fenced(text) {
  const longest = Math.max(0, ...(text.match(/`+/g) || []).map((s) => s.length));
  const fence = '`'.repeat(Math.max(3, longest + 1));
  return `${fence}text\n${text}\n${fence}`;
}

function feedbackIssue(f) {
  const first = f.text.trim().split('\n')[0].replace(/[@#<>`\[\]]/g, '').slice(0, 70).trim() || 'Feedback';
  const parts = [
    `**${f.kind}** from C.A.W ${f.appVersion} on ${f.platform}`,
    '',
    fenced(f.text),
  ];
  for (const [name, value] of Object.entries(f.attachments)) {
    if (value === undefined) continue;
    parts.push('', `<details><summary>Attached: ${name}</summary>`, '', fenced(JSON.stringify(value, null, 2)), '', '</details>');
  }
  parts.push('', '_Sent from the app through the beta relay. Contact details, if any, are never published._');
  return {
    title: `[${f.kind}] ${first}`,
    body: parts.join('\n'),
    labels: ['beta-feedback', `fb-${f.kind}`],
  };
}

async function createIssue(env, f) {
  const res = await gh(env, 'POST', '/issues', feedbackIssue(f));
  if (res.status === 404) throw new Error('GitHub issues: 404');
  return res.json();
}

async function postFeedback(env, request, ctx) {
  const body = await readBody(request, FEEDBACK_MAX);
  if (body.tooLarge) return json(413, { error: 'too large' });
  if (body.bad) return json(400, { error: body.bad });
  let f;
  try { f = cleanFeedback(body.value); } catch (e) {
    if (e instanceof SchemaError) return json(400, { error: e.message });
    throw e;
  }
  const c = caps(env);
  if (!(await bump(env, 'quota', 'feedback', c.feedback))) return later('daily capacity reached');
  if (!(await bump(env, 'senders', `f:${await senderKey(env, request)}`, c.feedbackPerSender)))
    return json(429, { error: 'too much feedback today' }, { 'retry-after': '86400' });
  try {
    const issue = await createIssue(env, f);
    if (f.contact) {
      await env.DB.prepare('INSERT INTO contacts (issue, contact, received) VALUES (?, ?, ?)')
        .bind(issue.number, f.contact, today()).run();
    }
    return json(201, { issue: issue.html_url });
  } catch {
    await env.DB.prepare('INSERT INTO feedback_queue (json, received) VALUES (?, ?)')
      .bind(JSON.stringify(f), today()).run();
    return json(202, { status: 'queued' });
  }
}

// The scheduled run: retry queued feedback, publish new reports and deletions in commits of many files, write the
// weekly summary on Mondays, and prune old rows.
async function commitFiles(env, entries, message) {
  const ref = await (await gh(env, 'GET', '/git/ref/heads/main')).json();
  const head = await (await gh(env, 'GET', `/git/commits/${ref.object.sha}`)).json();
  const tree = await (await gh(env, 'POST', '/git/trees', { base_tree: head.tree.sha, tree: entries })).json();
  const commit = await (await gh(env, 'POST', '/git/commits', { message, tree: tree.sha, parents: [ref.object.sha] })).json();
  await gh(env, 'PATCH', '/git/refs/heads/main', { sha: commit.sha });
}

async function publishReports(env) {
  for (let run = 0; run < COMMITS_PER_RUN; run++) {
    const adds = (await env.DB.prepare(
      'SELECT receipt, json FROM reports WHERE committed = 0 AND deleted = 0 LIMIT ?').bind(COMMIT_BATCH).all()).results;
    const dels = (await env.DB.prepare(
      'SELECT receipt FROM reports WHERE committed = 1 AND deleted = 1 AND removed = 0 LIMIT ?').bind(COMMIT_BATCH).all()).results;
    if (!adds.length && !dels.length) return;
    const entries = [
      ...adds.map((r) => ({ path: reportPath(r.receipt), mode: '100644', type: 'blob',
        content: JSON.stringify(JSON.parse(r.json), null, 2) + '\n' })),
      ...dels.map((r) => ({ path: reportPath(r.receipt), mode: '100644', type: 'blob', sha: null })),
    ];
    await commitFiles(env, entries, `Data ${today()}: ${adds.length} reports, ${dels.length} deletions`);
    const stmts = [
      ...adds.map((r) => env.DB.prepare('UPDATE reports SET committed = 1 WHERE receipt = ?').bind(r.receipt)),
      ...dels.map((r) => env.DB.prepare('UPDATE reports SET removed = 1 WHERE receipt = ?').bind(r.receipt)),
    ];
    await env.DB.batch(stmts);
  }
}

async function retryFeedback(env) {
  const rows = (await env.DB.prepare('SELECT id, json FROM feedback_queue ORDER BY id LIMIT ?').bind(FEEDBACK_RETRIES).all()).results;
  for (const row of rows) {
    const f = JSON.parse(row.json);
    try {
      const issue = await createIssue(env, f);
      if (f.contact) await env.DB.prepare('INSERT INTO contacts (issue, contact, received) VALUES (?, ?, ?)')
        .bind(issue.number, f.contact, today()).run();
      await env.DB.prepare('DELETE FROM feedback_queue WHERE id = ?').bind(row.id).run();
    } catch { return; }  // GitHub still unavailable: try again tomorrow
  }
}

export function isoWeek(date) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const year = d.getUTCFullYear();
  const week = Math.ceil(((d - Date.UTC(year, 0, 1)) / 86400000 + 1) / 7);
  return `${year}-W${String(week).padStart(2, '0')}`;
}

const tally = (map, key, n = 1) => map.set(key, (map.get(key) || 0) + n);
const top = (map, n = 10) => [...map].sort((a, b) => b[1] - a[1]).slice(0, n);
const median = (xs) => { if (!xs.length) return 0; const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };

export function summarise(reports, week, usage) {
  const platforms = new Map(), cpus = new Map(), tiers = new Map(), costs = new Map(), errs = new Map(), hints = new Map();
  const worst = [], startup = [], p99 = [];
  let withDropouts = 0;
  for (const r of reports) {
    tally(platforms, `${r.device.platform} ${r.device.osVersion}`);
    tally(cpus, r.device.cpu);
    tally(hints, `${r.device.platform}: ${r.perf.schedHint}, callback on ${r.perf.callbackCoreType} core`);
    worst.push(r.perf.worstCallbackPct); startup.push(r.perf.startupMs); p99.push(r.perf.frames.p99ms);
    if (r.perf.dropouts > 0) withDropouts++;
    if (r.stress) {
      tally(tiers, `normal ${r.stress.tiers.normal}, heavy ${r.stress.tiers.heavy}, extreme ${r.stress.tiers.extreme}`);
      for (const c of r.stress.topCosts) tally(costs, c.component, c.pct);
    }
    for (const e of r.errors) tally(errs, `${e.type} at ${e.where}`, e.count);
  }
  const rows = (m) => top(m).map(([k, v]) => `| ${k} | ${Math.round(v * 10) / 10} |`).join('\n') || '| (none) | |';
  const pct = (n) => reports.length ? `${Math.round((100 * n) / reports.length)}%` : '0%';
  return `# Beta summary, ${week}

${reports.length} reports. Every number here comes from the published files in \`data/\`.

## Performance
- Median worst callback: ${median(worst)}% of budget
- Reports with any dropout: ${pct(withDropouts)}
- Median startup: ${median(startup)} ms
- Median p99 frame time: ${median(p99)} ms

## Platforms
| Platform | Reports |
|---|---:|
${rows(platforms)}

## CPUs
| CPU | Reports |
|---|---:|
${rows(cpus)}

## Audio-thread scheduling
| Platform: hint, callback core | Reports |
|---|---:|
${rows(hints)}

## Stress tests
| Tiers | Runs |
|---|---:|
${rows(tiers)}

### What takes the time (summed share of each run's top costs)
| Component | Total % |
|---|---:|
${rows(costs)}

## Errors
| Error | Count |
|---|---:|
${rows(errs)}

## Relay usage against its free-plan caps (last 7 days)
${usage}
`;
}

async function weeklySummary(env, now) {
  if (now.getUTCDay() !== 1 || now.getUTCHours() !== 3) return;  // Mondays at 03:xx UTC: the week that just ended
  const end = new Date(now.getTime() - 86400000);
  const start = new Date(now.getTime() - 7 * 86400000);
  const from = start.toISOString().slice(0, 10), to = end.toISOString().slice(0, 10);
  const reports = (await env.DB.prepare(
    'SELECT json FROM reports WHERE day BETWEEN ? AND ? AND deleted = 0 AND json IS NOT NULL').bind(from, to).all())
    .results.map((r) => JSON.parse(r.json));
  const q = (await env.DB.prepare(
    'SELECT name, MAX(n) AS peak, SUM(n) AS total FROM quota WHERE day BETWEEN ? AND ? GROUP BY name').bind(from, to).all()).results;
  const c = caps(env);
  const usage = q.map((r) => `- ${r.name}: ${r.total} this week, busiest day ${r.peak} of ${c[r.name] ?? '?'}`).join('\n') || '- none';
  const week = isoWeek(end);
  await commitFiles(env, [{ path: `summaries/${week}.md`, mode: '100644', type: 'blob', content: summarise(reports, week, usage) }],
    `Summary ${week}`);
}

async function prune(env) {
  const day = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
  await env.DB.batch([
    env.DB.prepare('UPDATE reports SET json = NULL WHERE committed = 1 AND received < ?').bind(day(KEEP_JSON_DAYS)),
    env.DB.prepare('DELETE FROM contacts WHERE received < ?').bind(day(KEEP_CONTACT_DAYS)),
    env.DB.prepare('DELETE FROM salts WHERE day < ?').bind(today()),
    env.DB.prepare('DELETE FROM senders WHERE day < ?').bind(today()),
    env.DB.prepare('DELETE FROM quota WHERE day < ?').bind(day(14)),
  ]);
}

// For the owner and maintainers: is the GitHub token set, and can it write to the repository? Never shows the token.
async function status(env) {
  if (!githubToken(env)) return json(200, { github: 'no token set' });
  const res = await gh(env, 'GET', '');
  if (res.status === 404) return json(200, { github: 'token cannot see the repository' });
  const repo = await res.json();
  const pending = await env.DB.prepare('SELECT COUNT(*) AS n FROM reports WHERE committed = 0 AND deleted = 0').first();
  const queued = await env.DB.prepare('SELECT COUNT(*) AS n FROM feedback_queue').first();
  return json(200, { github: 'ok', repo: repo.full_name, canWrite: !!repo.permissions?.push,
    reportsWaiting: pending.n, feedbackWaiting: queued.n });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const keys = String(env.APP_KEYS || '').split(',').map((s) => s.trim()).filter(Boolean);
    if (url.pathname === '/' && request.method === 'GET') return json(200, { service: 'caw-telemetry relay', schema: 1 });
    if (!keys.includes(request.headers.get('x-caw-app-key') || '')) return json(401, { error: 'unknown app key' });
    try {
      if (url.pathname === '/v1/report' && request.method === 'POST') return await postReport(env, request);
      if (url.pathname.startsWith('/v1/report/') && request.method === 'GET')
        return await getReport(env, request, url.pathname.slice('/v1/report/'.length));
      if (url.pathname === '/v1/delete' && request.method === 'POST') return await postDelete(env, request);
      if (url.pathname === '/v1/feedback' && request.method === 'POST') return await postFeedback(env, request, ctx);
      if (url.pathname === '/v1/status' && request.method === 'GET') return await status(env);
      return json(404, { error: 'not found' });
    } catch {
      return later('temporarily unavailable');  // never echo internals; the app keeps its item queued
    }
  },

  async scheduled(event, env, ctx) {
    const now = new Date(event.scheduledTime);
    await retryFeedback(env);
    await publishReports(env);
    await weeklySummary(env, now);
    if (now.getUTCHours() === 3) await prune(env);
  },
};
