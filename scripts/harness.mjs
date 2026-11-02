#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import {
  STATE_DIR, CONFIG, STAGES, ensure, fail, sha, now, readJson, inside, writeJson,
  git, loadConfig, validateConfig, loadState, saveState, featureDirectory, progressBlock, writeQaReport,
  fingerprint, planHash, configHash, approvalValid, assertPlan, evidenceFile,
  evidenceValid, validateReport, assertReady, assertCleanSource, withLock,
} from './lib.mjs';

const bundle = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function parse(argv) {
  const values = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) { values._.push(argv[i]); continue; }
    const key = argv[i].slice(2);
    ensure(!Object.hasOwn(values, key) && argv[i + 1] && !argv[i + 1].startsWith('--'), `옵션 값이 필요하거나 중복됨: --${key}`);
    values[key] = argv[++i];
  }
  return values;
}

function doctor(root) {
  const packageFile = inside(root, 'package.json');
  const pkg = fs.existsSync(packageFile) ? readJson(packageFile) : {};
  const lockfiles = ['pnpm-lock.yaml', 'package-lock.json', 'yarn.lock', 'bun.lock', 'bun.lockb'].filter(file => fs.existsSync(inside(root, file)));
  return {
    root, node: process.version, git: git(root, ['rev-parse', '--show-toplevel'], true),
    branch: git(root, ['branch', '--show-current'], true),
    remote: git(root, ['remote', 'get-url', 'origin'], true).replace(/https?:\/\/[^/@]+:[^/@]+@/, 'https://[redacted]@'),
    lockfiles, packageManager: pkg.packageManager || null, scripts: pkg.scripts || {},
    configExists: fs.existsSync(inside(root, CONFIG)),
    note: '읽기 전용 탐색 결과. 실제 명령/통합 브랜치/디자인/API 원본은 설정과 대조할 것.',
  };
}

function newFeature(root, config, options) {
  ensure(/^[a-z0-9][a-z0-9-]{0,79}$/.test(options.id || ''), '--id: 소문자/숫자/하이픈, 최대 80자');
  const active = inside(root, `${STATE_DIR}/state.json`);
  if (fs.existsSync(active)) ensure(loadState(root).stage === 'done', '진행 중인 기능이 있음. 먼저 완료하거나 해당 기능을 재개할 것');
  const head = git(root, ['rev-parse', 'HEAD']);
  const branch = git(root, ['branch', '--show-current']);
  ensure(branch && branch !== config.integrationBranch && branch.startsWith(config.branchPrefix), `보호 브랜치가 아닌 ${config.branchPrefix} 기능 브랜치에서 시작해야 함`);
  const baseSha = git(root, ['rev-parse', '--verify', `${config.integrationBranch}^{commit}`]);
  git(root, ['merge-base', '--is-ancestor', baseSha, head]);
  const state = {
    schemaVersion: 1, id: options.id, issue: options.issue || null, stage: 'plan', branch,
    baseSha, createdAt: now(), updatedAt: now(), plan: '', approvals: {}, checks: {}, evidence: {}, history: [],
  };
  const directory = inside(root, featureDirectory(state));
  ensure(!fs.existsSync(directory), '동일 기능 ID의 기록이 이미 있음. 다른 ID를 쓰거나 기존 기능을 재개할 것');
  state.plan = `${featureDirectory(state)}/plan.md`;
  fs.mkdirSync(path.join(directory, 'evidence'), { recursive: true });
  fs.copyFileSync(path.join(bundle, 'docs/templates/feature-plan.md'), inside(root, state.plan));
  for (const kind of ['review', 'browser', 'ci', 'merge', 'coderabbit']) {
    fs.copyFileSync(path.join(bundle, `docs/templates/${kind}.example.json`), path.join(directory, 'evidence', `${kind}.json`));
  }
  saveState(root, state, 'start', { branch, baseSha });
  return { id: state.id, stage: state.stage, plan: state.plan, qaReport: `${featureDirectory(state)}/QA.md`, next: '기획서를 실제 내용으로 작성하고 사용자 승인 근거를 evidence/에 기록' };
}

function recordApproval(root, state, options) {
  const gate = options.gate;
  ensure(['plan', 'pr'].includes(gate) && options.by?.trim(), '--gate plan|pr와 실제 승인자 --by 필요');
  ensure(gate === 'plan' ? state.stage === 'plan' : state.stage === 'ready', 'plan 승인은 plan 단계, pr 승인은 ready 단계에서 기록');
  const file = evidenceFile(root, state, options.file);
  state.approvals[gate] = {
    at: now(), by: options.by, file: file.path, fileHash: file.hash,
    planHash: planHash(root, state), configHash: configHash(root), fingerprint: fingerprint(root),
  };
  saveState(root, state, 'approve', { gate, by: options.by });
  return { gate, recorded: true, note: '실제 사용자 지시의 기록이며 승인자를 인증하는 도구는 아님. 에이전트가 승인 문구를 만들어서는 안 됨.' };
}

