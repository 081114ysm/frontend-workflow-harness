import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { ACTIVE_STATE, BROWSER_CHECKS, fingerprint, inside, validateConfig } from '../scripts/lib.mjs';
import { githubWorkflow } from '../scripts/github-lib.mjs';

const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(source, 'scripts/harness.mjs');

function fixture(t, override = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'frontend-harness-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const git = (...args) => {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } });
    assert.equal(result.status, 0, result.stderr); return result.stdout.trim();
  };
  git('init', '-b', 'main');
  git('config', 'user.name', 'Harness Test'); git('config', 'user.email', 'harness@example.invalid');
  git('config', 'commit.gpgsign', 'false');
  const write = (name, value) => {
    fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    fs.writeFileSync(path.join(root, name), typeof value === 'string' ? value : JSON.stringify(value, null, 2) + '\n');
  };
  const config = {
    schemaVersion: 1, configured: true, project: 'Fixture', integrationBranch: 'main', defaultBranch: 'main',
    branchPrefix: 'codex/', reviewMode: 'self', requireLiveApi: false, requireCi: true,
    github: { enabled: true, repository: 'example/app', requiredChecks: [{ name: 'verify', app: 'github-actions' }] },
    approval: { plan: true, pr: true },
    checks: { test: { argv: [process.execPath, '-e', 'process.exit(0)'], cwd: '.', timeoutMs: 1000 } },
    notApplicable: { lint: '테스트 fixture에 lint 대상 없음', typecheck: '테스트 fixture는 JS', build: '번들링 없는 테스트 fixture' },
    context: { viewports: [320, 768, 1280] }, ...override,
  };
  write('frontend-harness.config.json', config); write('app.js', 'export const value = 1;\n');
  write('.gitignore', '.frontend-workflow/.lock/\n.frontend-workflow/**/*.log\nnode_modules/\n');
  git('add', '.'); git('commit', '-m', 'test: baseline'); git('switch', '-c', 'codex/42-search');
  const run = (...args) => spawnSync(process.execPath, [cli, '--root', root, ...args], { cwd: root, encoding: 'utf8' });
  const ok = (...args) => { const r = run(...args); assert.equal(r.status, 0, r.stderr + r.stdout); return r.stdout; };
  const bad = (pattern, ...args) => { const r = run(...args); assert.notEqual(r.status, 0, r.stdout); assert.match(r.stderr, pattern); return r; };
  const state = () => JSON.parse(fs.readFileSync(path.join(root, ACTIVE_STATE), 'utf8'));
  const evidence = '.frontend-workflow/features/42-search/evidence/';
  const report = () => fs.readFileSync(path.join(root, '.frontend-workflow/features/42-search/QA.md'), 'utf8');
  const start = () => ok('start', '--id', '42-search', '--issue', 'https://github.com/example/app/issues/42');
  const approve = (gate = 'plan') => {
    // Synthetic test authorization only: this fixture is never reported as real user approval.
    write(evidence + `${gate}-authorization.md`, 'SYNTHETIC TEST: user authorizes the fixture scope.');
    ok('approve', '--gate', gate, '--by', 'test-user', '--file', evidence + `${gate}-authorization.md`);
  };
  const implement = () => { start(); approve(); ok('advance', '--to', 'implement'); };
  const review = (report = { method: 'self', reviewer: 'test-reviewer', scope: 'Synthetic fixture diff', findings: [] }) => {
    write(evidence + 'review.json', report);
    return ok('record', '--kind', 'review', '--file', evidence + 'review.json');
  };
  const browser = (changes = {}) => {
    write(evidence + 'synthetic-browser.txt', 'Synthetic browser evidence; no actual UI was tested.');
    const report = {
      url: 'http://localhost:3000/search', browser: 'Synthetic browser fixture', apiMode: 'mock', viewports: [320, 768, 1280],
      checks: Object.fromEntries(BROWSER_CHECKS.map(name => [name, { status: 'pass', detail: 'Synthetic fixture result' }])),
      artifacts: [evidence + 'synthetic-browser.txt'], ...changes,
    };
    write(evidence + 'browser.json', report);
    return ok('record', '--kind', 'browser', '--file', evidence + 'browser.json');
  };
  const qa = () => { implement(); ok('advance', '--to', 'review'); review(); ok('advance', '--to', 'qa'); };
  const ready = () => { qa(); ok('run', 'all'); browser(); ok('advance', '--to', 'ready'); };
  const pr = () => {
    ready(); approve('pr'); git('add', '.'); git('commit', '-m', 'test: feature');
    ok('advance', '--to', 'pr', '--url', 'https://github.com/example/app/pull/9');
  };
  return { root, git, write, config, run, ok, bad, state, evidence, report, start, approve, implement, review, browser, qa, ready, pr };
}

test('착수 시 QA.md를 미실행 상태로 만들며 예시 JSON을 검증 결과로 사용하지 않는다', t => {
  const f = fixture(t); const original = fingerprint(f.root); f.start();
  assert.equal(fingerprint(f.root), original);
  assert.match(f.report(), /QA 완료 조건: \*\*미충족\*\*/);
  assert.match(f.report(), /\| 사용자 여정 \| 미실행 \|/);
  assert.match(f.report(), /시작 시 복사한 JSON 예시는 실행 결과가 아님/);
  assert.match(f.ok('issue-body'), /QA: \.frontend-workflow\/features\/42-search\/QA.md/);
});

