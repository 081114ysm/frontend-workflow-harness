import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { execFile, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { runBrowser } from '../scripts/browser-runner.mjs';
import { ACTIVE_STATE } from '../scripts/lib.mjs';

const exec = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));
const cli = path.join(root, 'scripts/harness.mjs');
const load = { role: 'button', name: 'Load' };
const result = { testId: 'result' };
const html = '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">' +
  '<main><h1>Orders</h1><button id="load">Load</button><button id="fixture">Fixture</button><output data-testid="result">Idle</output></main>' +
  '<script>const out=document.querySelector("output");' +
  'document.querySelector("#load").onclick=async()=>{out.textContent=(await (await fetch("/api/orders?token=DO_NOT_RECORD")).json()).value};' +
  'document.querySelector("#fixture").onclick=async()=>{out.textContent=(await (await fetch("/api/fixture")).json()).value};</script>';

async function serverFixture(t) {
  let marked = true; let requests = 0; let writes = 0;
  const server = createServer((request, response) => {
    const url = new URL(request.url, 'http://localhost');
    if (url.pathname === '/api/write') { writes++; response.end('unexpected'); return; }
    if (url.pathname === '/api/orders') {
      requests++;
      response.setHeader('content-type', 'application/json');
      if (marked) response.setHeader('x-api-mode', 'live-v1');
      response.end('{"value":"Network response"}');
      return;
    }
    if (url.pathname === '/favicon.ico') { response.writeHead(204).end(); return; }
    if (url.pathname === '/write-page') {
      response.setHeader('content-type', 'text/html');
      response.end('<!doctype html><h1>Read-only check</h1><script>fetch("/api/write",{method:"POST"}).catch(()=>{})</script>');
      return;
    }
    if (url.pathname !== '/') { response.writeHead(404).end(); return; }
    response.setHeader('content-type', 'text/html; charset=utf-8');
    response.end(html);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  return { origin: 'http://127.0.0.1:' + server.address().port, unmark: () => { marked = false; }, requests: () => requests, writes: () => writes };
}

function scenario(origin, value = 'Network response') {
  return { schemaVersion: 1, baseUrl: origin, timeoutMs: 2500,
    cases: [
      { id: 'load-order', area: 'journey', steps: [{ action: 'goto', path: '/' }, { action: 'click', locator: load }, { action: 'text', locator: result, value }] },
      { id: 'keyboard-load', area: 'keyboard', steps: [{ action: 'goto', path: '/' }, { action: 'press', key: 'Tab' }, { action: 'focus', locator: load }] },
      { id: 'idle', area: 'states', steps: [{ action: 'goto', path: '/' }, { action: 'text', locator: result, value: 'Idle' }] },
    ],
    api: { expect: 'live', rules: [{ id: 'orders', origin, pathPrefix: '/api/orders', source: 'live', proof: { name: 'x-api-mode', value: 'live-v1' }, required: true }] },
  };
}

test('실제 Chromium CLI: 화면 조작·뷰포트·네트워크·성능을 QA.md에 기록하고 미확인 응답은 실패시킨다', async t => {
  const server = await serverFixture(t);
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-real-browser-'));
  t.after(() => fs.rmSync(project, { recursive: true, force: true }));
  const save = (name, value) => fs.writeFileSync(path.join(project, name), typeof value === 'string' ? value : JSON.stringify(value, null, 2));
  fs.symlinkSync(path.join(root, 'node_modules'), path.join(project, 'node_modules'), 'dir');
  save('.gitignore', 'node_modules\n');
  save('package.json', { name: 'browser-fixture', private: true });
  save('frontend-harness.config.json', { schemaVersion: 1, configured: true, project: 'Chromium fixture', integrationBranch: 'main', defaultBranch: 'main', branchPrefix: 'codex/',
    reviewMode: 'self', requireLiveApi: true, requireCi: false, approval: { plan: false, pr: false }, github: { enabled: false },
    checks: { test: { argv: [process.execPath, '-e', 'process.exit(0)'], cwd: '.', timeoutMs: 1000 } },
    notApplicable: { lint: 'fixture', typecheck: 'fixture', build: 'fixture' }, context: { viewports: [320, 1024] } });
  save('scenario.json', { ...scenario(server.origin), performance: { runs: 2, settleMs: 350, viewport: 1024,
    pages: [{ id: 'home', path: '/', ready: { role: 'heading', name: 'Orders' }, budgets: { ttfbMs: 5000, loadMs: 5000 } }] } });
  const git = (...args) => {
    const response = spawnSync('git', args, { cwd: project, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } });
    assert.equal(response.status, 0, response.stderr);
  };
  git('init', '-b', 'main'); git('add', '.');
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'baseline');
  git('switch', '-c', 'codex/browser');
  const h = (...args) => exec(process.execPath, [cli, '--root', project, ...args], { cwd: project, timeout: 60000 });
  await h('start', '--id', 'browser');
  await h('advance', '--to', 'implement');
  await h('run', 'all');
  await h('advance', '--to', 'review');
  const base = '.frontend-workflow/features/browser/';
  save(base + 'evidence/review.json', { method: 'self', reviewer: 'fixture', scope: 'test fixture only', findings: [] });
  await h('record', '--kind', 'review', '--file', base + 'evidence/review.json');
  await h('advance', '--to', 'qa');
  const first = JSON.parse((await h('browser-run', '--from', 'scenario.json')).stdout);
  assert.equal(first.apiMode, 'live');
  const evidence = fs.readFileSync(path.join(project, first.evidence), 'utf8');
  assert(!evidence.includes('DO_NOT_RECORD'));
  const automation = JSON.parse(evidence);
  assert.equal(automation.api.counts.live, 2);
  assert.equal(automation.network.apiByViewport.length, 2);
  assert.equal(automation.performance.pages[0].metrics.ttfbMs.count, 2);
  assert(automation.performance.pages[0].metrics.ttfbMs.median > 0);
  assert(automation.performance.pages[0].metrics.loadMs.median > 0);
  assert(automation.performance.passed);
  await h('advance', '--to', 'ready');
  assert.match(fs.readFileSync(path.join(project, base + 'QA.md'), 'utf8'), /브라우저 성능 측정/);
  server.unmark();
  await assert.rejects(h('browser-run', '--from', 'scenario.json'), /실제 API/);
  const state = JSON.parse(fs.readFileSync(path.join(project, ACTIVE_STATE), 'utf8'));
  assert.equal(state.evidence.browser, undefined);
  assert.equal(state.qaFailures.browser.summary.apiMode, 'unknown');
  await assert.rejects(h('advance', '--to', 'delivered'), /browser/);
  assert.equal(server.requests(), 4);
  console.log('Chromium live/unknown, widths 320/1024, TTFB samples: ' + automation.performance.pages[0].samples.map(sample => sample.ttfbMs.toFixed(2)).join(', ') + ' ms');
});

