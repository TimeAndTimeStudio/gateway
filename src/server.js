'use strict';

const express = require('express');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const AdmZip = require('adm-zip');

const app = express();
const PORT = Number(process.env.PORT || 10000);
const STORE = process.env.STORE_DIR || '/var/data/starling';
const PUBLIC_URL = (process.env.GATEWAY_PUBLIC_URL || '').replace(/\/$/, '');
const GH_TOKEN = process.env.GITHUB_TOKEN || '';
const GH_OWNER = process.env.GITHUB_OWNER || 'starling-client';
const GH_REPO = process.env.GITHUB_REPO || 'mod-builds';
const GH_REF = process.env.GITHUB_REF || 'main';
const GH_WORKFLOW = process.env.GITHUB_WORKFLOW || 'build.yml';
const MAX_BODY = 32 * 1024 * 1024;
const LIBRARY = 'libhorizon_android.so';
const JOB_RE = /^[0-9a-f]{24}$/;
const ASK_RE = /^[0-9a-f]{32}$/;
const POLL_MS = Number(process.env.POLL_MS || 15000);
const MAX_ACTIVE = Number(process.env.MAX_ACTIVE || 8);
const MAX_QUEUE = Number(process.env.MAX_QUEUE || 24);
const JOB_TIMEOUT_MS = 75 * 60 * 1000;
const FAILURE_TTL_MS = 60 * 60 * 1000;