test('검사 실패를 QA 문서에 자동 저장하며 원시 출력을 복사하지 않는다', t => {
  const f = fixture(t, { checks: { test: { argv: [process.execPath, '-e', 'console.error(process.env.HARNESS_QA_RAW_OUTPUT); process.exit(7)'], cwd: '.', timeoutMs: 1000 } } });
  f.implement();
  const result = spawnSync(process.execPath, [cli, '--root', f.root, 'run', 'all'], { encoding: 'utf8', env: { ...process.env, HARNESS_QA_RAW_OUTPUT: 'PRIVATE_RAW_OUTPUT_SENTINEL' } });
  assert.equal(result.status, 1); assert.match(f.report(), /\| test \| 실패 \|/);
  assert.match(f.report(), /종료 코드: 7/); assert(!f.report().includes('PRIVATE_RAW_OUTPUT_SENTINEL'));
  assert.match(f.report(), /\[evidence\/check-test.json\]\(evidence\/check-test.json\)/);
});

test('자동 QA 문서는 기록한 브라우저 환경과 증거를 포함하고 현재 완료 조건을 계산한다', t => {
  const f = fixture(t); f.ready();
  assert.match(f.report(), /QA 완료 조건: \*\*충족\*\*/);
  assert.match(f.report(), /API 모드: mock/); assert.match(f.report(), /320, 768, 1280/);
  assert.match(f.report(), /\| 사용자 여정 \| 통과 \| Synthetic fixture result \|/);
  assert.match(f.report(), /\[evidence\/synthetic-browser.txt\]\(evidence\/synthetic-browser.txt\)/);
  assert.match(f.report(), /실제 서버·쿠키·CORS·인증 연동은 별도 검증/);
});

test('이전 통과 뒤 다른 파일의 실패·차단 브라우저 보고서를 기록하면 QA 문서와 게이트에 반영한다', t => {
  const f = fixture(t); f.ready();
  const browser = JSON.parse(fs.readFileSync(path.join(f.root, f.evidence, 'browser.json'), 'utf8'));
  browser.checks.journey = { status: 'fail', detail: 'AC-1: 검색 버튼을 눌러도 결과가 갱신되지 않음' };
  browser.checks.network = { status: 'blocked', detail: '실제 서버 접근 불가' };
  f.write(f.evidence + 'failed-browser.json', browser);
  f.bad(/journey/, 'record', '--kind', 'browser', '--file', f.evidence + 'failed-browser.json');
  assert.equal(f.state().evidence.browser, undefined);
  assert.match(f.report(), /QA 완료 조건: \*\*미충족\*\*/);
  assert.match(f.report(), /\| 사용자 여정 \| 실패 \| AC-1:/);
  assert.match(f.report(), /\| 네트워크 \| 차단 \| 실제 서버 접근 불가 \|/);
  assert.match(f.report(), /기록 거부/);
  f.approve('pr'); f.git('add', '.'); f.git('commit', '-m', 'test: rejected browser');
  f.bad(/browser/, 'advance', '--to', 'pr', '--url', 'https://github.com/example/app/pull/9');
  f.browser(); assert.equal(f.state().qaFailures.browser, undefined);
  assert.match(f.report(), /QA 완료 조건: \*\*충족\*\*/);
});

test('QA 문서 재생성은 코드·증거 변경의 만료를 표시하고 수동 메모와 원래 기록을 보존한다', t => {
  const f = fixture(t); f.ready();
  const qa = '.frontend-workflow/features/42-search/QA.md';
  f.write(qa, f.report() + '형의 수동 메모: 모바일 확인 필요\n');
  const before = fingerprint(f.root); const recorded = f.state().evidence.browser.at;
  f.ok('qa-report'); assert.equal(fingerprint(f.root), before);
  assert.match(f.report(), /형의 수동 메모: 모바일 확인 필요/);
  f.write('app.js', 'export const value = 2;\n'); f.ok('qa-report');
  assert.match(f.report(), /\| test \| 재검증 필요 \|/);
  assert.match(f.report(), /기록 상태: 재검증 필요/);
  assert.match(f.report(), /QA 완료 조건: \*\*미충족\*\*/);
  assert.equal(f.state().evidence.browser.at, recorded);
  f.write('app.js', 'export const value = 1;\n');
  f.write(f.evidence + 'synthetic-browser.txt', 'changed artifact'); f.ok('qa-report');
  assert.match(f.report(), /기록 상태: 재검증 필요/);
  f.ok('replan', '--reason', 'acceptance changed');
  assert.match(f.report(), /\| 사용자 여정 \| 미실행 \|/);
  assert.match(f.report(), /형의 수동 메모: 모바일 확인 필요/);
});

test('QA 문서는 보고서 안의 Markdown·HTML을 실행 가능한 링크나 표 구조로 해석하지 않는다', t => {
  const f = fixture(t); f.qa(); f.ok('run', 'all');
  const checks = Object.fromEntries(BROWSER_CHECKS.map(name => [name, { status: 'pass', detail: '값 | ![tracking](https://example.invalid/pixel)\n<script>bad</script>' }]));
  f.browser({ checks });
  assert(!f.report().includes('![tracking]')); assert(!f.report().includes('<script>'));
  assert.match(f.report(), /&lt;script&gt;/);
});

