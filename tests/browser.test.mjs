import test from 'node:test';
import assert from 'node:assert/strict';
import { parseScenario, browserExecutionTimeout, authorizeBrowserCredentials, authorizeLiveUpstreams, matchRule, classifyResponse, summarizeApi } from '../scripts/browser-scenario.mjs';
import { measureBudget } from '../scripts/browser-runner.mjs';

const proof = { name: 'x-api-mode', value: 'live-v1' };
const mockProof = { name: 'x-qa-fixture', value: 'on' };
const live = { id: 'orders', origin: 'http://localhost:3000', prefix: '/api/orders', source: 'live', proof, mockProof, required: true };

test('origin과 경로가 일치하고 출처 표식이 확인돼야 live를 판별한다', () => {
  assert.equal(matchRule([live], new URL('http://localhost:3000/api/orders/1?q=2')), live);
  assert.equal(matchRule([live], new URL('http://localhost:3000/api/orders-stale')), undefined);
  assert.equal(matchRule([live], new URL('http://localhost:3001/api/orders')), undefined);
  assert.equal(classifyResponse({ rule: live, headers: {} }).mode, 'unknown');
  assert.equal(classifyResponse({ rule: live, headers: { 'x-api-mode': 'live-v1' } }).mode, 'live');
  assert.equal(classifyResponse({ rule: live, headers: { 'x-api-mode': 'live-v1' }, serviceWorker: true }).mode, 'unknown');
  assert.equal(classifyResponse({ rule: live, headers: { 'x-api-mode': 'live-v1', 'x-qa-fixture': 'on' } }).mode, 'unknown');
  assert.equal(classifyResponse({ rule: live, headers: { 'x-qa-fixture': 'on' } }).mode, 'mock');
  assert.equal(classifyResponse({ fixture: true, rule: live, headers: { 'x-api-mode': 'live-v1' } }).mode, 'mock');
});

test('혼합 API와 미관측을 live로 승격하지 않으며 필수 경로를 확인한다', () => {
  const actual = { mode: 'live', rule: live.id, httpOk: true };
  const mock = { mode: 'mock', rule: null, httpOk: true };
  assert.equal(summarizeApi([], 'live', [live]).mode, 'unknown');
  assert.equal(summarizeApi([actual, mock], 'live', [live]).passed, false);
  assert.equal(summarizeApi([actual, mock], 'mixed', [live]).passed, true);
  assert.equal(summarizeApi([actual, { ...mock, mode: 'unknown' }], 'live', []).mode, 'unknown');
  assert.equal(summarizeApi([{ ...actual, rule: 'other' }], 'live', [live]).passed, false);
  assert.equal(summarizeApi([{ ...actual, httpOk: false }], 'live', []).passed, false);
});

test('성능 중앙값과 측정 불가 예산의 실패를 구분한다', () => {
  const samples = [{ ttfbMs: 120, lcpMs: null }, { ttfbMs: 10, lcpMs: 500 }, { ttfbMs: 30, lcpMs: 300 }];
  assert.equal(measureBudget(samples, { ttfbMs: 40 }, 3).metrics.ttfbMs.median, 30);
  assert.equal(measureBudget(samples, { ttfbMs: 40 }, 3).passed, true);
  assert.equal(measureBudget(samples, { lcpMs: 1000 }, 3).passed, false);
  assert.equal(measureBudget(samples.slice(1), {}, 3).passed, false);
});

test('성능 측정 실행 제한에 허용된 탐색·준비 조건·대기 횟수를 반영한다', () => {
  const base = { schemaVersion: 1, baseUrl: 'http://localhost:3000', timeoutMs: 30000 };
  const pages = Array.from({ length: 8 }, (_, index) => ({
    id: 'page-' + index, path: '/' + index, ...(index === 0 ? { ready: { selector: 'main' } } : {}),
  }));
  const config = parseScenario({ ...base, performance: { pages, runs: 9, settleMs: 5000 } }, [320], 'performance');
  assert.equal(browserExecutionTimeout(), 300000);
  const navigationAndSettling = 9 * (8 * (30000 + 5000) + 30000);
  assert(browserExecutionTimeout(config) > 300000 + navigationAndSettling);
});

