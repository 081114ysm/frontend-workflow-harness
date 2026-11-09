#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { inside, readJson, ensure, BROWSER_CHECKS } from './lib.mjs';
import { METRICS, parseScenario, authorizeBrowserCredentials, pageUrl, matchRule, classifyResponse, summarizeApi } from './browser-scenario.mjs';

const readMethods = new Set(['GET', 'HEAD', 'OPTIONS']);
const apiTypes = new Set(['xhr', 'fetch']);
const stepResult = (passed, detail) => ({ status: passed ? 'pass' : 'fail', detail });

/** 대상 앱에서 설치한 Playwright 패키지를 찾아 해당 앱의 버전으로 실행한다. */
function playwrightAt(root) {
  const require = createRequire(path.join(root, 'package.json'));
  for (const name of ['playwright', '@playwright/test']) {
    let location;
    try { location = require.resolve(name); } catch { continue; }
    return require(location);
  }
  throw new Error('대상 프로젝트에 playwright 또는 @playwright/test 설치 필요');
}

/** 사용자에게 보이는 이름이나 테스트 ID로 요소를 찾고 명시한 CSS 선택자도 지원한다. */
function locate(page, spec) {
  if (spec.testId) return page.getByTestId(spec.testId);
  if (spec.label) return page.getByLabel(spec.label, { exact: true });
  if (spec.role) return page.getByRole(spec.role, { name: spec.name, exact: true });
  return page.locator(spec.selector);
}

/**
 * 문서를 고정해 승인된 origin의 입력 요소에만 비밀값을 전달한다.
 * 탐색 중 요소가 사라져도 새 문서의 요소를 다시 찾지 않는다.
 */
async function fillCredential(target, origin, name, timeout) {
  const element = await target.elementHandle({ timeout });
  try {
    await element.waitForElementState('editable', { timeout });
    const actualOrigin = await element.evaluate(() => window.location.origin);
    ensure(actualOrigin === origin, '입력 요소의 실제 origin이 승인된 대상과 다름');
    const value = process.env[name];
    ensure(value !== undefined, '입력용 환경변수가 설정되지 않음');
    await element.evaluate((node, { origin, value }) => {
      if (window.location.origin !== origin || !node.isConnected) throw new Error('승인된 입력 문서가 바뀜');
      const prototype = node instanceof HTMLInputElement && ['text', 'password', 'email', 'search', 'tel', 'url'].includes(node.type)
        ? HTMLInputElement.prototype : node instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : null;
      if (!prototype) throw new Error('자격 증명은 텍스트 입력 요소에만 사용 가능');
      Object.getOwnPropertyDescriptor(prototype, 'value').set.call(node, value);
      node.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    }, { origin, value });
  } finally {
    await element.dispose();
  }
}

/** 승인된 로그인 상태에서 다른 호스트에 공유되는 쿠키와 미승인 웹 저장소를 거부한다. */
function readStorageState(root, config) {
  if (!config.storageStateEnv) return undefined;
  const relative = process.env[config.storageStateEnv];
  ensure(relative, '승인된 로그인 상태 파일 경로 필요');
  const state = readJson(inside(root, relative));
  const hosts = new Set([...config.origins].map(origin => new URL(origin).hostname));
  ensure(Array.isArray(state?.cookies) && state.cookies.every(cookie => hosts.has(cookie?.domain)), '로그인 상태에 공유 도메인 또는 미승인 도메인 쿠키가 있음');
  ensure(Array.isArray(state.origins) && state.origins.every(entry => config.origins.has(entry?.origin)), '로그인 상태에 미승인 웹 저장소 origin이 있음');
  return state;
}

/** 실제 DOM에서 단계 하나를 실행한다. 자격 증명이 있는 세션에서는 탐색 목적지도 확인한다. */
async function runStep(page, config, step) {
  const { origin, timeoutMs: timeout } = config;
  if (step.action === 'goto') {
    const response = await page.goto(pageUrl(origin, step.path), { waitUntil: 'load', timeout });
    ensure(response?.ok(), '문서 응답 실패');
    ensure(!config.usesCredentials || new URL(page.url()).origin === origin, '탐색이 승인된 origin을 벗어남');
    return;
  }
  const target = step.locator ? locate(page, step.locator) : null;
  if (step.action === 'click') return target.click({ timeout });
  if (step.action === 'fill') return step.env
    ? fillCredential(target, origin, step.env, timeout)
    : target.fill(step.value, { timeout });
  if (step.action === 'press') return target ? target.press(step.key, { timeout }) : page.keyboard.press(step.key);
  await target.waitFor({ state: 'visible', timeout });
  if (step.action === 'visible') return;
  const deadline = Date.now() + timeout;
  do {
    const matches = step.action === 'text'
      ? (await target.innerText({ timeout })).includes(step.value)
      : await target.evaluate(element => element === element.ownerDocument.activeElement, undefined, { timeout });
    if (matches) return;
    await delay(50);
  } while (Date.now() < deadline);
  throw new Error('assertion 불일치');
}