test('실제 Chromium에서 하네스 fixture는 서버 요청 없이 mock으로 분류되고 혼합 흐름도 분리한다', async t => {
  const server = await serverFixture(t);
  const input = scenario(server.origin, 'Mock response');
  const fixture = { path: '/api/orders', body: { value: 'Mock response' } };
  const mock = await runBrowser({ root, input: { ...input, mocks: [fixture], api: { expect: 'mock' } }, widths: [320] });
  assert.equal(mock.apiMode, 'mock', JSON.stringify(mock));
  assert.equal(mock.checks.network.status, 'pass');
  assert.equal(mock.checks.journey.status, 'pass');
  assert.equal(server.requests(), 0);
  const mixed = scenario(server.origin);
  mixed.api.expect = 'mixed';
  mixed.mocks = [{ path: '/api/fixture', body: { value: 'Fixture only' } }];
  mixed.cases.push({ id: 'mock-state', area: 'states', steps: [{ action: 'click', locator: { role: 'button', name: 'Fixture' } }, { action: 'text', locator: result, value: 'Fixture only' }] });
  const report = await runBrowser({ root, input: mixed, widths: [320] });
  assert.equal(report.apiMode, 'mixed');
  assert.equal(report.checks.network.status, 'pass');
  assert.equal(report.checks.states.status, 'pass');
  assert.equal(server.requests(), 1);
});

test('운영 측정 정책은 실제 브라우저의 POST를 서버로 보내지 않고 측정을 실패로 남긴다', async t => {
  const server = await serverFixture(t);
  const report = await runBrowser({ root, widths: [800], mode: 'performance',
    input: { schemaVersion: 1, baseUrl: server.origin, target: 'production', performance: { runs: 1, settleMs: 350, pages: [{ id: 'mutating-page', path: '/write-page' }] } } });
  assert.equal(report.automation.performance?.passed, false, JSON.stringify(report));
  assert.equal(report.automation.performance.pages[0].failed, 1);
  assert.equal(server.writes(), 0);
});