fs.mkdirSync(path.join(STORE, 'github'), { recursive: true });
fs.mkdirSync(path.join(STORE, 'results'), { recursive: true });
const stateFile = path.join(STORE, 'state.json');
let state = { jobs: {} };
try { state = JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch {}
if (!state.jobs || typeof state.jobs !== 'object') state = { jobs: {} };

function saveState() {
  const tmp = `${stateFile}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state));
  fs.renameSync(tmp, stateFile);
}
function json(res, code, value) { res.status(code).type('application/json').send(JSON.stringify(value)); }
function jobDir(job) { return path.join(STORE, 'results', job); }
function githubBody(ask) { return path.join(STORE, 'github', ask); }
function validVersion(v) { return /^\d+(\.\d+){1,3}$/.test(v || ''); }
function ghHeaders(extra = {}) {
  return { Authorization: `Bearer ${GH_TOKEN}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'starling-node-gateway', ...extra };
}
async function ghApi(method, endpoint, payload) {
  const response = await fetch(`https://api.github.com/repos/${GH_OWNER}/${GH_REPO}${endpoint}`, {
    method, headers: ghHeaders(payload ? { 'Content-Type': 'application/json' } : {}),
    body: payload ? JSON.stringify(payload) : undefined,
    signal: AbortSignal.timeout(30000)
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`GitHub API ${response.status}: ${text.slice(0, 500)}`);
  return text ? JSON.parse(text) : null;
}
function safeError(err) { return String(err?.message || err || 'Build failed').slice(0, 600); }

// Starling uploads the binary mod bundle as application/octet-stream to this endpoint.
app.post('/v1/build', express.raw({ type: '*/*', limit: MAX_BODY }), async (req, res) => {
  try {
    if (!GH_TOKEN || !PUBLIC_URL) return json(res, 503, { error: 'Gateway is not configured: set GITHUB_TOKEN and GATEWAY_PUBLIC_URL.' });
    const body = req.body;
    if (!Buffer.isBuffer(body) || body.length === 0 || body.length > MAX_BODY) return json(res, 413, { error: 'That is too big to compile.' });
    const url = new URL(req.originalUrl, 'https://gateway.invalid');
    const version = url.searchParams.get('version') || '';
    if (!validVersion(version)) return json(res, 400, { error: 'That is not a version of the game.' });

    // Match Starling's gateway request identity for GitHub builds.
    const identity = `/v1/build?version=${version}`;
    const requestHash = crypto.createHash('sha256').update(Buffer.concat([Buffer.from(identity), body])).digest('hex');
    const job = requestHash.slice(0, 24);
    const old = state.jobs[job];
    if (old && old.state !== 'failed') return json(res, 200, { job });
    if (old && old.state === 'failed' && Date.now() - old.updated < FAILURE_TTL_MS) {
      return json(res, 200, { job });
    }
    const active = Object.values(state.jobs).filter(j => ['waiting', 'asked', 'queued', 'building'].includes(j.state));
    if (active.length >= MAX_QUEUE) return json(res, 429, { error: 'The line for GitHub is full. Try again in a few minutes.' });

    const ask = crypto.randomBytes(16).toString('hex');
    fs.writeFileSync(githubBody(ask), body, { flag: 'wx' });
    state.jobs[job] = { job, ask, requestHash, version, state: 'waiting', created: Date.now(), updated: Date.now() };
    saveState();
    await dispatchWaiting();
    return json(res, 200, { job });
  } catch (err) {
    console.error('POST /v1/build:', err);
    return json(res, 500, { error: 'Could not queue the build. Try again later.' });
  }
});

app.get('/v1/github/:ask', (req, res) => {
  const ask = req.params.ask;
  if (!ASK_RE.test(ask)) return json(res, 404, { error: 'No such thing here.' });
  const file = githubBody(ask);
  if (!fs.existsSync(file)) return json(res, 404, { error: 'No such thing here.' });
  res.type('application/octet-stream').sendFile(file);
});

app.get('/v1/job/:job', (req, res) => {
  const job = req.params.job;
  if (!JOB_RE.test(job)) return json(res, 404, { error: 'No such thing here.' });
  const entry = state.jobs[job];
  if (!entry) return json(res, 404, { error: 'No such job.' });
  if (entry.state === 'done') {
    try { return json(res, 200, JSON.parse(fs.readFileSync(path.join(jobDir(job), 'status.json'), 'utf8'))); }
    catch { return json(res, 503, { error: 'The build result is not available.' }); }
  }
  if (entry.state === 'failed') return json(res, 200, { state: 'failed', error: entry.error || 'The build failed.', settled: false });
  if (entry.state === 'building') return json(res, 200, { state: 'building', seconds: Math.floor((Date.now() - (entry.started || entry.created)) / 1000) });
  const ahead = Object.values(state.jobs).filter(j => j.state === 'waiting' && j.created < entry.created).length;
  return json(res, 200, { state: 'queued', ahead });
});

app.get('/v1/job/:job/lib', (req, res) => {
  const job = req.params.job;
  if (!JOB_RE.test(job)) return json(res, 404, { error: 'No such thing here.' });
  const entry = state.jobs[job];
  const file = path.join(jobDir(job), LIBRARY);
  if (!entry || entry.state !== 'done' || !fs.existsSync(file)) return json(res, 404, { error: 'No such job.' });
  const size = fs.statSync(file).size;
  let start = 0;
  const match = /^bytes=(\d+)-$/.exec(req.get('Range') || '');
  if (match && Number(match[1]) < size) start = Number(match[1]);
  res.status(start ? 206 : 200);
  res.set({ 'Content-Type': 'application/octet-stream', 'Content-Length': String(size - start) });
  if (start) res.set('Content-Range', `bytes ${start}-${size - 1}/${size}`);
  fs.createReadStream(file, { start }).pipe(res);
});

async function dispatchWaiting() {
  const active = Object.values(state.jobs).filter(j => ['asked', 'queued', 'building'].includes(j.state)).length;
  let slots = Math.max(0, MAX_ACTIVE - active);
  const waiting = Object.values(state.jobs).filter(j => j.state === 'waiting').sort((a, b) => a.created - b.created);
  for (const entry of waiting) {
    if (slots <= 0) break;
    try {
      await ghApi('POST', `/actions/workflows/${encodeURIComponent(GH_WORKFLOW)}/dispatches`, {
        ref: GH_REF,
        inputs: { ask: entry.ask, version: entry.version, gateway: PUBLIC_URL }
      });
      entry.state = 'asked'; entry.asked = Date.now(); entry.updated = Date.now();
      slots--;
      saveState();
    } catch (err) {
      console.error('workflow dispatch:', safeError(err));
      entry.state = 'failed'; entry.error = 'GitHub refused the build.'; entry.updated = Date.now();
      try { fs.unlinkSync(githubBody(entry.ask)); } catch {}
      saveState();
    }
  }
}

async function downloadArtifact(url) {
  // Keep the GitHub token on the API request only; artifact storage is reached through its redirect.
  const first = await fetch(url, { headers: ghHeaders(), redirect: 'manual', signal: AbortSignal.timeout(60000) });
  if (![301, 302, 303, 307, 308].includes(first.status)) {
    if (!first.ok) throw new Error(`Artifact download failed (${first.status})`);
    return Buffer.from(await first.arrayBuffer());
  }
  const location = first.headers.get('location');
  if (!location) throw new Error('GitHub artifact redirect had no location');
  const second = await fetch(location, { signal: AbortSignal.timeout(60000) });
  if (!second.ok) throw new Error(`Artifact storage returned ${second.status}`);
  return Buffer.from(await second.arrayBuffer());
}

async function finishRun(entry, run) {
  const artifacts = await ghApi('GET', `/actions/runs/${run.id}/artifacts`);
  const artifact = (artifacts.artifacts || []).find(a => a.name === 'result');
  if (!artifact) throw new Error('The build result artifact is missing.');
  const archive = await downloadArtifact(artifact.archive_download_url);
  const zip = new AdmZip(archive);
  const statusItem = zip.getEntry('status.json');
  const libItem = zip.getEntry(LIBRARY);
  if (!statusItem) throw new Error('The build status is missing.');
  const status = JSON.parse(statusItem.getData().toString('utf8'));
  if (status.state !== 'done') {
    entry.state = 'failed'; entry.error = String(status.error || 'The build failed.').slice(0, 600);
    entry.updated = Date.now();
    try { fs.unlinkSync(githubBody(entry.ask)); } catch {}
    saveState(); return;
  }
  if (!libItem) throw new Error('The compiled library is missing.');
  const library = libItem.getData();
  const digest = crypto.createHash('sha256').update(library).digest('hex');
  if (digest !== status.sha256 || library.length !== status.size) throw new Error('The build result failed SHA-256 or size verification.');
  const dir = jobDir(entry.job);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, LIBRARY), library);
  fs.writeFileSync(path.join(dir, 'status.json'), JSON.stringify(status));
  entry.state = 'done'; entry.updated = Date.now(); entry.runId = run.id;
  try { fs.unlinkSync(githubBody(entry.ask)); } catch {}
  saveState();
}