/** 브라우저 컨텍스트에 요청 제한, fixture와 민감 값을 제외한 관측을 설치한다. */
async function makeContext(browser, cfg, width, storageState, fixtures) {
  const context = await browser.newContext({ viewport: { width, height: 900 }, serviceWorkers: 'block', ...(storageState ? { storageState } : {}) });
  const ledger = { requests: new Set(), fulfilled: new WeakSet(), observations: [], blocked: 0, errors: 0 };
  const mockFor = request => {
    if (!fixtures) return null;
    const url = new URL(request.url());
    return cfg.mocks.find(mock => mock.origin === url.origin && mock.path === url.pathname && mock.method === request.method());
  };
  const apiRule = request => matchRule(cfg.apiRules, new URL(request.url()));
  const isApi = request => Boolean(apiRule(request) || mockFor(request) || apiTypes.has(request.resourceType()));
  context.on('request', request => { if (isApi(request)) ledger.requests.add(request); });
  context.on('requestfinished', request => ledger.requests.delete(request));
  context.on('requestfailed', request => {
    ledger.requests.delete(request);
    if (isApi(request)) ledger.observations.push({ ...classifyResponse({ failed: true }), rule: apiRule(request)?.id ?? null, httpOk: false, status: null });
  });
  context.on('response', response => {
    const request = response.request();
    const status = response.status();
    const headers = response.headers();
    if (!isApi(request) || status >= 300 && status < 400 && headers.location) return;
    const rule = matchRule(cfg.apiRules, new URL(response.url()));
    ledger.observations.push({
      ...classifyResponse({ rule, headers, fixture: ledger.fulfilled.has(request), serviceWorker: response.fromServiceWorker() }),
      rule: rule?.id ?? null, status, httpOk: status >= 200 && status < 400 || Boolean(rule?.statuses.includes(status)),
    });
  });
  context.on('page', page => {
    page.on('pageerror', () => ledger.errors++);
    page.on('console', message => { if (message.type() === 'error') ledger.errors++; });
  });
  try {
    await context.route('**/*', async route => {
      const request = route.request();
      const url = new URL(request.url());
      if (!cfg.origins.has(url.origin) || (cfg.target === 'production' && !readMethods.has(request.method()))) {
        ledger.blocked++;
        return route.abort('blockedbyclient');
      }
      const fixture = mockFor(request);
      if (!fixture) return route.continue();
      ledger.fulfilled.add(request);
      return route.fulfill({ status: fixture.status, json: fixture.body });
    });
    if (cfg.target === 'production' || cfg.usesCredentials) {
      await context.routeWebSocket('**/*', socket => {
        const origin = new URL(socket.url().replace(/^ws/, 'http')).origin;
        if (cfg.target !== 'production' && cfg.origins.has(origin)) {
          socket.connectToServer();
          return;
        }
        ledger.blocked++;
        return socket.close();
      });
    }
    return { context, ledger };
  } catch (error) {
    await context.close();
    throw error;
  }
}