function runCheck(root, state, config, name) {
  ensure(['implement', 'review', 'qa', 'ready', 'pr'].includes(state.stage), '구현 시작 후 검사할 것');
  assertPlan(root, state, config);
  const command = config.checks[name];
  ensure(command, `설정에 없는 검사: ${name}`);
  const before = fingerprint(root);
  const startedAt = now();
  const result = spawnSync(command.argv[0], command.argv.slice(1), {
    cwd: inside(root, command.cwd), encoding: 'utf8', shell: false,
    timeout: command.timeoutMs, maxBuffer: 20 * 1024 * 1024,
    env: { ...process.env, CI: 'true', NO_COLOR: '1' },
  });
  const after = fingerprint(root);
  const passed = result.status === 0 && !result.error && before === after;
  const record = {
    at: now(), startedAt, argv: command.argv, cwd: command.cwd, exitCode: result.status,
    signal: result.signal, error: result.error?.message || null, passed,
    sourceChanged: before !== after, fingerprint: after, planHash: planHash(root, state),
    configHash: configHash(root), files: [],
  };
  const file = `${featureDirectory(state)}/evidence/check-${name}.json`;
  // Store raw output only in ignored logs: it may contain private URLs or test data.
  fs.writeFileSync(inside(root, `${featureDirectory(state)}/evidence/check-${name}.log`), (result.stdout || '') + (result.stderr || ''));
  writeJson(inside(root, file), record);
  record.files = [evidenceFile(root, state, file)];
  state.checks[name] = record;
  saveState(root, state, 'run', { name, passed });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  return { ...record, log: `${featureDirectory(state)}/evidence/check-${name}.log` };
}

/**
 * 보고서와 증거를 검증해 현재 코드에 연결한다.
 * 거부된 브라우저 보고서는 QA 문서에 실패로 남기고 이전 통과 기록을 제거한다.
 * @param {string} root 대상 프로젝트 루트
 * @param {object} state 현재 기능 상태
 * @param {object} config 프로젝트 설정
 * @param {object} options 증거 종류와 보고서 파일 경로
 * @returns {object} 성공적으로 기록한 증거 종류와 결과
 */
function recordEvidence(root, state, config, options) {
  const kind = options.kind;
  const allowed = { review: ['review', 'qa', 'ready', 'pr'], browser: ['qa', 'ready', 'pr'], ci: ['pr'], merge: ['pr'], coderabbit: ['pr'] };
  ensure(allowed[kind]?.includes(state.stage), `${kind}: 현재 단계에서 기록할 수 없음`);
  assertPlan(root, state, config);
  if (['ci', 'merge', 'coderabbit'].includes(kind)) assertCleanSource(root);
  let file; let report; let extra;
  try {
    file = evidenceFile(root, state, options.file);
    report = readJson(inside(root, file.path));
    extra = validateReport(root, state, config, kind, report);
  } catch (error) {
    if (kind === 'browser') {
      const reason = error instanceof SyntaxError ? '브라우저 보고서 JSON 형식 오류' : error.message;
      state.qaFailures ||= {};
      state.qaFailures.browser = { at: now(), error: reason, summary: report ?? null, files: file && report !== undefined ? [file] : [] };
      delete state.evidence.browser;
      saveState(root, state, 'record-rejected', { kind });
      fail(reason);
    }
    throw error;
  }
  state.evidence[kind] = {
    at: now(), fingerprint: fingerprint(root), planHash: planHash(root, state),
    configHash: configHash(root), files: [file, ...extra], summary: report,
  };
  if (kind === 'browser' && state.qaFailures) delete state.qaFailures.browser;
  saveState(root, state, 'record', { kind });
  return { kind, recorded: true };
}

function advance(root, state, config, options) {
  const next = STAGES[STAGES.indexOf(state.stage) + 1];
  ensure(options.to === next, `단계를 건너뛸 수 없음. 다음 단계: ${next || '없음'}`);
  assertPlan(root, state, config);
  if (next === 'qa') ensure(evidenceValid(root, state, state.evidence.review), '현재 코드의 리뷰 결과가 필요함');
  if (['ready', 'pr', 'done'].includes(next)) assertReady(root, state, config);
  if (next === 'pr') {
    ensure(!config.approval.pr || approvalValid(root, state, 'pr'), '유효한 PR 생성 승인 기록 필요');
    ensure(/^https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/[1-9]\d*$/.test(options.url || ''), '--url에 생성된 GitHub PR URL 필요');
    assertCleanSource(root);
    state.pullRequestUrl = options.url;
  }
  if (next === 'done') {
    if (config.codeRabbit?.required) ensure(evidenceValid(root, state, state.evidence.coderabbit), '현재 코드의 실제 CodeRabbit 리뷰 완료와 지적 처리 증거 필요');
    if (config.requireCi) {
      ensure(evidenceValid(root, state, state.evidence.ci), '현재 코드의 성공한 CI 결과 필요');
      ensure(state.evidence.ci.summary.headSha === git(root, ['rev-parse', 'HEAD']), 'CI 실행 뒤 HEAD가 변경됨');
    }
    ensure(evidenceValid(root, state, state.evidence.merge), '실제 PR 머지 증거가 필요함');
  }
  state.stage = next;
  saveState(root, state, 'advance');
  return { stage: next, pullRequestUrl: state.pullRequestUrl || null };
}