async function pollRuns() {
  if (!GH_TOKEN) return;
  try {
    await dispatchWaiting();
    const active = Object.values(state.jobs).filter(j => ['asked', 'queued', 'building'].includes(j.state));
    if (!active.length) return;
    const result = await ghApi('GET', `/actions/workflows/${encodeURIComponent(GH_WORKFLOW)}/runs?event=workflow_dispatch&per_page=100`);
    const byTitle = new Map();
    for (const run of result.workflow_runs || []) if (!byTitle.has(run.display_title)) byTitle.set(run.display_title, run);
    for (const entry of active) {
      const run = byTitle.get(`build ${entry.ask}`);
      if (!run) {
        if (Date.now() - (entry.asked || entry.created) > 15 * 60 * 1000) {
          entry.state = 'failed'; entry.error = 'GitHub did not start the build. Try again later.'; entry.updated = Date.now();
          try { fs.unlinkSync(githubBody(entry.ask)); } catch {}
        }
        continue;
      }
      if (Date.now() - (entry.asked || entry.created) > JOB_TIMEOUT_MS) {
        entry.state = 'failed'; entry.error = 'The build took too long. Try again later.'; entry.updated = Date.now();
        try { fs.unlinkSync(githubBody(entry.ask)); } catch {}
      } else if (run.status === 'completed') {
        if (run.conclusion === 'success') {
          try { await finishRun(entry, run); }
          catch (err) { console.error('finish run:', safeError(err)); entry.state = 'failed'; entry.error = safeError(err); entry.updated = Date.now(); saveState(); }
        } else {
          entry.state = 'failed'; entry.error = 'The build on GitHub did not finish. Try again later.'; entry.updated = Date.now();
          try { fs.unlinkSync(githubBody(entry.ask)); } catch {}
        }
      } else if (run.status === 'in_progress') {
        entry.state = 'building'; entry.started = Date.parse(run.run_started_at || '') || Date.now(); entry.updated = Date.now();
      } else {
        entry.state = 'queued'; entry.updated = Date.now();
      }
    }
    saveState();
  } catch (err) { console.error('GitHub polling:', safeError(err)); }
}

app.get('/', (_req, res) => res.type('text/plain').send('Starling GitHub Build Gateway is running.'));
app.get('/healthz', (_req, res) => json(res, 200, { ok: true }));

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Starling GitHub Build Gateway listening on ${PORT}`);
  if (!GH_TOKEN || !PUBLIC_URL) console.warn('Set GITHUB_TOKEN and GATEWAY_PUBLIC_URL to enable builds.');
  pollRuns();
  setInterval(pollRuns, POLL_MS).unref();
});