/** 각 뷰포트를 별도 컨텍스트에서 실행해 해당 너비의 화면·API 결과를 검증한다. */
async function runCases(browser, cfg, storageState) {
  const results = []; const viewports = []; const observations = [];
  const apiByViewport = [];
  let overflow = 0; let errors = 0; let blocked = 0;
  for (const width of cfg.widths) {
    const { context, ledger } = await makeContext(browser, cfg, width, storageState, true);
    try {
      const page = await context.newPage();
      for (const item of cfg.cases) {
        let completed = 0; let failedAction = null;
        for (const step of item.steps) {
          try { await runStep(page, cfg, step); completed++; }
          catch { failedAction = step.action; break; } // Exceptions may contain credentials and selectors.
        }
        const layout = await page.evaluate(() => ({ viewport: innerWidth, content: document.documentElement.scrollWidth }));
        if (layout.viewport !== width || layout.content > width + 1) overflow++;
        results.push({ id: item.id, area: item.area, viewport: width, completed, failedAction });
      }
      const until = Date.now() + cfg.timeoutMs;
      while (ledger.requests.size && Date.now() < until) await delay(50);
      for (const request of ledger.requests) ledger.observations.push({ mode: 'unknown', reason: '관찰 시간 안에 응답이 끝나지 않음', rule: matchRule(cfg.apiRules, new URL(request.url()))?.id ?? null, status: null, httpOk: false });
      viewports.push(width);
      observations.push(...ledger.observations);
      apiByViewport.push({ viewport: width, ...summarizeApi(ledger.observations, cfg.expect, cfg.apiRules) });
      errors += ledger.errors;
      blocked += ledger.blocked;
    } finally {
      await context.close();
    }
  }
  const api = summarizeApi(observations, cfg.expect, cfg.apiRules);
  const areaResult = name => {
    const entries = results.filter(result => result.area === name);
    if (!entries.length) return { status: 'na', detail: cfg.statesNotApplicable };
    const failed = entries.filter(result => result.failedAction);
    return stepResult(!failed.length, failed.length
      ? failed.map(item => item.id + '@' + item.viewport + ' (' + item.failedAction + ')').join(', ')
      : entries.length + '개 실제 시나리오 통과');
  };
  return { viewports, api, apiByViewport, results, observations, blocked, errors, checks: {
    journey: areaResult('journey'), states: areaResult('states'), keyboard: areaResult('keyboard'),
    responsive: stepResult(!overflow, cfg.widths.length + '개 뷰포트, 가로 넘침/너비 불일치 ' + overflow + '건'),
    console: stepResult(!errors, '콘솔 오류·예외 ' + errors + '건'),
    network: stepResult(api.passed && apiByViewport.every(item => item.passed) && !blocked, '기대 ' + api.expected + ', 관측 ' + api.mode + ', 뷰포트별 불일치 ' + apiByViewport.filter(item => !item.passed).length + '개, 정책 차단 ' + blocked + '건'),
  } };
}

/** 페이지 탐색 전에 설치해 렌더링 지표와 가장 큰 레이아웃 이동 구간을 기록한다. */
function observePaint() {
  const observed = { lcpMs: null, cls: null };
  window.__frontendHarnessPaint = observed;
  const observers = [];
  const observe = (type, callback) => {
    if (!PerformanceObserver.supportedEntryTypes.includes(type)) return false;
    const observer = new PerformanceObserver(list => callback(list.getEntries()));
    observer.observe({ type, buffered: true });
    observers.push([observer, callback]);
    return true;
  };
  observe('largest-contentful-paint', entries => {
    for (const entry of entries) observed.lcpMs = entry.startTime;
  });
  let sessionStart = null; let last = null; let current = 0;
  if (observe('layout-shift', entries => {
    for (const entry of entries.filter(item => !item.hadRecentInput)) {
      const time = entry.startTime;
      if (last === null || time - last >= 1000 || time - sessionStart >= 5000) {
        sessionStart = time; current = 0;
      }
      last = time; current += entry.value;
      observed.cls = Math.max(observed.cls ?? 0, current);
    }
  })) observed.cls = 0;
  window.__frontendHarnessFlushPaint = () => {
    for (const [observer, callback] of observers) callback(observer.takeRecords());
  };
}

/** 수집 대기 중 남은 관측을 반영하고 브라우저가 제공하지 않는 지표는 null로 반환한다. */
function sampleMetrics() {
  window.__frontendHarnessFlushPaint?.();
  const nav = performance.getEntriesByType('navigation')[0];
  return {
    ttfbMs: nav?.responseStart ?? null,
    loadMs: nav?.loadEventEnd > 0 ? nav.loadEventEnd : null,
    fcpMs: performance.getEntriesByName('first-contentful-paint')[0]?.startTime ?? null,
    lcpMs: window.__frontendHarnessPaint?.lcpMs ?? null,
    cls: window.__frontendHarnessPaint?.cls ?? null,
  };
}

/** 반복 표본의 중앙값을 비교한다. 필수 지표 표본이 누락되면 예산 검사를 실패시킨다. */
export function measureBudget(samples, budgets, runs) {
  const metrics = Object.fromEntries(METRICS.map(metric => {
    const values = samples.map(sample => sample[metric]).filter(value => Number.isFinite(value) && value >= 0).sort((a, b) => a - b);
    const mid = Math.floor(values.length / 2);
    const median = !values.length ? null : values.length % 2 ? values[mid] : (values[mid - 1] + values[mid]) / 2;
    const limit = budgets[metric] ?? null;
    return [metric, { median, count: values.length, limit, passed: limit === null ? null : values.length === runs && median <= limit }];
  }));
  return { metrics, passed: samples.length === runs && Object.values(metrics).every(metric => metric.passed !== false) };
}

