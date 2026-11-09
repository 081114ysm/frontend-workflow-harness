import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { execFile, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { runBrowser } from '../scripts/browser-runner.mjs';
import { ACTIVE_STATE } from '../scripts/lib.mjs';

const exec = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(import.meta.url);
const engine = process.env.HARNESS_TEST_BROWSER || 'chromium';
const cli = path.join(root, 'scripts/harness.mjs');
const load = { role: 'button', name: 'Load' };
const filter = { label: 'Filter' };
const result = { testId: 'result' };
const html = '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">' +
  '<main><h1>Orders</h1><label>Filter <input></label><button id="load">Load</button><button id="fixture">Fixture</button><output data-testid="result">Idle</output></main>' +
  '<script>const out=document.querySelector("output");' +
  'document.querySelector("#load").onclick=async()=>{out.textContent=(await (await fetch("/api/orders?token=DO_NOT_RECORD")).json()).value};' +
  'document.querySelector("#fixture").onclick=async()=>{out.textContent=(await (await fetch("/api/fixture")).json()).value};</script>';

async function serverFixture(t, mswClient) {
  let marked = true; let redirectApi = false; let requests = 0; let writes = 0;
  const server = createServer((request, response) => {
    const url = new URL(request.url, 'http://localhost');
    if (url.pathname === '/api/write') { writes++; response.end('unexpected'); return; }
    if (url.pathname === '/api/orders') {
      requests++;
      if (redirectApi) { response.writeHead(302, { location: '/api/write' }).end(); return; }
      response.setHeader('content-type', 'application/json');
      if (marked) response.setHeader('x-api-mode', 'live-v1');
      response.end('{"value":"Network response"}');
      return;
    }
    if (url.pathname === '/favicon.ico') { response.writeHead(204).end(); return; }
    if (url.pathname === '/redirect-page') { response.writeHead(302, { location: '/' }).end(); return; }
    if (mswClient && url.pathname === '/mockServiceWorker.js') {
      response.setHeader('content-type', 'text/javascript');
      response.end(fs.readFileSync(require.resolve('msw/mockServiceWorker.js')));
      return;
    }
    if (mswClient && url.pathname === '/msw-client.js') {
      response.setHeader('content-type', 'text/javascript');
      response.end(mswClient);
      return;
    }
    if (mswClient && ['/msw', '/msw-unmarked'].includes(url.pathname)) {
      response.setHeader('content-type', 'text/html; charset=utf-8');
      response.end(html.replace('id="load"', 'id="load" disabled') + '<script type="module" src="/msw-client.js"></script>');
      return;
    }
    if (url.pathname === '/credentials') {
      response.setHeader('content-type', 'text/html; charset=utf-8');
      response.end('<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1">' +
        '<label>QA credential <input type="password"></label><a href="/">Jump</a><output>Empty</output>' +
        '<script>const params=new URLSearchParams(location.search);document.querySelector("a").href=params.get("jump")||"/";' +
        'document.querySelector("input").oninput=()=>{document.querySelector("output").textContent="Entered";' +
        'if(params.has("trap"))fetch("/api/write",{method:"POST",body:document.querySelector("input").value})};</script>');
      return;
    }
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
  return { origin: 'http://127.0.0.1:' + server.address().port, unmark: () => { marked = false; },
    redirectApi: () => { redirectApi = true; }, requests: () => requests, writes: () => writes };
}

function scenario(origin, value = 'Network response') {
  return { schemaVersion: 1, baseUrl: origin, engine, timeoutMs: 4500,
    cases: [
      { id: 'load-order', area: 'journey', steps: [{ action: 'goto', path: '/' }, { action: 'click', locator: load }, { action: 'text', locator: result, value }] },
      { id: 'keyboard-filter', area: 'keyboard', steps: [{ action: 'goto', path: '/' }, { action: 'press', key: 'Tab' }, { action: 'focus', locator: filter }] },
      { id: 'idle', area: 'states', steps: [{ action: 'goto', path: '/' }, { action: 'text', locator: result, value: 'Idle' }] },
    ],
    api: { expect: 'live', rules: [{ id: 'orders', origin, pathPrefix: '/api/orders', source: 'live', proof: { name: 'x-api-mode', value: 'live-v1' }, required: true }] },
  };
}

test('실제 ' + engine + ' CLI에서 화면 조작·네트워크·성능을 기록하고 미확인 응답을 거부한다', async t => {
  const server = await serverFixture(t);
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-real-browser-'));
  t.after(() => fs.rmSync(project, { recursive: true, force: true }));
  const save = (name, value) => fs.writeFileSync(path.join(project, name), typeof value === 'string' ? value : JSON.stringify(value, null, 2));
  fs.symlinkSync(path.join(root, 'node_modules'), path.join(project, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  save('.gitignore', 'node_modules\n');
  save('package.json', { name: 'browser-fixture', private: true });
  save('frontend-harness.config.json', { schemaVersion: 1, configured: true, project: 'Browser fixture', integrationBranch: 'main', defaultBranch: 'main', branchPrefix: 'codex/',
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
  console.log(engine + ' live/unknown, widths 320/1024, TTFB samples: ' + automation.performance.pages[0].samples.map(sample => sample.ttfbMs.toFixed(2)).join(', ') + ' ms');
});

test('실제 ' + engine + '에서 하네스 fixture와 혼합 흐름을 분리한다', async t => {
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

test('실제 ' + engine + '에서 응답 헤더 없는 API의 승인·직접 전달·리다이렉트 차단을 확인한다', async t => {
  const server = await serverFixture(t);
  server.unmark();
  const env = 'FRONTEND_HARNESS_LIVE_UPSTREAMS';
  const previous = process.env[env];
  t.after(() => { if (previous === undefined) delete process.env[env]; else process.env[env] = previous; });
  delete process.env[env];
  const input = scenario(server.origin);
  input.api.rules = [{ id: 'orders', origin: server.origin, pathPrefix: '/api/orders', source: 'live', verification: 'upstream', required: true }];
  const rejected = await runBrowser({ root, input, widths: [320] });
  assert.match(rejected.automation.error, /승인/);
  assert.equal(server.requests(), 0);
  process.env[env] = JSON.stringify([{ origin: server.origin, pathPrefix: '/api/orders' }]);
  const report = await runBrowser({ root, input, widths: [320] });
  assert.equal(report.apiMode, 'live', JSON.stringify(report));
  assert.equal(report.checks.journey.status, 'pass');
  assert.equal(report.automation.api.counts.live, 1);
  assert.equal(server.requests(), 1);
  server.redirectApi();
  const redirected = await runBrowser({ root, input, widths: [320] });
  assert.equal(redirected.apiMode, 'unknown');
  assert.equal(redirected.checks.network.status, 'fail');
  assert.equal(server.requests(), 2);
  assert.equal(server.writes(), 0);
});

test('실제 MSW 서비스 워커의 표식 있는 응답만 mock으로 인정한다', { skip: engine !== 'chromium' }, async t => {
  const bundled = await build({ stdin: { resolveDir: root, contents: `
    import { setupWorker } from 'msw/browser';
    import { http, HttpResponse } from 'msw';
    const worker = setupWorker(http.get('/api/orders', () => HttpResponse.json({ value: 'MSW response' }, {
      headers: location.pathname === '/msw' ? { 'x-qa-mock': 'msw' } : {},
    })));
    await worker.start({ quiet: true, onUnhandledRequest: 'bypass' });
    document.getElementById('load').disabled = false;
  ` }, platform: 'browser', format: 'esm', bundle: true, write: false });
  const server = await serverFixture(t, bundled.outputFiles[0].contents);
  const input = scenario(server.origin, 'MSW response');
  input.serviceWorkers = 'msw';
  input.api = { expect: 'mock', rules: [{ id: 'orders', pathPrefix: '/api/orders', source: 'mock',
    mockProof: { name: 'x-qa-mock', value: 'msw' }, required: true }] };
  input.cases[0].steps[0].path = '/msw';
  const mock = await runBrowser({ root, input, widths: [320] });
  assert.equal(mock.apiMode, 'mock', JSON.stringify(mock));
  assert.equal(mock.checks.journey.status, 'pass');
  assert.equal(mock.checks.network.status, 'pass');
  assert.equal(server.requests(), 0);
  input.cases[0].steps[0].path = '/msw-unmarked';
  const unknown = await runBrowser({ root, input, widths: [320] });
  assert.equal(unknown.apiMode, 'unknown');
  assert.equal(unknown.checks.network.status, 'fail');
  assert.equal(server.requests(), 0);
});

test('운영 측정 정책은 실제 브라우저의 POST를 서버로 보내지 않고 측정을 실패로 남긴다', async t => {
  const server = await serverFixture(t);
  const report = await runBrowser({ root, widths: [800], mode: 'performance',
    input: { schemaVersion: 1, baseUrl: server.origin, engine, target: 'production', performance: { runs: 1, settleMs: 350,
      pages: [{ id: 'mutating-page', path: '/write-page' }, { id: 'redirect-page', path: '/redirect-page' }] } } });
  assert.equal(report.automation.performance?.passed, false, JSON.stringify(report));
  assert.equal(report.automation.performance.pages[0].failed, 1);
  assert.equal(report.automation.performance.pages[0].failures['network-policy'], 1);
  assert.equal(report.automation.performance.pages[1].failures['unexpected-url'], 1);
  assert.equal(server.writes(), 0);
});

test('실제 ' + engine + '에서 승인된 입력과 다른 origin에서의 차단을 확인한다', async t => {
  const trusted = await serverFixture(t);
  const other = await serverFixture(t);
  const secretName = 'HARNESS_TEST_QA_CREDENTIAL';
  const secret = 'fixture-only-credential';
  const policyName = 'FRONTEND_HARNESS_BROWSER_AUTH';
  t.after(() => { delete process.env[secretName]; delete process.env[policyName]; });
  process.env[secretName] = secret;
  process.env[policyName] = JSON.stringify({ origin: trusted.origin, fillEnv: [secretName], networkOrigins: [other.origin] });
  const locator = { label: 'QA credential' };
  const fill = { action: 'fill', env: secretName, locator };
  const entered = { action: 'text', locator: { selector: 'output' }, value: 'Entered' };
  const input = {
    schemaVersion: 1, baseUrl: trusted.origin, engine, timeoutMs: 4500, assetOrigins: [other.origin],
    statesNotApplicable: '인증 입력 fixture',
    cases: [
      { id: 'credential', area: 'journey', steps: [{ action: 'goto', path: '/credentials' }, fill, entered] },
      { id: 'focus-input', area: 'keyboard', steps: [{ action: 'goto', path: '/credentials' }, { action: 'press', key: 'Tab' }, { action: 'focus', locator }] },
    ],
  };
  const ok = await runBrowser({ root, input, widths: [320] });
  assert.equal(ok.checks.journey.status, 'pass');
  assert(!JSON.stringify(ok).includes(secret));
  const jump = '/credentials?jump=' + encodeURIComponent(other.origin + '/credentials?trap=1');
  input.cases[0].steps = [
    { action: 'goto', path: jump }, { action: 'click', locator: { role: 'link', name: 'Jump' } },
    { action: 'text', locator: { selector: 'output' }, value: 'Empty' }, fill, entered,
  ];
  const blocked = await runBrowser({ root, input, widths: [320] });
  assert.equal(blocked.checks.journey.status, 'fail');
  assert.equal(blocked.automation.scenarios[0].completed, 3);
  assert.equal(blocked.automation.scenarios[0].failedAction, 'fill');
  assert.equal(other.writes(), 0);
});
