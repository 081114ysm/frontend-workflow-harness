import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { githubWorkflow, mergeProgress, progressBlock } from '../scripts/github-lib.mjs';
import { codeRabbitConfig } from '../scripts/coderabbit-config.mjs';
import { BROWSER_CHECKS } from '../scripts/lib.mjs';

const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'frontend-harness-github-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const git = (...args) => {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } });
    assert.equal(result.status, 0, result.stderr); return result.stdout.trim();
  };
  const write = (relative, value) => {
    const full = path.join(root, relative); fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, typeof value === 'string' ? value : JSON.stringify(value));
  };
  git('init', '-b', 'main'); git('config', 'user.name', 'Harness Test'); git('config', 'user.email', 'test@example.invalid'); git('config', 'commit.gpgsign', 'false');
  write('frontend-harness.config.json', {
    schemaVersion: 1, configured: true, project: 'Fixture', integrationBranch: 'main', defaultBranch: 'main', branchPrefix: 'codex/',
    reviewMode: 'self', requireLiveApi: false, requireCi: true, approval: { plan: true, pr: true },
    github: { enabled: true, repository: 'example/app' }, codeRabbit: { required: true },
    checks: { test: { argv: [process.execPath, '-e', 'process.exit(0)'], cwd: '.', timeoutMs: 1000 } },
    notApplicable: { lint: 'fixture', typecheck: 'fixture', build: 'fixture' }, context: { viewports: [320] },
  });
  write('app.js', 'export const x = 1;'); git('add', '.'); git('commit', '-m', 'test: baseline'); git('switch', '-c', 'codex/42-search');
  const start = () => {
    const r = spawnSync(process.execPath, [path.join(source, 'scripts/harness.mjs'), '--root', root, 'start', '--id', '42-search', '--issue', 'https://github.com/example/app/issues/42'], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
  };
  const stateFile = path.join(root, '.frontend-workflow/state.json');
  const readState = () => JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  const setStage = stage => { const state = readState(); state.stage = stage; state.pullRequestUrl = 'https://github.com/example/app/pull/9'; write('.frontend-workflow/state.json', state); };
  return { root, git, write, start, readState, setStage };
}