/** 페이지마다 새 컨텍스트에서 실제 탐색을 반복한다. 하네스 fixture는 사용하지 않는다. */
async function runPerformance(browser, cfg, storageState) {
  const { pages, viewport, runs, settleMs } = cfg.performance;
  const results = [];
  for (const entry of pages) {
    const samples = []; let failed = 0;
    for (let i = 0; i < runs; i++) {
      const { context, ledger } = await makeContext(browser, cfg, viewport, storageState, false);
      try {
        const page = await context.newPage();
        await page.addInitScript(observePaint);
        const response = await page.goto(pageUrl(cfg.origin, entry.path), { waitUntil: 'load', timeout: cfg.timeoutMs });
        ensure(response?.ok() && new URL(page.url()).origin === cfg.origin, '측정 문서 응답 실패');
        if (entry.ready) await locate(page, entry.ready).waitFor({ state: 'visible', timeout: cfg.timeoutMs });
        await delay(settleMs);
        ensure(!ledger.blocked, '네트워크 정책에 의해 측정 대상 리소스가 차단됨');
        samples.push(await page.evaluate(sampleMetrics));
      } catch { failed++; }
      finally { await context.close(); }
    }
    results.push({ id: entry.id, failed, samples, ...measureBudget(samples, entry.budgets || {}, runs) });
  }
  return { kind: 'navigation-lab', viewport, runs, settleMs, network: 'unthrottled', coldContext: true, browserCache: 'disabled-by-routing', pages: results, passed: results.every(page => page.passed) };
}

/** 자격 증명 정책을 확인한 뒤 브라우저를 열고 실패 시 민감 정보가 없는 결과를 반환한다. */
export async function runBrowser({ root, input, widths, mode = 'qa' }) {
  const config = parseScenario(input, widths, mode);
  let browser;
  let phase = '브라우저 자격 증명 승인';
  const at = new Date().toISOString();
  try {
    config.usesCredentials = authorizeBrowserCredentials(config, process.env.FRONTEND_HARNESS_BROWSER_AUTH);
    const storageState = readStorageState(root, config);
    phase = 'Playwright 브라우저 시작';
    const playwright = playwrightAt(root);
    browser = await playwright[config.engine].launch({ headless: true });
    const browserName = config.engine + ' ' + browser.version();
    phase = '브라우저 시나리오 실행';
    const qa = mode === 'qa' ? await runCases(browser, config, storageState) : null;
    phase = '성능 측정';
    const performance = config.performance ? await runPerformance(browser, config, storageState) : null;
    return { url: config.origin, browser: browserName, viewports: qa?.viewports ?? [], apiMode: qa?.api.mode ?? 'unknown',
      checks: qa?.checks ?? {}, automation: { at, target: config.target, api: qa?.api, scenarios: qa?.results,
        network: qa ? { blocked: qa.blocked, errors: qa.errors, apiByViewport: qa.apiByViewport, observations: qa.observations } : undefined, performance } };
  } catch {
    const detail = phase + ' 실패. 대상 앱 상태, Playwright 패키지·브라우저, 테스트 인증 설정을 확인';
    return { url: config.origin, browser: config.engine, viewports: [], apiMode: 'unknown',
      checks: Object.fromEntries(BROWSER_CHECKS.map(name => [name, { status: 'blocked', detail }])),
      automation: { at, target: config.target, error: detail } };
  } finally {
    if (browser) await browser.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const { values } = parseArgs({ options: { root: { type: 'string' }, from: { type: 'string' }, widths: { type: 'string', default: '[1280]' }, mode: { type: 'string', default: 'qa' } } });
    ensure(['qa', 'performance'].includes(values.mode), '--mode qa|performance 필요');
    const root = fs.realpathSync(path.resolve(values.root || process.cwd()));
    const report = await runBrowser({ root, input: readJson(inside(root, values.from)), widths: JSON.parse(values.widths), mode: values.mode });
    console.log(JSON.stringify(report));
    if (values.mode === 'performance' && !report.automation.performance?.passed) process.exitCode = 1;
  } catch (error) {
    console.error('브라우저 시나리오 오류: ' + error.message);
    process.exitCode = 1;
  }
}