test('기존 QA 메모의 원문을 보존하며 공백·괄호가 있는 증거 링크도 생성한다', t => {
  const f = fixture(t); f.qa();
  const qa = '.frontend-workflow/features/42-search/QA.md';
  const manual = '## 기존 메모\n줄바꿈 유지  \n형이 추가한 내용\n';
  f.write(qa, manual);
  const artifact = f.evidence + '화면 (모바일).txt'; f.write(artifact, 'Synthetic artifact; no browser used.');
  f.browser({ artifacts: [artifact] }); f.ok('qa-report');
  assert(f.report().startsWith(manual));
  assert.equal(f.report().split('<!-- frontend-workflow:qa:begin -->').length - 1, 1);
  assert(f.report().includes('evidence/%ED%99%94%EB%A9%B4%20%28%EB%AA%A8%EB%B0%94%EC%9D%BC%29.txt'));
});

test('깨진 브라우저 JSON도 거부 기록을 남기며 이전 통과 기록을 재사용하지 않는다', t => {
  const f = fixture(t); f.ready(); f.write(f.evidence + 'broken.json', '{ invalid json');
  f.bad(/JSON 형식 오류/, 'record', '--kind', 'browser', '--file', f.evidence + 'broken.json');
  assert.equal(f.state().evidence.browser, undefined);
  assert.deepEqual(f.state().qaFailures.browser.files, []);
  assert(!f.report().includes('[evidence/broken.json]'));
  assert.match(f.report(), /거부 이유: 브라우저 보고서 JSON 형식 오류/);
  assert.match(f.report(), /QA 완료 조건: \*\*미충족\*\*/);
});

test('실행기 설정 오류를 QA에 남기되 시나리오의 원문과 비밀값은 남기지 않는다', t => {
  const f = fixture(t);
  const secret = 'SYNTHETIC_SECRET_NOT_FOR_REPORT';
  f.write('bad-json.json', '{"password":"' + secret + '" invalid}');
  f.write('bad-schema.json', { schemaVersion: 0, password: secret });
  f.ready();
  for (const [file, reason] of [['bad-json.json', /시나리오 JSON 구문 오류/], ['bad-schema.json', /시나리오 schemaVersion: 1 필요/]]) {
    f.browser();
    const result = f.bad(reason, 'browser-run', '--from', file);
    assert(!result.stderr.includes(secret));
    assert.equal(f.state().evidence.browser, undefined);
    assert.match(f.report(), reason);
    assert(!f.report().includes(secret));
  }
});

test('빈 파일과 없는 브라우저 보고서도 이전 통과를 무효화하고 QA 문서에 남긴다', t => {
  const f = fixture(t); f.ready(); f.write(f.evidence + 'empty.json', '');
  for (const [name, pattern] of [['empty.json', /비어 있지 않은/], ['missing.json', /ENOENT/]]) {
    f.browser();
    f.bad(pattern, 'record', '--kind', 'browser', '--file', f.evidence + name);
    assert.equal(f.state().evidence.browser, undefined);
    assert.deepEqual(f.state().qaFailures.browser.files, []);
    assert.match(f.report(), /기록 상태: 기록 거부/);
    assert.match(f.report(), /QA 완료 조건: \*\*미충족\*\*/);
  }
  f.approve('pr'); f.git('add', '.'); f.git('commit', '-m', 'test: unreadable browser');
  f.bad(/browser/, 'advance', '--to', 'pr', '--url', 'https://github.com/example/app/pull/9');
});

test('QA 자동 영역의 손상과 외부 symlink는 원문을 보존하며 거부한다', t => {
  const f = fixture(t); f.start(); const qa = '.frontend-workflow/features/42-search/QA.md';
  const broken = '<!-- frontend-workflow:qa:begin -->\n형의 메모';
  f.write(qa, broken); f.bad(/마커/, 'qa-report'); assert.equal(f.report(), broken);
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'frontend-qa-outside-'));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  const target = path.join(outside, 'report.md'); fs.writeFileSync(target, 'preserve');
  fs.rmSync(path.join(f.root, qa)); fs.symlinkSync(target, path.join(f.root, qa));
  f.bad(/심볼릭 링크/, 'qa-report'); assert.equal(fs.readFileSync(target, 'utf8'), 'preserve');
});

test('자동 QA 갱신 실패를 명시하고 저장된 검사 결과를 문서 복구에 재사용한다', t => {
  const f = fixture(t); f.implement();
  const qa = '.frontend-workflow/features/42-search/QA.md';
  const manual = '<!-- frontend-workflow:qa:begin -->\n형의 메모'; f.write(qa, manual);
  f.bad(/상태는 저장됐지만 QA.md 갱신 실패/, 'run', 'all');
  assert.equal(f.state().checks.test.passed, true); assert.equal(f.report(), manual);
  const recordedAt = f.state().checks.test.at;
  f.write(qa, '형의 메모\n'); f.ok('qa-report');
  assert.match(f.report(), /\| test \| 통과 \|/);
  assert.equal(f.state().checks.test.at, recordedAt);
  assert(f.report().startsWith('형의 메모\n'));
});

test('기획 승인 없이는 구현할 수 없다', t => {
  const f = fixture(t); f.start(); f.bad(/승인/, 'advance', '--to', 'implement');
});

test('승인 뒤 기획서가 바뀌면 승인이 무효다', t => {
  const f = fixture(t); f.start(); f.approve(); f.write(f.state().plan, 'changed plan');
  f.bad(/승인/, 'advance', '--to', 'implement');
});

test('승인 뒤 설정 변경도 승인을 무효화한다', t => {
  const f = fixture(t); f.start(); f.approve();
  f.write('frontend-harness.config.json', { ...f.config, project: 'Changed' });
  f.bad(/승인/, 'advance', '--to', 'implement');
});

test('승인 근거 파일이 바뀌면 승인이 무효다', t => {
  const f = fixture(t); f.start(); f.approve(); f.write(f.evidence + 'plan-authorization.md', 'tampered');
  f.bad(/승인/, 'advance', '--to', 'implement');
});