test('시나리오의 외부 이동·운영 조작·근거 없는 live 규칙을 거부한다', () => {
  const base = { schemaVersion: 1, baseUrl: 'http://localhost:3000', performance: { pages: [{ id: 'home', path: '/' }] } };
  assert.throws(() => parseScenario({ ...base, target: 'production' }, [320]), /performance 모드/);
  assert.throws(() => parseScenario({ ...base, baseUrl: 'https://example.invalid', target: 'production', cases: [{ steps: [{ action: 'click' }] }] }, [320], 'performance'), /조작 시나리오/);
  assert.throws(() => parseScenario({ ...base, assetOrigins: ['https://example.invalid'] }, [320], 'performance'), /루프백/);
  assert.throws(() => parseScenario({ ...base, api: { expect: 'live', rules: [{ id: 'live', pathPrefix: '/api', source: 'live' }] } }, [320], 'performance'), /표식/);
  assert.throws(() => parseScenario({ ...base, performance: { pages: [{ id: 'home', path: '//example.invalid' }] } }, [320], 'performance'), /절대 경로/);
});

test('브라우저 자격 증명은 실행자가 허용한 정확한 origin과 변수만 사용할 수 있다', () => {
  const origin = 'https://qa.example.invalid';
  const policy = JSON.stringify({ origin, fillEnv: ['QA_PASSWORD'], storageStateEnv: 'QA_SESSION' });
  const config = {
    origin, origins: new Set([origin]), storageStateEnv: 'QA_SESSION',
    cases: [{ steps: [{ action: 'fill', env: 'QA_PASSWORD' }] }],
  };
  assert.equal(authorizeBrowserCredentials(config, policy), true);
  assert.throws(() => authorizeBrowserCredentials(config), /정책 필요/);
  assert.throws(() => authorizeBrowserCredentials({ ...config, origin: 'https://elsewhere.example.invalid' }, policy), /origin/);
  assert.throws(() => authorizeBrowserCredentials({ ...config, cases: [{ steps: [{ action: 'fill', env: 'GITHUB_TOKEN' }] }] }, policy), /입력 환경변수/);
  assert.throws(() => authorizeBrowserCredentials({ ...config, storageStateEnv: 'OTHER_FILE' }, policy), /로그인 상태/);
  assert.throws(() => authorizeBrowserCredentials({ ...config, origins: new Set([origin, 'https://elsewhere.example.invalid']) }, policy), /승인된 HTTPS/);
  assert.equal(authorizeBrowserCredentials({ ...config, storageStateEnv: undefined, cases: [{ steps: [{ action: 'fill', value: 'sample' }] }] }), false);
});

test('직접 전달은 시나리오 밖에서 승인한 정확한 API 경로만 실제 근거로 사용한다', () => {
  const upstream = { ...live, verification: 'upstream', proof: null };
  const config = { apiRules: [upstream] };
  assert.throws(() => authorizeLiveUpstreams(config), /정책 필요/);
  const approve = pathPrefix => JSON.stringify([{ origin: live.origin, pathPrefix }]);
  assert.throws(() => authorizeLiveUpstreams(config, approve('/api')), /origin과 경로/);
  assert.doesNotThrow(() => authorizeLiveUpstreams(config, approve(live.prefix)));
  assert.equal(classifyResponse({ rule: upstream, headers: {} }).mode, 'unknown');
  assert.equal(classifyResponse({ rule: upstream, headers: {}, forwarded: true }).mode, 'live');
  assert.equal(classifyResponse({ rule: upstream, headers: { 'x-qa-fixture': 'on' }, forwarded: true }).mode, 'unknown');
});

test('MSW는 서비스 워커와 Mock 표식이 함께 있어야 판별하고 운영 모드에서 거부한다', () => {
  const rule = { ...live, source: 'mock', proof: null };
  const headers = { 'x-qa-fixture': 'on' };
  assert.equal(classifyResponse({ rule, headers, msw: true }).mode, 'unknown');
  assert.equal(classifyResponse({ rule, headers, msw: true, serviceWorker: true }).mode, 'mock');
  assert.equal(classifyResponse({ rule, headers: {}, msw: true, serviceWorker: true }).mode, 'unknown');
  const options = { schemaVersion: 1, baseUrl: 'https://qa.example.invalid', target: 'production', serviceWorkers: 'msw' };
  assert.throws(() => parseScenario(options, [320], 'performance'), /비운영 Mock QA 전용/);
  assert.throws(() => parseScenario({ ...options, target: 'test', engine: 'webkit' }, [320]), /Chromium/);
});
