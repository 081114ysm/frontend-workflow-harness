#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import {
  CONFIG, STAGES, ensure, fail, sha, now, readJson, inside, writeJson,
  git, loadConfig, validateConfig, loadState, saveState, featureDirectory, progressBlock, writeQaReport,
  fingerprint, planHash, configHash, approvalValid, assertPlan, evidenceFile,
  evidenceValid, validateReport, assertReady, assertCleanSource, withLock, activeState, terminal, restoreState, sourceFiles, BROWSER_CHECKS, requiredGithubChecks,
} from './lib.mjs';
import { parseScenario, browserExecutionTimeout } from './browser-scenario.mjs';

const bundle = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function parse(argv) {
  const values = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) { values._.push(argv[i]); continue; }
    const key = argv[i].slice(2);
    if (key === 'compact') {
      ensure(!Object.hasOwn(values, key), '--compact 옵션 중복');
      values.compact = true;
      continue;
    }
    ensure(!Object.hasOwn(values, key) && argv[i + 1] && !argv[i + 1].startsWith('--'), `옵션 값이 필요하거나 중복됨: --${key}`);
    values[key] = argv[++i];
  }
  return values;
}

/** 프로젝트와 번들의 실행 환경을 읽기 전용으로 조사한다. */
function doctor(root) {
  const packageFile = inside(root, 'package.json');
  const pkg = fs.existsSync(packageFile) ? readJson(packageFile) : {};
  const lockfiles = ['pnpm-lock.yaml', 'package-lock.json', 'yarn.lock', 'bun.lock', 'bun.lockb'].filter(file => fs.existsSync(inside(root, file)));
  const require = createRequire(packageFile);
  const browserPackages = ['playwright', '@playwright/test'].filter(name => { try { require.resolve(name); return true; } catch { return false; } });
  return {
    root, node: process.version, harnessVersion: readJson(path.join(bundle, 'package.json')).version, browserPackages, git: git(root, ['rev-parse', '--show-toplevel'], true),
    branch: git(root, ['branch', '--show-current'], true),
    remote: git(root, ['remote', 'get-url', 'origin'], true).replace(/https?:\/\/[^/@]+:[^/@]+@/, 'https://[redacted]@'),
    lockfiles, packageManager: pkg.packageManager || null, scripts: pkg.scripts || {},
    configExists: fs.existsSync(inside(root, CONFIG)),
    note: '읽기 전용 탐색 결과. 실제 명령/통합 브랜치/디자인/API 원본은 설정과 대조할 것.',
  };
}