test('두 번째 활성 기능과 단계 건너뛰기를 막는다', t => {
  const f = fixture(t); f.start();
  f.bad(/진행 중/, 'start', '--id', '43-second'); f.bad(/건너뛸/, 'advance', '--to', 'qa');
});

test('통합 브랜치에서 기능을 시작하지 않는다', t => {
  const f = fixture(t); f.git('switch', 'main'); f.bad(/기능 브랜치/, 'start', '--id', '42-search');
});

test('기록한 브랜치와 다른 브랜치의 변경 명령을 거부한다', t => {
  const f = fixture(t); f.start(); f.git('switch', '-c', 'codex/other');
  f.bad(/브랜치 불일치/, 'advance', '--to', 'implement');
});

test('체크 명령의 실패 종료 코드를 보존한다', t => {
  const f = fixture(t, { checks: { test: { argv: [process.execPath, '-e', 'process.exit(7)'], cwd: '.', timeoutMs: 1000 } } });
  f.implement(); const r = f.run('run', 'test'); assert.equal(r.status, 1);
  assert.equal(f.state().checks.test.exitCode, 7); assert.equal(f.state().checks.test.passed, false);
});

test('실행 파일 없음과 timeout을 통과로 기록하지 않는다', t => {
  const f = fixture(t, { checks: { test: { argv: ['frontend-harness-nonexistent-command'], cwd: '.', timeoutMs: 1000 } } });
  f.implement(); assert.equal(f.run('run', 'test').status, 1); assert.equal(f.state().checks.test.passed, false);
  f.write('frontend-harness.config.json', { ...f.config, checks: { test: { argv: [process.execPath, '-e', 'setTimeout(() => {}, 10000)'], cwd: '.', timeoutMs: 100 } } });
  f.ok('replan', '--reason', 'timeout fixture'); f.approve(); f.ok('advance', '--to', 'implement');
  assert.equal(f.run('run', 'test').status, 1); assert.match(f.state().checks.test.error, /ETIMEDOUT/);
});

test('명령이 코드를 자동 수정하면 통과로 기록하지 않는다', t => {
  const f = fixture(t, { checks: { test: { argv: [process.execPath, '-e', 'require("fs").writeFileSync("app.js", "changed")'], cwd: '.', timeoutMs: 1000 } } });
  f.implement(); assert.equal(f.run('run', 'test').status, 1); assert.equal(f.state().checks.test.sourceChanged, true);
});

test('run all은 첫 실패 뒤 다른 검사를 실행하지 않는다', t => {
  const f = fixture(t, { checks: {
    test: { argv: [process.execPath, '-e', 'process.exit(1)'], cwd: '.', timeoutMs: 1000 },
    extra: { argv: [process.execPath, '-e', 'process.exit(0)'], cwd: '.', timeoutMs: 1000 },
  } });
  f.implement(); assert.equal(f.run('run', 'all').status, 1); assert.equal(f.state().checks.extra, undefined);
});

test('요약 검사는 로그를 펼치지 않고 실제 결과와 실패 로그 경로를 반환한다', t => {
  const output = 'FIXTURE_OUTPUT_NOT_FOR_SUMMARY';
  const f = fixture(t, { checks: {
    test: { argv: [process.execPath, '-e', `console.log('${output}')`], cwd: '.', timeoutMs: 1000 },
    extra: { argv: [process.execPath, '-e', `console.error('${output}'); process.exit(7)`], cwd: '.', timeoutMs: 1000 },
    later: { argv: [process.execPath, '-e', 'process.exit(0)'], cwd: '.', timeoutMs: 1000 },
  } });
  f.implement();
  const run = f.run('run', 'all', '--compact');
  assert.equal(run.status, 1);
  assert(!run.stdout.includes(output));
  assert.equal(run.stderr, '');
  const [passed, failed, later] = JSON.parse(run.stdout);
  assert.deepEqual(passed, { name: 'test', passed: true });
  assert.equal(failed.name, 'extra');
  assert.equal(failed.passed, false);
  assert.equal(failed.exitCode, 7);
  assert.equal(failed.reason, 'exit-code');
  assert.equal(fs.readFileSync(path.join(f.root, failed.log), 'utf8').trim(), output);
  assert.equal(later, undefined);
  assert.equal(f.state().checks.test.passed, true);
  assert.equal(f.state().checks.extra.exitCode, 7);
  assert.match(f.ok('run', 'test'), /FIXTURE_OUTPUT_NOT_FOR_SUMMARY/);
});

test('shell 치환과 파이프 문자를 인자로만 전달한다', t => {
  const f = fixture(t, { checks: { test: { argv: [process.execPath, '-e', 'if(process.argv[1] !== "$(touch PWNED); echo x | cat") process.exit(1)', '$(touch PWNED); echo x | cat'], cwd: '.', timeoutMs: 1000 } } });
  f.implement(); f.ok('run', 'test'); assert.equal(fs.existsSync(path.join(f.root, 'PWNED')), false);
});

test('코드가 바뀌면 기존 검사와 리뷰가 무효다', t => {
  const f = fixture(t); f.qa(); f.ok('run', 'all'); f.browser();
  f.write('app.js', 'export const value = 2;\n'); f.bad(/검사 통과/, 'advance', '--to', 'ready');
  const status = JSON.parse(f.ok('status')); assert.equal(status.validChecks.test, false); assert.equal(status.validEvidence.review, false);
});