/**
 * CLI 인자를 해석하고 프로젝트 경로에 맞는 명령을 실행한다.
 * 조회 명령은 파일을 변경하지 않으며 상태 변경 명령은 프로젝트 lock 안에서 실행한다.
 * @returns {object|string} JSON으로 출력할 명령 결과 또는 이슈 본문 문자열
 */
function main() {
  const options = parse(process.argv.slice(2));
  const [command, argument] = options._;
  const root = fs.realpathSync(path.resolve(options.root || process.cwd()));
  if (!command || command === 'help') return {
    usage: 'node scripts/harness.mjs [--root 프로젝트] 명령 [옵션]',
    commands: ['doctor', 'init', 'configure --from 설정.json', 'start --id 42-auth-login --issue URL', 'status', 'qa-report', 'approve --gate plan|pr --by 승인자 --file 증거경로', 'advance --to implement|review|qa|ready|pr|done [--url PR주소]', 'run 검사이름|all', 'record --kind review|browser|ci|merge|coderabbit --file 증거.json', 'replan --reason 변경이유', 'issue-body'],
  };
  if (command === 'doctor') return doctor(root);
  if (command === 'status') {
    const config = loadConfig(root); const state = loadState(root);
    return {
      ...state, actualBranch: git(root, ['branch', '--show-current']), currentFingerprint: fingerprint(root),
      validApprovals: Object.fromEntries(['plan', 'pr'].map(gate => [gate, !config.approval[gate] || approvalValid(root, state, gate)])),
      validChecks: Object.fromEntries(Object.entries(state.checks).map(([name, record]) => [name, record.passed && evidenceValid(root, state, record)])),
      validEvidence: Object.fromEntries(Object.entries(state.evidence).map(([kind, record]) => [kind, evidenceValid(root, state, record)])),
    };
  }
  if (command === 'issue-body') {
    const state = loadState(root);
    return progressBlock(state);
  }
  return withLock(root, () => {
    if (command === 'init') {
      const target = inside(root, CONFIG);
      ensure(!fs.existsSync(target), '설정이 이미 있음. 기존 파일을 보존함');
      fs.copyFileSync(path.join(bundle, 'config/project.example.json'), target, fs.constants.COPYFILE_EXCL);
      return { config: CONFIG, next: 'doctor 결과와 프로젝트 문서를 보고 설정 수정 후 configure --from 실행' };
    }
    if (command === 'configure') {
      ensure(options.from, '--from 설정 파일 필요');
      const config = validateConfig(readJson(inside(root, options.from)));
      for (const check of Object.values(config.checks)) inside(root, check.cwd);
      writeJson(inside(root, CONFIG), config);
      return { configured: true };
    }
    const config = loadConfig(root);
    if (command === 'start') return newFeature(root, config, options);
    const state = loadState(root);
    ensure(git(root, ['branch', '--show-current']) === state.branch, `작업 브랜치 불일치. ${state.branch}에서 재개할 것`);
    if (command === 'qa-report') return { qaReport: writeQaReport(root, state), note: '저장된 사실을 현재 코드와 대조해 문서만 갱신함. 검증을 새로 실행하지 않음.' };
    if (command === 'approve') return recordApproval(root, state, options);
    if (command === 'advance') return advance(root, state, config, options);
    if (command === 'record') return recordEvidence(root, state, config, options);
    if (command === 'replan') {
      ensure(options.reason?.trim() && state.stage !== 'done', '변경 이유 필요. 완료한 기능은 새 이슈로 처리');
      state.stage = 'plan'; state.approvals = {}; state.checks = {}; state.evidence = {};
      delete state.qaFailures;
      saveState(root, state, 'replan', { reason: options.reason });
      return { stage: state.stage, next: '기획서 변경과 재승인. 기존 PR이 있다면 변경 범위를 PR에도 반영할 것.' };
    }
    if (command === 'run') {
      const names = argument === 'all' ? Object.keys(config.checks) : [argument];
      const records = [];
      for (const name of names) {
        const record = runCheck(root, state, config, name); records.push({ name, ...record });
        if (!record.passed) { process.exitCode = 1; break; }
      }
      return records;
    }
    fail(`알 수 없는 명령: ${command}`);
  });
}

try {
  const result = main();
  console.log(typeof result === 'string' ? result : JSON.stringify(result, null, 2));
} catch (error) {
  console.error(`하네스 오류: ${error.message}`);
  process.exitCode = 1;
}
