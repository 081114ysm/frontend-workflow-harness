import { ensure, nonempty } from './lib.mjs';

export const METRICS = ['ttfbMs', 'fcpMs', 'lcpMs', 'cls', 'loadMs'];
const AREAS = ['journey', 'states', 'keyboard'];
const ACTIONS = ['goto', 'click', 'fill', 'press', 'visible', 'text', 'focus'];
const METHODS = ['GET', 'HEAD', 'OPTIONS', 'POST', 'PUT', 'PATCH', 'DELETE'];
const MODES = ['none', 'live', 'mock', 'mixed'];
const key = value => typeof value === 'string' && /^[a-z0-9][a-z0-9-]{0,59}$/.test(value);
const list = (value, max) => Array.isArray(value) && value.length <= max;
const range = (value, min, max) => Number.isInteger(value) && value >= min && value <= max;

export function webOrigin(value) {
  const url = new URL(value);
  ensure(['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && url.pathname === '/' && !url.search && !url.hash, 'HTTP(S) origin만 입력');
  return url.origin;
}

export function pageUrl(origin, relative) {
  ensure(typeof relative === 'string' && relative.startsWith('/') && !relative.startsWith('//') && !relative.includes('\\'), '같은 origin의 절대 경로(/...) 필요');
  const url = new URL(relative, origin);
  ensure(url.origin === origin, '시나리오 이동 경로가 지정한 origin 밖임');
  return url.href;
}

function endpointPath(origin, value) {
  const url = new URL(pageUrl(origin, value));
  ensure(url.pathname === value && !url.search && !url.hash, 'API 경로에는 query/hash 또는 경로 이동을 넣지 않음');
  return value;
}

function locator(value) {
  return value && (nonempty(value.testId) || nonempty(value.label) || (nonempty(value.role) && (value.name === undefined || nonempty(value.name))) || nonempty(value.selector));
}

function marker(proof) {
  ensure(proof && /^[a-z0-9-]+$/i.test(proof.name || '') && nonempty(proof.value) && proof.value.length <= 200, 'API 표식은 응답 헤더 name/value 필요');
  return { name: proof.name.toLowerCase(), value: proof.value };
}

export function parseScenario(input, widths, mode = 'qa') {
  ensure(input?.schemaVersion === 1, '시나리오 schemaVersion: 1 필요');
  const origin = webOrigin(input.baseUrl);
  const target = input.target || 'local';
  const engine = input.engine || 'chromium';
  const timeoutMs = input.timeoutMs ?? 8000;
  ensure(['local', 'test', 'production'].includes(target) && ['chromium', 'firefox', 'webkit'].includes(engine), 'target/engine 설정 확인');
  ensure(target !== 'production' || mode === 'performance', '운영 대상은 입력·클릭 없는 performance 모드만 허용');
  ensure(target !== 'local' || ['localhost', '127.0.0.1', '[::1]'].includes(new URL(origin).hostname), 'local은 루프백 origin만 허용; 외부 테스트 대상은 test로 명시');
  ensure(list(widths, 8) && widths.length > 0 && widths.every(width => range(width, 240, 4096)), '뷰포트 너비 240~4096, 최대 8개 필요');
  ensure(range(timeoutMs, 500, 30000), 'timeoutMs: 500~30000 필요');
  ensure(!input.storageStateEnv || (target !== 'production' && /^[A-Z_][A-Z0-9_]*$/.test(input.storageStateEnv)), 'storageStateEnv: 비운영 환경의 환경변수 이름만 허용');
  const assets = input.assetOrigins ?? [];
  ensure(list(assets, 20), 'assetOrigins 최대 20개');
  const rules = input.api?.rules ?? [];
  const expect = input.api?.expect ?? 'none';
  ensure(list(rules, 40) && MODES.includes(expect), 'api.expect 또는 rules 확인');
  const apiRules = rules.map(rule => {
    ensure(key(rule?.id) && ['live', 'mock'].includes(rule.source), 'API 규칙 id/source 필요');
    const apiOrigin = webOrigin(rule.origin ?? origin);
    const prefix = endpointPath(apiOrigin, rule.pathPrefix);
    const statuses = rule.allowStatuses ?? [];
    ensure(list(statuses, 20) && statuses.every(code => range(code, 100, 599)), 'allowStatuses는 HTTP 상태 배열');
    return { id: rule.id, origin: apiOrigin, prefix, source: rule.source, required: rule.required === true,
      proof: rule.source === 'live' ? marker(rule.proof) : null, mockProof: rule.mockProof ? marker(rule.mockProof) : null, statuses };
  });
  ensure(new Set(apiRules.map(rule => rule.id)).size === apiRules.length && new Set(apiRules.map(rule => rule.origin + rule.prefix)).size === apiRules.length, 'API 규칙 ID 또는 origin/경로 중복');
  ensure(!['live', 'mixed'].includes(expect) || apiRules.some(rule => rule.source === 'live' && rule.required), 'live/mixed는 필수 live 경로가 하나 이상 필요');
  apiRules.sort((a, b) => b.prefix.length - a.prefix.length);
  const rawMocks = input.mocks ?? [];
  ensure(list(rawMocks, 30) && (target !== 'production' || rawMocks.length === 0), '운영 대상에서는 fixture 응답 금지');
  const mocks = rawMocks.map(mock => {
    const mockOrigin = webOrigin(mock.origin ?? origin);
    const method = mock.method ?? 'GET';
    const status = mock.status ?? 200;
    ensure(METHODS.includes(method) && range(status, 200, 599) && ![204, 304].includes(status) && mock.body !== undefined, 'fixture의 method/status/body 확인');
    return { origin: mockOrigin, path: endpointPath(mockOrigin, mock.path), method, status, body: mock.body };
  });
  ensure(new Set(mocks.map(mock => mock.method + ' ' + mock.origin + mock.path)).size === mocks.length, '중복된 fixture 경로');
  const cases = input.cases ?? [];
  ensure(target !== 'production' || (Array.isArray(cases) && cases.length === 0), '운영 성능 측정에는 조작 시나리오를 지정할 수 없음');
  ensure(list(cases, 24), 'cases 최대 24개');
  const ids = new Set();
  for (const scenario of cases) {
    ensure(key(scenario?.id) && !ids.has(scenario.id) && AREAS.includes(scenario.area) && list(scenario.steps, 30) && scenario.steps.length > 0, '시나리오 id/area/steps 확인');
    ids.add(scenario.id);
    const lastAssertion = scenario.steps.findLastIndex(step => ['visible', 'text', 'focus'].includes(step?.action));
    ensure(lastAssertion >= 0, '시나리오마다 관찰 가능한 assertion 필요');
    if (scenario.area === 'journey') ensure(scenario.steps.slice(0, lastAssertion).some(step => ['click', 'fill', 'press'].includes(step?.action)), '사용자 여정 동작 이후의 assertion 필요');
    if (scenario.area === 'keyboard') ensure(scenario.steps.findLastIndex(step => step?.action === 'focus') > scenario.steps.findIndex(step => step?.action === 'press') && scenario.steps.some(step => step?.action === 'press'), '키 입력 이후 초점 확인 필요');
    for (const step of scenario.steps) {
      ensure(ACTIONS.includes(step?.action), '지원하지 않는 브라우저 동작');
      if (step.action === 'goto') pageUrl(origin, step.path);
      else ensure(step.action === 'press' && step.locator === undefined || locator(step.locator), 'locator 필요');
      if (step.action === 'press') ensure(nonempty(step.key), 'press key 필요');
      if (step.action === 'text') ensure(nonempty(step.value), 'text assertion 값 필요');
      if (step.action === 'fill') ensure(target !== 'production' && (typeof step.value === 'string' && step.env === undefined || step.value === undefined && /^[A-Z_][A-Z0-9_]*$/.test(step.env || '')), 'fill: 비운영 대상의 value 또는 env 하나 필요');
    }
  }
  if (mode === 'qa') {
    ensure(cases.some(item => item.area === 'journey'), '사용자 여정 사례 필요');
    ensure(cases.some(item => item.area === 'keyboard'), '키보드 사례 필요');
    ensure(cases.some(item => item.area === 'states') || nonempty(input.statesNotApplicable), '화면 상태 사례 또는 미적용 사유 필요');
  }
  let performance = null;
  if (input.performance) {
    const { pages, runs = 3, settleMs = 1200, viewport = widths[0] } = input.performance;
    ensure(list(pages, 8) && pages.length > 0 && range(runs, 1, 9) && range(settleMs, 250, 5000) && range(viewport, 240, 4096), '성능 페이지/반복 횟수/관측 시간/뷰포트 확인');
    const pageIds = new Set();
    for (const page of pages) {
      ensure(key(page?.id) && !pageIds.has(page.id), '성능 페이지 ID 누락 또는 중복');
      pageIds.add(page.id);
      pageUrl(origin, page.path);
      ensure(!page.ready || locator(page.ready), '성능 페이지 ready locator 확인');
      ensure(page.budgets === undefined || page.budgets && Object.entries(page.budgets).every(([metric, maximum]) => METRICS.includes(metric) && Number.isFinite(maximum) && maximum >= 0), '지원 성능 지표의 숫자 예산 필요');
    }
    performance = { pages, runs, settleMs, viewport };
  }
  ensure(mode !== 'performance' || performance, '성능 실행에는 performance 설정 필요');
  const origins = new Set([origin, ...assets.map(webOrigin), ...apiRules.map(rule => rule.origin), ...mocks.map(mock => mock.origin)]);
  ensure(target !== 'local' || [...origins].every(item => ['localhost', '127.0.0.1', '[::1]'].includes(new URL(item).hostname)), 'local은 API와 리소스도 루프백 origin만 허용');
  return { origin, target, engine, timeoutMs, widths: [...new Set(widths)], cases, statesNotApplicable: input.statesNotApplicable,
    storageStateEnv: input.storageStateEnv, apiRules, expect, mocks, performance,
    origins };
}

export function matchRule(rules, url) {
  return rules.find(rule => rule.origin === url.origin && (rule.prefix === '/' || url.pathname === rule.prefix || url.pathname.startsWith(rule.prefix.replace(/\/$/, '') + '/')));
}

export function classifyResponse({ rule, headers, fixture = false, serviceWorker = false, failed = false }) {
  if (failed || serviceWorker) return { mode: 'unknown', reason: failed ? '응답 미관측' : '서비스 워커 응답' };
  if (fixture) return { mode: 'mock', reason: '하네스 fixture 응답' };
  if (!rule) return { mode: 'unknown', reason: '등록되지 않은 API 경로' };
  const match = proof => Boolean(proof && headers[proof.name] === proof.value);
  const live = match(rule.proof);
  const mock = match(rule.mockProof);
  if (live && mock) return { mode: 'unknown', reason: '출처 표식 충돌' };
  if (mock || rule.source === 'mock') return { mode: 'mock', reason: mock ? 'Mock 표식' : '등록된 Mock 서버' };
  if (live) return { mode: 'live', reason: '등록된 origin·경로·실서버 응답 표식 일치' };
  return { mode: 'unknown', reason: '실서버 응답 표식 불일치' };
}

export function summarizeApi(observations, expected, rules) {
  const counts = { live: 0, mock: 0, unknown: 0 };
  for (const item of observations) counts[item.mode]++;
  const mode = counts.unknown ? 'unknown' : counts.live && counts.mock ? 'mixed' : counts.live ? 'live' : counts.mock ? 'mock' : expected === 'none' ? 'none' : 'unknown';
  const missing = rules.filter(rule => rule.required && !observations.some(item => item.rule === rule.id && item.mode === rule.source && item.httpOk)).map(rule => rule.id);
  return { mode, expected, counts, missing, passed: mode === expected && !missing.length && observations.every(item => item.httpOk) };
}