test('요약 상태는 단계와 증거의 유효성을 보여주고 큰 보고서 본문은 펼치지 않는다', t => {
  const f = fixture(t);
  assert.equal(JSON.parse(f.ok('status', '--compact')).active, false);
  f.ready();
  const detail = 'DETAIL_ONLY_IN_FULL_REPORT '.repeat(300);
  const checks = Object.fromEntries(BROWSER_CHECKS.map(name => [name, { status: 'pass', detail }]));
  f.browser({ checks });
  const stored = f.state();
  const full = f.ok('status');
  const raw = f.ok('status', '--compact');
  assert.deepEqual(f.state(), stored);
  const compact = JSON.parse(raw);
  assert.equal(compact.stage, 'ready');
  assert.equal(compact.approvals.plan, 'valid');
  assert.equal(compact.checks.test, 'passed');
  assert.equal(compact.evidence.browser, 'passed');
  assert.equal(compact.qaReport, '.frontend-workflow/features/42-search/QA.md');
  assert(full.includes(detail));
  assert(!raw.includes('DETAIL_ONLY_IN_FULL_REPORT'));
  assert(Buffer.byteLength(raw) < Buffer.byteLength(full));
  f.write('app.js', 'export const value = 2;\n');
  const stale = JSON.parse(f.ok('status', '--compact'));
  assert.equal(stale.checks.test, 'stale');
  assert.equal(stale.evidence.browser, 'stale');
});

test('증거 파일을 사후 수정하면 무효다', t => {
  const f = fixture(t); f.qa(); f.ok('run', 'all'); f.browser();
  f.write(f.evidence + 'synthetic-browser.txt', 'changed artifact');
  f.bad(/browser/, 'advance', '--to', 'ready');
});

test('검사 JSON 수정으로 통과 결과를 재사용하지 않는다', t => {
  const f = fixture(t); f.qa(); f.ok('run', 'all'); f.browser();
  f.write(f.evidence + 'check-test.json', '{}'); f.bad(/검사 통과/, 'advance', '--to', 'ready');
});

test('미해결 High 리뷰는 통과하지 않는다', t => {
  const f = fixture(t); f.implement(); f.ok('advance', '--to', 'review');
  f.write(f.evidence + 'review.json', { method: 'self', reviewer: 'test', scope: 'diff', findings: [{ severity: 'high', status: 'accepted', detail: 'duplicate submit', reason: 'later' }] });
  f.bad(/Critical\/High/, 'record', '--kind', 'review', '--file', f.evidence + 'review.json');
});

test('독립 리뷰 설정을 자체 리뷰로 충족하지 않는다', t => {
  const f = fixture(t, { reviewMode: 'independent' }); f.implement(); f.ok('advance', '--to', 'review');
  f.bad(/독립 리뷰/, 'record', '--kind', 'review', '--file', f.evidence + 'review.json');
});

test('브라우저 기록 없이 ready로 이동할 수 없다', t => {
  const f = fixture(t); f.qa(); f.ok('run', 'all'); f.bad(/browser/, 'advance', '--to', 'ready');
});

test('브라우저 blocked와 설정된 뷰포트 누락을 거부한다', t => {
  const f = fixture(t); f.qa();
  f.bad(/journey/, 'record', '--kind', 'browser', '--file', f.evidence + 'browser.json');
  f.write(f.evidence + 'browser.json', { url: 'http://localhost:3000', browser: 'fixture', apiMode: 'mock', viewports: [1280] });
  f.bad(/뷰포트/, 'record', '--kind', 'browser', '--file', f.evidence + 'browser.json');
});

test('실제 API 필수 설정에서 Mock을 통과시키지 않는다', t => {
  const f = fixture(t, { requireLiveApi: true }); f.qa();
  f.bad(/실제 API/, 'record', '--kind', 'browser', '--file', f.evidence + 'browser.json');
});

test('PR 생성 승인이 없거나 코드 미커밋이면 PR 단계로 가지 않는다', t => {
  const f = fixture(t); f.write('app.js', 'export const value = 42;\n'); f.ready();
  f.bad(/PR 생성 승인/, 'advance', '--to', 'pr', '--url', 'https://github.com/example/app/pull/9');
  f.approve('pr'); f.bad(/커밋/, 'advance', '--to', 'pr', '--url', 'https://github.com/example/app/pull/9');
});

test('GitHub 필수 체크 누락을 설정 저장·기능 착수·PR 연결 전에 거부한다', t => {
  const f = fixture(t);
  const missing = { ...f.config, github: { ...f.config.github, requiredChecks: [] } };
  f.write('missing-checks.json', missing);
  f.bad(/github.requiredChecks/, 'configure', '--from', 'missing-checks.json');
  f.write('frontend-harness.config.json', missing);
  f.bad(/github.requiredChecks/, 'start', '--id', '42-search');
  f.write('frontend-harness.config.json', f.config);
  f.ready();
  f.write('frontend-harness.config.json', missing);
  f.bad(/github.requiredChecks/, 'advance', '--to', 'pr', '--url', 'https://github.com/example/app/pull/9');
  assert.equal(f.state().stage, 'ready');
});

test('PR 단계에 이르러도 수기 CI·머지 JSON만으로 완료할 수 없다', t => {
  const f = fixture(t); f.pr(); assert.equal(f.state().evidence.ci, undefined);
  f.write(f.evidence + 'ci.json', { status: 'pass', headSha: f.git('rev-parse', 'HEAD'), runUrl: 'https://github.com/example/app/actions/runs/1' });
  f.bad(/finalize/, 'record', '--kind', 'ci', '--file', f.evidence + 'ci.json');
  f.write(f.evidence + 'merge.json', { merged: true, pullRequestUrl: f.state().pullRequestUrl, targetBranch: 'main', mergeCommit: 'a'.repeat(40), mergedAt: '2026-10-28T01:00:00Z' });
  f.bad(/finalize/, 'record', '--kind', 'merge', '--file', f.evidence + 'merge.json');
  f.bad(/finalize/, 'advance', '--to', 'done');
  assert.equal(f.state().stage, 'pr');
});