test('진행 블록을 갱신하며 사용자가 쓴 나머지 이슈 본문을 보존한다', () => {
  const original = '## 목적\n사용자가 쓴 설명\n<!-- frontend-workflow:begin -->\nold\n<!-- frontend-workflow:end -->\n## 추가 메모\n보존';
  const result = mergeProgress(original, '<!-- frontend-workflow:begin -->\nnew\n<!-- frontend-workflow:end -->');
  assert.match(result, /^## 목적\n사용자가 쓴 설명/); assert.match(result, /## 추가 메모\n보존$/); assert(!result.includes('old'));
  assert.throws(() => mergeProgress('<!-- frontend-workflow:begin --> broken', 'x'), /깨졌거나/);
});

test('성공한 이슈 생성 요청은 재시도해도 중복 생성하지 않는다', t => {
  const f = fixture(t); f.write('.frontend-workflow/request.md', '실제 기능 요청 본문'); let calls = 0;
  const fake = args => { assert.equal(args[0], 'issue'); assert.equal(args[1], 'create'); calls++; return 'https://github.com/example/app/issues/42'; };
  const options = { key: 'search-request', title: '검색 구현', 'body-file': '.frontend-workflow/request.md' };
  assert.equal(githubWorkflow(f.root, 'issue-create', options, fake).created, true);
  assert.equal(githubWorkflow(f.root, 'issue-create', options, fake).reused, true); assert.equal(calls, 1);
});

test('생성 결과가 불확실하면 다시 만들지 않고 실제 이슈 연결을 요구한다', t => {
  const f = fixture(t); f.write('.frontend-workflow/request.md', 'feature');
  const options = { key: 'uncertain-request', title: '검색 구현', 'body-file': '.frontend-workflow/request.md' };
  assert.throws(() => githubWorkflow(f.root, 'issue-create', options, () => { throw new Error('synthetic timeout'); }), /timeout/);
  assert.throws(() => githubWorkflow(f.root, 'issue-create', options, () => assert.fail('중복 생성 금지')), /불확실/);
  const connected = githubWorkflow(f.root, 'issue-create', { ...options, existing: 'https://github.com/example/app/issues/42' }, () => JSON.stringify({ state: 'OPEN', url: 'https://github.com/example/app/issues/42' }));
  assert.equal(connected.reused, true);
});

test('frontmatter가 있는 본문과 다른 저장소 이슈 연결을 거부한다', t => {
  const f = fixture(t); f.write('.frontend-workflow/request.md', '---\nname: feature\n---\nbody');
  assert.throws(() => githubWorkflow(f.root, 'issue-create', { key: 'key', title: 'test', 'body-file': '.frontend-workflow/request.md' }, () => assert.fail()), /frontmatter/);
  assert.throws(() => githubWorkflow(f.root, 'issue-create', { key: 'key', title: 'test', existing: 'https://github.com/other/repo/issues/42' }, () => assert.fail()), /example\/app/);
});

test('이슈 동기화는 원격을 재확인하며 사용자 본문을 보존하고 결과를 검증한다', t => {
  const f = fixture(t); f.start(); let body = '## 사용자 목적\n보존\n';
  const fake = args => {
    if (args[1] === 'view') return JSON.stringify({ body, state: 'OPEN', updatedAt: 'same-time' });
    if (args[1] === 'edit') { body = fs.readFileSync(args.at(-1), 'utf8'); return ''; }
    assert.fail(args.join(' '));
  };
  assert.equal(githubWorkflow(f.root, 'issue-sync', {}, fake).synced, true);
  assert.match(body, /^## 사용자 목적\n보존/); assert.match(body, /현재 단계: plan/);
  body = body.replace('현재 단계: plan', '현재 단계: qa');
  assert.throws(() => githubWorkflow(f.root, 'issue-sync', {}, fake), /다른 곳에서 변경/);
});

test('ready와 승인 없이 PR 생성 명령을 실행하지 않는다', t => {
  const f = fixture(t); f.start();
  assert.throws(() => githubWorkflow(f.root, 'pr-create', {}, () => assert.fail('원격 생성 금지')), /ready/);
});

test('승인된 전체 로컬 결과로 PR을 생성하고 실제 head/base를 확인하며 재시도는 재사용한다', t => {
  const f = fixture(t); f.write('app.js', 'export const x = 42;'); f.start();
  const h = (...args) => {
    const r = spawnSync(process.execPath, [path.join(source, 'scripts/harness.mjs'), '--root', f.root, ...args], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr + r.stdout);
  };
  const prefix = '.frontend-workflow/features/42-search/evidence/';
  f.write(prefix + 'authorization.md', 'SYNTHETIC TEST authorization only.');
  h('approve', '--gate', 'plan', '--by', 'synthetic-user', '--file', prefix + 'authorization.md');
  h('advance', '--to', 'implement'); h('run', 'all'); h('advance', '--to', 'review');
  f.write(prefix + 'review.json', { method: 'self', reviewer: 'synthetic', scope: 'fixture diff', findings: [] });
  h('record', '--kind', 'review', '--file', prefix + 'review.json'); h('advance', '--to', 'qa');
  f.write(prefix + 'artifact.txt', 'Synthetic fixture; no actual browser used.');
  f.write(prefix + 'browser.json', { url: 'http://localhost:3000', browser: 'synthetic', apiMode: 'mock', viewports: [320],
    checks: Object.fromEntries(BROWSER_CHECKS.map(name => [name, { status: 'pass', detail: 'synthetic fixture' }])), artifacts: [prefix + 'artifact.txt'] });
  h('record', '--kind', 'browser', '--file', prefix + 'browser.json'); h('advance', '--to', 'ready');
  h('approve', '--gate', 'pr', '--by', 'synthetic-user', '--file', prefix + 'authorization.md');
  f.write(prefix + 'pr-body.md', 'Synthetic PR body'); f.git('add', '.'); f.git('commit', '-m', 'test: feature');
  let created = 0;
  const fake = args => {
    if (args[1] === 'list') return '[]';
    if (args[1] === 'create') { created++; return 'https://github.com/example/app/pull/9'; }
    if (args[1] === 'view') return JSON.stringify({ headRefName: 'codex/42-search', baseRefName: 'main', headRefOid: f.git('rev-parse', 'HEAD') });
    assert.fail(args.join(' '));
  };
  const options = { title: '검색 구현', 'body-file': prefix + 'pr-body.md' };
  assert.equal(githubWorkflow(f.root, 'pr-create', options, fake).reused, false);
  assert.equal(f.readState().stage, 'pr');
  assert.equal(githubWorkflow(f.root, 'pr-create', options, fake).reused, true); assert.equal(created, 1);
});

test('CodeRabbit skipped success를 실제 완료로 표시하지 않는다', t => {
  const f = fixture(t); f.start(); f.setStage('pr');
  let title = 'Review skipped';
  const fake = args => args[0] === 'api' ? JSON.stringify([{ id: 1, name: 'CodeRabbit', app: { slug: 'coderabbitai' }, status: 'completed', conclusion: 'success', output: { title } }])
    : JSON.stringify({ headRefOid: f.git('rev-parse', 'HEAD'), baseRefName: 'main', state: 'OPEN' });
  assert.equal(githubWorkflow(f.root, 'pr-inspect', {}, fake).actualCodeRabbitReviewCompleted, false);
  title = 'Finished'; assert.equal(githubWorkflow(f.root, 'pr-inspect', {}, fake).actualCodeRabbitReviewCompleted, true);
});

test('실제 머지가 확인되지 않으면 이슈 종료를 실행하지 않는다', t => {
  const f = fixture(t); f.start(); f.setStage('done');
  assert.throws(() => githubWorkflow(f.root, 'issue-close', {}, () => JSON.stringify({ state: 'OPEN', baseRefName: 'main' })), /실제 PR 머지/);
});

test('추가 통합 브랜치는 정규식 특수문자와 부분 일치를 방지한다', () => {
  const patterns = codeRabbitConfig('release/1.0+test', 'main').reviews.auto_review.base_branches;
  assert(new RegExp(patterns[0]).test('release/1.0+test'));
  assert(!new RegExp(patterns[0]).test('release/1X0test-more'));
  assert.deepEqual(codeRabbitConfig('main', 'main').reviews.auto_review.base_branches, []);
});

test('프로젝트 GitHub 준비는 기존 설정을 보존하고 새 파일만 만든다', t => {
  const f = fixture(t); f.write('.coderabbit.yaml', 'language: en-US\n');
  const result = spawnSync(process.execPath, [path.join(source, 'scripts/setup-github.mjs'), '--root', f.root], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr); const report = JSON.parse(result.stdout);
  assert.equal(report.requiresManualMerge, true); assert.equal(report.appInstalled, 'unknown');
  assert.equal(fs.readFileSync(path.join(f.root, '.coderabbit.yaml'), 'utf8'), 'language: en-US\n');
  assert(fs.existsSync(path.join(f.root, '.github/PULL_REQUEST_TEMPLATE.md')));
});

test('Claude 프로젝트 설치도 자체 완결된 번들을 제공한다', t => {
  const f = fixture(t);
  const result = spawnSync(process.execPath, [path.join(source, 'scripts/install.mjs'), '--target', f.root, '--host', 'claude'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert(fs.existsSync(path.join(f.root, '.claude/skills/frontend-workflow-harness/SKILL.md')));
});