/** 확인된 기능 브랜치에서 기획·검증 틀과 활성 상태를 만든다. */
function newFeature(root, config, options) {
  ensure(/^[a-z0-9][a-z0-9-]{0,79}$/.test(options.id || ''), '--id: 소문자/숫자/하이픈, 최대 80자');
  requiredGithubChecks(config);
  const active = activeState(root, config);
  ensure(!active || terminal(active), '진행 중인 기능이 있음. 먼저 완료하거나 해당 기능을 재개할 것');
  const qaKind = options.qa || 'browser';
  ensure(['browser', 'non-ui'].includes(qaKind), '--qa browser|non-ui 필요');
  if (qaKind === 'non-ui') ensure(config.qa?.allowNonUi && !config.requireLiveApi && options.reason?.trim() && config.checks.test, 'non-ui: 프로젝트 허용, --reason, test 검사 필요');
  const head = git(root, ['rev-parse', 'HEAD']);
  const branch = git(root, ['branch', '--show-current']);
  ensure(branch && branch !== config.integrationBranch && branch.startsWith(config.branchPrefix), `보호 브랜치가 아닌 ${config.branchPrefix} 기능 브랜치에서 시작해야 함`);
  const baseSha = git(root, ['rev-parse', '--verify', `${config.integrationBranch}^{commit}`]);
  git(root, ['merge-base', '--is-ancestor', baseSha, head]);
  const state = {
    schemaVersion: 1, id: options.id, issue: options.issue || null, stage: 'plan', branch,
    baseSha, createdAt: now(), updatedAt: now(), plan: '', approvals: {}, checks: {}, evidence: {}, history: [],
    qaProfile: qaKind === 'non-ui' ? { kind: qaKind, reason: options.reason.trim() } : { kind: qaKind },
  };
  const directory = inside(root, featureDirectory(state));
  ensure(!fs.existsSync(directory), '동일 기능 ID의 기록이 이미 있음. 다른 ID를 쓰거나 기존 기능을 재개할 것');
  state.plan = `${featureDirectory(state)}/plan.md`;
  fs.mkdirSync(path.join(directory, 'evidence'), { recursive: true });
  fs.copyFileSync(path.join(bundle, 'docs/templates/feature-plan.md'), inside(root, state.plan));
  if (qaKind === 'non-ui') fs.appendFileSync(inside(root, state.plan), '\n## QA 프로필\n\n- 화면 QA 미적용: ' + state.qaProfile.reason.replace(/\s+/g, ' ') + '\n- 대체 근거: 프로젝트의 test 검사와 코드 리뷰\n');
  for (const kind of ['review', 'browser', 'coderabbit']) {
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

/** 실제 검사와 증거는 동일하게 남기고, 요약 모드에서는 원시 로그를 출력하지 않는다. */
function runCheck(root, state, config, name, compact) {
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
  const log = `${featureDirectory(state)}/evidence/check-${name}.log`;
  fs.writeFileSync(inside(root, log), (result.stdout || '') + (result.stderr || ''));
  writeJson(inside(root, file), record);
  record.files = [evidenceFile(root, state, file)];
  state.checks[name] = record;
  saveState(root, state, 'run', { name, passed });
  if (!compact) {
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    return { name, ...record, log };
  }
  if (passed) return { name, passed };
  const reason = record.sourceChanged ? 'source-changed' : result.error?.code ?? (record.signal ? 'signal' : 'exit-code');
  return { name, passed, exitCode: record.exitCode, signal: record.signal, reason, log };
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
function recordEvidence(root, state, config, options, automated = false) {
  const kind = options.kind;
  ensure(!['ci', 'merge'].includes(kind), 'CI·머지 기록은 github.mjs finalize에서 원격 조회로 생성');
  const allowed = { review: ['review', 'qa', 'ready', 'pr'], browser: ['qa', 'ready', 'pr'], coderabbit: ['pr'] };
  ensure(allowed[kind]?.includes(state.stage), `${kind}: 현재 단계에서 기록할 수 없음`);
  assertPlan(root, state, config);
  if (kind === 'coderabbit') assertCleanSource(root);
  let file; let report; let extra;
  try {
    file = evidenceFile(root, state, options.file);
    report = readJson(inside(root, file.path));
    if (kind === 'browser') {
      ensure(automated || !report?.automation, '자동 검증 결과는 browser-run으로만 기록');
      ensure(automated || !(config.requireLiveApi || config.qa?.automationRequired), '실제 API/자동 QA가 필수인 프로젝트는 browser-run의 관측 결과 필요');
      if (automated && report?.automation?.error) fail(report.automation.error);
    }
    extra = validateReport(root, state, config, kind, report);
  } catch (error) {
    if (kind === 'browser') {
      const reason = error instanceof SyntaxError ? '브라우저 보고서 JSON 형식 오류' : error.message;
      state.qaFailures ||= {};
      state.qaFailures.browser = { at: now(), error: reason, summary: report ?? null, files: file && report !== undefined ? [file] : [], ...(automated ? { automated: true } : {}) };
      delete state.evidence.browser;
      saveState(root, state, 'record-rejected', { kind });
      fail(reason);
    }
    throw error;
  }
  state.evidence[kind] = {
    at: now(), fingerprint: fingerprint(root), planHash: planHash(root, state),
    configHash: configHash(root), files: [file, ...extra], summary: report, ...(automated ? { automated: true } : {}),
  };
  if (kind === 'browser' && state.qaFailures) delete state.qaFailures.browser;
  saveState(root, state, 'record', { kind });
  return { kind, recorded: true };
}

/** 브라우저 실행 중 코드 변경을 확인하고 성공·실패 결과를 현재 기능에 연결한다. */
function runBrowser(root, state, config, options) {
  ensure(['qa', 'ready', 'pr'].includes(state.stage) && state.qaProfile?.kind !== 'non-ui', '화면 검증이 필요한 qa/ready/pr 단계에서 실행');
  assertPlan(root, state, config);
  const scenario = inside(root, options.from);
  const relative = path.relative(root, scenario).split(path.sep).join('/');
  ensure(fs.existsSync(scenario) && fs.realpathSync(scenario) === scenario && sourceFiles(root).includes(relative), '코드 지문에 포함되는 일반 시나리오 JSON 파일 필요');
  const before = fingerprint(root);
  let timeout = browserExecutionTimeout();
  try { timeout = browserExecutionTimeout(parseScenario(readJson(scenario), config.context.viewports)); }
  catch { /* The worker reports sanitized scenario errors. */ }
  const child = spawnSync(process.execPath, [path.join(bundle, 'scripts/browser-runner.mjs'), '--root', root, '--from', relative, '--widths', JSON.stringify(config.context.viewports)], {
    cwd: root, encoding: 'utf8', shell: false, timeout, maxBuffer: 4 * 1024 * 1024,
  });
  let report;
  if ([0, 1].includes(child.status) && !child.error) {
    try {
      const result = JSON.parse(child.stdout);
      if (child.status === 0 || result?.automation?.error) report = result;
    } catch { /* use the blocked report below */ }
  }
  if (!report || before !== fingerprint(root)) {
    let detail = '브라우저 실행기 종료 또는 보고서 생성 실패';
    if (report) detail = '실행 중 코드·시나리오가 변경됨';
    else if (child.error?.code === 'ETIMEDOUT') detail = '브라우저 실행기 시간 초과';
    else if (child.error?.code === 'ENOBUFS') detail = '브라우저 실행기 보고서 크기 초과';
    report = { url: 'http://localhost', browser: '실행 미확인', apiMode: 'unknown', viewports: [],
      checks: Object.fromEntries(BROWSER_CHECKS.map(name => [name, { status: 'blocked', detail }])), automation: { error: detail } };
  }
  const evidence = `${featureDirectory(state)}/evidence`;
  const artifact = `${evidence}/browser-automation.json`;
  const file = `${evidence}/browser.json`;
  writeJson(inside(root, artifact), report.automation);
  writeJson(inside(root, file), { ...report, artifacts: [artifact] });
  return { ...recordEvidence(root, state, config, { kind: 'browser', file }, true), apiMode: report.apiMode, evidence: artifact };
}

/** 현재 승인과 증거를 검증한 뒤 다음 단계 또는 로컬 전달로 이동한다. */
function advance(root, state, config, options) {
  ensure(!terminal(state), '이미 종료된 기능');
  if (options.to === 'delivered') {
    ensure(!config.github?.enabled && state.stage === 'ready', 'delivered는 로컬 전용 ready 단계에서만 가능');
    assertReady(root, state, config);
    state.stage = 'delivered';
    saveState(root, state, 'deliver-local');
    return { stage: 'delivered', merged: false };
  }
  ensure(options.to !== 'done', 'GitHub 모드에서는 github.mjs finalize 사용');
  const next = STAGES[STAGES.indexOf(state.stage) + 1];
  ensure(options.to === next, `단계를 건너뛸 수 없음. 다음 단계: ${next || '없음'}`);
  if (next === 'pr') requiredGithubChecks(config);
  assertPlan(root, state, config);
  if (next === 'qa') ensure(evidenceValid(root, state, state.evidence.review), '현재 코드의 리뷰 결과가 필요함');
  if (['ready', 'pr', 'done'].includes(next)) assertReady(root, state, config);
  if (next === 'pr') {
    ensure(config.github?.enabled, '로컬 모드는 advance --to delivered 사용');
    ensure(!config.approval.pr || approvalValid(root, state, 'pr'), '유효한 PR 생성 승인 기록 필요');
    ensure(/^https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/[1-9]\d*$/.test(options.url || '') && options.url.startsWith('https://github.com/' + config.github.repository + '/pull/'), '--url에 설정된 저장소의 실제 PR URL 필요');
    assertCleanSource(root);
    state.pullRequestUrl = options.url;
  }
  state.stage = next;
  saveState(root, state, 'advance');
  return { stage: next, pullRequestUrl: state.pullRequestUrl || null };
}

/** 상태 본문을 펼치기 전에 필요한 파일과 검증 상태만 보여준다. */
function compactStatus(root) {
  const file = inside(root, CONFIG);
  if (!fs.existsSync(file)) return { configured: false, config: CONFIG };
  const stored = readJson(file);
  if (stored?.configured === false) return { configured: false, config: CONFIG };
  const config = validateConfig(stored);
  const state = activeState(root, config);
  const branch = git(root, ['branch', '--show-current']);
  if (!state) return { configured: true, active: false, branch };

  const hasPlan = fs.existsSync(inside(root, state.plan));
  const outcome = record => {
    if (!record) return 'missing';
    if (!hasPlan || !evidenceValid(root, state, record)) return 'stale';
    return record.passed === false ? 'failed' : 'passed';
  };
  const checks = Object.fromEntries(Object.keys(config.checks).map(name => [name, outcome(state.checks[name])]));
  const kinds = new Set(['review', ...Object.keys(state.evidence)]);
  if (state.qaProfile?.kind !== 'non-ui') kinds.add('browser');
  if (['pr', 'done'].includes(state.stage)) {
    if (config.requireCi) kinds.add('ci');
    if (config.codeRabbit?.required) kinds.add('coderabbit');
    kinds.add('merge');
  }
  const evidence = Object.fromEntries([...kinds].map(kind => {
    const result = outcome(state.evidence[kind]);
    return [kind, result === 'missing' && state.qaFailures?.[kind] ? 'failed' : result];
  }));
  const approvals = Object.fromEntries(['plan', 'pr'].map(gate => {
    if (!config.approval[gate]) return [gate, 'not-required'];
    if (!state.approvals[gate]) return [gate, 'missing'];
    return [gate, hasPlan && approvalValid(root, state, gate) ? 'valid' : 'stale'];
  }));
  return {
    configured: true, id: state.id, stage: state.stage, branch: state.branch,
    ...(branch !== state.branch ? { actualBranch: branch } : {}),
    issue: state.issue, pullRequestUrl: state.pullRequestUrl, plan: state.plan, hasPlan,
    qaReport: `${featureDirectory(state)}/QA.md`, qaProfile: state.qaProfile?.kind ?? 'browser',
    approvals, checks, evidence,
  };
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
    commands: ['doctor', 'init', 'configure --from 설정.json', 'start --id 42-auth-login [--qa non-ui --reason 사유]', 'restore --id 기능ID', 'status [--compact]', 'qa-report', 'browser-run --from 시나리오.json', 'approve --gate plan|pr --by 승인자 --file 증거경로', 'advance --to implement|review|qa|ready|pr|delivered [--url PR주소]', 'run 검사이름|all [--compact]', 'record --kind review|browser|coderabbit --file 증거.json', 'replan --reason 변경이유', 'issue-body'],
  };
  if (command === 'doctor') return doctor(root);
  if (command === 'status') {
    if (options.compact) return compactStatus(root);
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
      requiredGithubChecks(config);
      for (const check of Object.values(config.checks)) inside(root, check.cwd);
      writeJson(inside(root, CONFIG), config);
      return { configured: true };
    }
    const config = loadConfig(root);
    if (command === 'start') return newFeature(root, config, options);
    if (command === 'restore') return restoreState(root, config, options.id);
    const state = loadState(root);
    ensure(git(root, ['branch', '--show-current']) === state.branch, `작업 브랜치 불일치. ${state.branch}에서 재개할 것`);
    if (command === 'qa-report') return { qaReport: writeQaReport(root, state), note: '저장된 사실을 현재 코드와 대조해 문서만 갱신함. 검증을 새로 실행하지 않음.' };
    if (command === 'approve') return recordApproval(root, state, options);
    if (command === 'advance') return advance(root, state, config, options);
    if (command === 'record') return recordEvidence(root, state, config, options);
    if (command === 'browser-run') return runBrowser(root, state, config, options);
    if (command === 'replan') {
      ensure(options.reason?.trim() && !terminal(state), '변경 이유 필요. 완료한 기능은 새 이슈로 처리');
      state.stage = 'plan'; state.approvals = {}; state.checks = {}; state.evidence = {};
      delete state.qaFailures;
      saveState(root, state, 'replan', { reason: options.reason });
      return { stage: state.stage, next: '기획서 변경과 재승인. 기존 PR이 있다면 변경 범위를 PR에도 반영할 것.' };
    }
    if (command === 'run') {
      const names = argument === 'all' ? Object.keys(config.checks) : [argument];
      const records = [];
      for (const name of names) {
        const record = runCheck(root, state, config, name, options.compact);
        records.push(record);
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