test('기능을 머지한 새 체크아웃에서 수동 정리 없이 다음 기능을 시작한다', t => {
  const f = fixture(t); f.pr();
  assert(!f.git('ls-files').includes(ACTIVE_STATE));
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'frontend-harness-merged-'));
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const root = path.join(parent, 'checkout');
  const git = (...args) => {
    const r = spawnSync('git', args, { cwd: fs.existsSync(root) ? root : parent, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } });
    assert.equal(r.status, 0, r.stderr);
  };
  git('clone', '--branch', 'main', f.root, root);
  git('-c', 'user.name=Fixture', '-c', 'user.email=test@example.invalid', 'merge', '--no-ff', '-m', 'merge fixture', 'origin/codex/42-search');
  assert(fs.existsSync(path.join(root, '.frontend-workflow/features/42-search/QA.md')));
  assert(!fs.existsSync(path.join(root, ACTIVE_STATE)));
  git('switch', '-c', 'codex/43-next');
  const result = spawnSync(process.execPath, [cli, '--root', root, 'start', '--id', '43-next'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).id, '43-next');
});

test('통합 브랜치에 이미 들어간 구버전 ready 포인터가 새 기능을 막지 않는다', t => {
  const f = fixture(t); f.ready(); f.write('.frontend-workflow/state.json', f.state());
  f.git('add', '.'); f.git('add', '-f', '.frontend-workflow/state.json'); f.git('commit', '-m', 'legacy snapshot');
  fs.unlinkSync(path.join(f.root, ACTIVE_STATE));
  f.git('switch', 'main'); f.git('merge', '--no-ff', '-m', 'legacy merge', 'codex/42-search');
  f.git('switch', '-c', 'codex/43-next');
  assert.equal(JSON.parse(f.ok('start', '--id', '43-next')).id, '43-next');
});

test('복구는 같은 브랜치의 보관 기록을 복원하고 활성 작업을 덮어쓰지 않는다', t => {
  const f = fixture(t); f.ready();
  f.bad(/활성 기능/, 'restore', '--id', '42-search');
  fs.unlinkSync(path.join(f.root, ACTIVE_STATE));
  assert.equal(JSON.parse(f.ok('restore', '--id', '42-search')).stage, 'ready');
  fs.unlinkSync(path.join(f.root, ACTIVE_STATE));
  f.git('switch', '-c', 'codex/other');
  f.bad(/브랜치/, 'restore', '--id', '42-search');
});

test('미적용 사유와 테스트가 있는 non-ui 작업만 로컬로 전달한다', t => {
  const f = fixture(t, { github: { enabled: false }, qa: { allowNonUi: true } });
  f.bad(/--reason/, 'start', '--id', '42-search', '--qa', 'non-ui');
  f.ok('start', '--id', '42-search', '--qa', 'non-ui', '--reason', 'UI와 요청 계약이 바뀌지 않는 내부 순수 함수 수정');
  f.approve(); f.ok('advance', '--to', 'implement'); f.ok('advance', '--to', 'review');
  f.review(); f.ok('advance', '--to', 'qa');
  f.bad(/test 검사/, 'advance', '--to', 'ready');
  f.ok('run', 'all'); f.ok('advance', '--to', 'ready');
  assert.match(f.report(), /해당 없음.*내부 순수 함수 수정/);
  f.bad(/로컬 모드/, 'advance', '--to', 'pr', '--url', 'https://github.com/example/app/pull/9');
  assert.deepEqual(JSON.parse(f.ok('advance', '--to', 'delivered')), { stage: 'delivered', merged: false });
});

test('자동 검증이 필수일 때 직접 작성한 live 또는 자동화 JSON을 받지 않는다', t => {
  const f = fixture(t, { requireLiveApi: true }); f.qa();
  assert.throws(() => f.browser({ apiMode: 'live' }), /관측 결과/);
  assert.throws(() => f.browser({ apiMode: 'live', automation: { fake: true } }), /browser-run/);
  assert.equal(f.state().evidence.browser, undefined);
});

test('PR 단계의 로컬 진행 출력은 GitHub 동기화 블록과 같고 PR URL을 포함한다', t => {
  const f = fixture(t); f.pr();
  const output = f.ok('issue-body').trim();
  let body = '## 사용자 목적\n보존할 본문\n';
  let edits = 0;
  const fake = args => {
    if (args[1] === 'view') return JSON.stringify({ body, state: 'OPEN', updatedAt: 'same-time' });
    if (args[1] === 'edit') { body = fs.readFileSync(args.at(-1), 'utf8'); edits++; return ''; }
    assert.fail(args.join(' '));
  };
  assert.equal(githubWorkflow(f.root, 'issue-sync', {}, fake).synced, true);
  assert.equal(edits, 1);
  assert.match(body, /^## 사용자 목적\n보존할 본문/);
  const remoteBlock = body.match(/<!-- frontend-workflow:begin -->[\s\S]*?<!-- frontend-workflow:end -->/)?.[0];
  assert.equal(output, remoteBlock);
  assert(output.includes(`PR: ${f.state().pullRequestUrl}`));
});

test('CodeRabbit 생략·다른 head·미해결 High를 통과시키지 않는다', t => {
  const f = fixture(t, { codeRabbit: { required: true } }); f.pr();
  const file = f.evidence + 'coderabbit.json';
  const base = { provider: 'coderabbitai', status: 'completed', headSha: f.git('rev-parse', 'HEAD'), reviewUrl: f.state().pullRequestUrl + '#pullrequestreview-1', findings: [] };
  f.write(file, { ...base, status: 'skipped' }); f.bad(/실제 완료/, 'record', '--kind', 'coderabbit', '--file', file);
  f.write(file, { ...base, headSha: 'a'.repeat(40) }); f.bad(/현재 HEAD/, 'record', '--kind', 'coderabbit', '--file', file);
  f.write(file, { ...base, findings: [{ severity: 'high', status: 'accepted', detail: 'duplicate writes', reason: 'later' }] });
  f.bad(/Critical\/High/, 'record', '--kind', 'coderabbit', '--file', file);
  f.write(file, base); f.ok('record', '--kind', 'coderabbit', '--file', file);
});

test('재기획은 승인과 검증을 지우고 이력을 보존한다', t => {
  const f = fixture(t); f.qa(); f.ok('run', 'all'); f.ok('replan', '--reason', 'API contract changed');
  const s = f.state(); assert.equal(s.stage, 'plan'); assert.deepEqual(s.approvals, {}); assert.deepEqual(s.checks, {});
  assert.equal(s.history.at(-1).reason, 'API contract changed');
});

test('경로 탈출과 외부 심볼릭 링크를 거부한다', t => {
  const f = fixture(t); assert.throws(() => inside(f.root, '../outside'), /밖 경로/);
  fs.symlinkSync(os.tmpdir(), path.join(f.root, 'escape'));
  assert.throws(() => inside(f.root, 'escape/a.json'), /심볼릭 링크/);
});

test('evidence의 ..와 심볼릭 링크로 다른 파일을 승인 근거에 넣지 않는다', t => {
  const f = fixture(t); f.start();
  f.bad(/evidence/, 'approve', '--gate', 'plan', '--by', 'test', '--file', f.evidence + '../../../../app.js');
  fs.symlinkSync(path.join(f.root, 'app.js'), path.join(f.root, f.evidence, 'linked.md'));
  f.bad(/다른 디렉터리/, 'approve', '--gate', 'plan', '--by', 'test', '--file', f.evidence + 'linked.md');
});

test('원자적 lock이 동시 변경을 막는다', t => {
  const f = fixture(t); f.start(); fs.mkdirSync(path.join(f.root, '.frontend-workflow/.lock'));
  f.bad(/lock/, 'advance', '--to', 'implement');
});

test('코드 지문은 새 파일·삭제를 감지하고 증거는 제외한다', t => {
  const f = fixture(t); const original = fingerprint(f.root);
  f.write('.frontend-workflow/random.json', '{}'); assert.equal(fingerprint(f.root), original);
  f.write('new.js', 'new file'); assert.notEqual(fingerprint(f.root), original);
  fs.rmSync(path.join(f.root, 'new.js')); assert.equal(fingerprint(f.root), original);
  fs.rmSync(path.join(f.root, 'app.js')); assert.notEqual(fingerprint(f.root), original);
});

test('삭제·이름 변경을 커밋해도 실제 파일 내용이 같으면 지문이 유지된다', t => {
  const f = fixture(t);
  fs.renameSync(path.join(f.root, 'app.js'), path.join(f.root, 'renamed.js'));
  const beforeCommit = fingerprint(f.root);
  f.git('add', '.'); f.git('commit', '-m', 'test: rename');
  assert.equal(fingerprint(f.root), beforeCommit);
});

test('소비 앱의 gitignore가 없어도 원시 로그와 lock을 커밋에서 제외한다', t => {
  const f = fixture(t); fs.rmSync(path.join(f.root, '.gitignore')); f.implement(); f.ok('run', 'all');
  assert.match(f.git('check-ignore', f.evidence + 'check-test.log'), /check-test.log/);
  assert.match(f.git('check-ignore', '.frontend-workflow/.lock/owner.json'), /owner.json/);
  assert.equal(f.git('ls-files', '--others', '--exclude-standard').includes('check-test.log'), false);
});

test('예시 설정과 미적용 사유 없는 설정을 활성화하지 않는다', t => {
  const f = fixture(t);
  assert.throws(() => validateConfig({ ...f.config, configured: false }), /configured/);
  assert.throws(() => validateConfig({ ...f.config, notApplicable: {} }), /lint/);
});

test('설치는 기존 앱 파일을 보존하고 설치 후 CLI가 독립 실행된다', t => {
  const f = fixture(t); f.write('AGENTS.md', 'existing agent rules'); f.write('docs/README.md', 'existing docs');
  const install = () => spawnSync(process.execPath, [path.join(source, 'scripts/install.mjs'), '--target', f.root], { encoding: 'utf8' });
  assert.equal(install().status, 0);
  assert.equal(fs.readFileSync(path.join(f.root, 'AGENTS.md'), 'utf8'), 'existing agent rules');
  assert.equal(fs.readFileSync(path.join(f.root, 'docs/README.md'), 'utf8'), 'existing docs');
  const installed = path.join(f.root, '.agents/skills/frontend-workflow-harness/scripts/harness.mjs');
  const result = spawnSync(process.execPath, [installed, '--root', f.root, 'doctor'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const bundleCheck = spawnSync(process.execPath, [path.join(path.dirname(installed), 'check-repository.mjs')], { encoding: 'utf8' });
  assert.equal(bundleCheck.status, 0, bundleCheck.stderr);
  const started = spawnSync(process.execPath, [installed, '--root', f.root, 'start', '--id', '42-search'], { encoding: 'utf8' });
  assert.equal(started.status, 0, started.stderr); assert.equal(install().status, 1);
});

test('설치 업데이트는 구버전의 검증 가능한 기준을 요구하고 사용자 파일과 이전 설치를 보존한다', t => {
  const f = fixture(t); f.start();
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-release-baseline-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  for (const name of ['SKILL.md', 'README.md', 'docs', 'config', 'scripts', 'tests', 'examples', '.github', '.coderabbit.yaml', 'package.json', 'LICENSE']) fs.cpSync(path.join(source, name), path.join(base, name), { recursive: true });
  const pkg = JSON.parse(fs.readFileSync(path.join(base, 'package.json'), 'utf8'));
  fs.writeFileSync(path.join(base, 'package.json'), JSON.stringify({ ...pkg, version: '1.0.0' }));
  const install = (bundle, ...args) => spawnSync(process.execPath, [path.join(bundle, 'scripts/install.mjs'), '--target', f.root, ...args], { encoding: 'utf8' });
  assert.equal(install(base).status, 0);
  const bundle = path.join(f.root, '.agents/skills/frontend-workflow-harness');
  const manifest = path.join(bundle, '.harness-install.json');
  fs.writeFileSync(path.join(base, 'package-lock.json'), '{}');
  fs.writeFileSync(path.join(base, 'THIRD_PARTY_NOTICES.md'), '1.0 설치기가 복사하지 않은 파일');
  const oldManifest = fs.readFileSync(manifest);
  const preview = install(source, '--update', '--dry-run');
  assert.equal(preview.status, 0, preview.stderr);
  assert.equal(JSON.parse(preview.stdout).next, pkg.version);
  assert.deepEqual(fs.readFileSync(manifest), oldManifest);
  fs.unlinkSync(manifest);
  assert.match(install(source, '--update').stderr, /--baseline/);
  const oldReadme = fs.readFileSync(path.join(bundle, 'README.md'));
  fs.appendFileSync(path.join(bundle, 'README.md'), '사용자가 바꾼 내용');
  assert.match(install(source, '--update', '--baseline', base).stderr, /수정되거나 사라진/);
  fs.writeFileSync(path.join(bundle, 'README.md'), oldReadme);
  fs.writeFileSync(path.join(bundle, 'my-notes.md'), '사용자 메모');
  const stateBefore = f.state();
  const injected = '.frontend-workflow/runtime/interrupt-install.mjs';
  f.write(injected, `import fs from 'node:fs';
import path from 'node:path';
const rename = fs.renameSync;
const failure = process.env.HARNESS_TEST_INSTALL_FAILURE;
fs.renameSync = (from, to) => {
  if (failure === 'backup' && path.basename(to) === 'bundle') throw new Error('fixture backup move failed');
  if (path.basename(from).startsWith('install-stage-') && path.basename(to) === 'frontend-workflow-harness') {
    if (failure === 'activate') throw new Error('fixture activation failed');
    process.exit(97);
  }
  return rename(from, to);
};`);
  const failSwap = failure => spawnSync(process.execPath, ['--import', pathToFileURL(path.join(f.root, injected)).href,
    path.join(source, 'scripts/install.mjs'), '--target', f.root, '--update', '--baseline', base], {
    encoding: 'utf8', env: { ...process.env, HARNESS_TEST_INSTALL_FAILURE: failure },
  });
  const journal = path.join(f.root, '.frontend-workflow/runtime/install-swap-codex.json');
  for (const failure of ['backup', 'activate']) {
    const result = failSwap(failure);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /fixture .* failed/);
    assert(!fs.existsSync(journal));
    assert.equal(fs.readFileSync(path.join(bundle, 'my-notes.md'), 'utf8'), '사용자 메모');
    assert.equal(install(source, '--update', '--baseline', base, '--dry-run').status, 0);
  }
  const abort = failSwap('interrupt');
  assert.equal(abort.status, 97, abort.stderr);
  assert(!fs.existsSync(bundle));
  assert(fs.existsSync(journal));
  assert.match(install(source, '--update', '--baseline', base, '--dry-run').stderr, /미완료 교체/);
  assert(fs.existsSync(journal));
  assert.match(install(source, '--update', '--baseline', base).stderr, /lock/);
  // spawnSync verified the owner exited, so follow the normal stale lock recovery.
  fs.rmSync(path.join(f.root, '.frontend-workflow/.lock'), { recursive: true });
  const update = install(source, '--update', '--baseline', base);
  assert.equal(update.status, 0, update.stderr);
  const report = JSON.parse(update.stdout);
  assert.equal(report.recovered, true);
  assert(!fs.existsSync(journal));
  assert.equal(report.next, pkg.version);
  assert(report.added.includes('package-lock.json'));
  assert(!report.removed.includes('THIRD_PARTY_NOTICES.md'));
  assert.equal(fs.readFileSync(path.join(bundle, 'my-notes.md'), 'utf8'), '사용자 메모');
  assert.equal(fs.readFileSync(path.join(report.backup, 'my-notes.md'), 'utf8'), '사용자 메모');
  assert.deepEqual(f.state(), stateBefore);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.root, 'frontend-harness.config.json'), 'utf8')), f.config);
  assert.equal(JSON.parse(install(source, '--update').stdout).noop, true);
});
