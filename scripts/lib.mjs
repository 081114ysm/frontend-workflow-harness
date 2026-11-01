import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { renderQaReport, mergeQaReport } from './qa-report.mjs';

export const STATE_DIR = '.frontend-workflow';
export const CONFIG = 'frontend-harness.config.json';
export const STAGES = ['plan', 'implement', 'review', 'qa', 'ready', 'pr', 'done'];
export const BROWSER_CHECKS = ['journey', 'states', 'responsive', 'keyboard', 'console', 'network'];
export const fail = (message) => { throw new Error(message); };
export const ensure = (condition, message) => { if (!condition) fail(message); };
export const sha = (value) => crypto.createHash('sha256').update(value).digest('hex');
export const now = () => new Date().toISOString();
export const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
export const nonempty = (value) => typeof value === 'string' && value.trim().length > 0;

/**
 * 로컬 issue-body와 GitHub 동기화에서 공유하는 관리 블록을 만든다.
 * 현재 단계 이전의 항목을 완료로 표시하고 연결된 PR이 있으면 URL을 포함한다.
 * @param {object} state 저장된 기능 ID·기획서·진행 단계와 선택적 PR URL
 * @returns {string} 사용자 이슈 본문과 구별할 시작·종료 마커가 있는 진행 블록
 */
export function progressBlock(state) {
  return ['<!-- frontend-workflow:begin -->', `기능: ${state.id}`, `기획서: ${state.plan}`,
    `QA: ${featureDirectory(state)}/QA.md`,
    ...STAGES.map((stage, index) => `- [${index < STAGES.indexOf(state.stage) || state.stage === 'done' ? 'x' : ' '}] ${stage}`),
    `현재 단계: ${state.stage}`, ...(state.pullRequestUrl ? [`PR: ${state.pullRequestUrl}`] : []),
    '<!-- frontend-workflow:end -->'].join('\n');
}

// Resolve existing ancestors too: a symlink must not escape the selected project.
export function inside(root, relative) {
  ensure(nonempty(relative) && !path.isAbsolute(relative), `프로젝트 상대 경로가 필요함: ${relative}`);
  const base = fs.realpathSync(root);
  const target = path.resolve(base, relative);
  ensure(target === base || target.startsWith(base + path.sep), `프로젝트 밖 경로 거부: ${relative}`);
  let ancestor = target;
  while (!fs.existsSync(ancestor)) ancestor = path.dirname(ancestor);
  const real = fs.realpathSync(ancestor);
  ensure(real === base || real.startsWith(base + path.sep), `프로젝트 밖 심볼릭 링크 거부: ${relative}`);
  return target;
}

export function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(data, null, 2) + '\n', { flag: 'wx' });
  fs.renameSync(temporary, file);
}

export function git(root, args, optional = false) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 });
  if (optional && result.status !== 0) return '';
  ensure(result.status === 0, `Git 실패: ${args.join(' ')}\n${result.stderr || result.error || ''}`);
  return result.stdout.trim();
}

export function validateConfig(config) {
  ensure(config.schemaVersion === 1 && config.configured === true, '설정 예시를 실제 값으로 바꾸고 configured: true를 지정해야 함');
  for (const key of ['project', 'integrationBranch', 'defaultBranch', 'branchPrefix']) {
    ensure(nonempty(config[key]), `설정 누락: ${key}`);
  }
  ensure(['self', 'independent'].includes(config.reviewMode), 'reviewMode: self 또는 independent');
  for (const key of ['requireLiveApi', 'requireCi']) ensure(typeof config[key] === 'boolean', `${key}: boolean 필요`);
  if (config.github) {
    ensure(typeof config.github.enabled === 'boolean', 'github.enabled: boolean 필요');
    ensure(!config.github.enabled || /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(config.github.repository || ''), 'github.repository: 실제 owner/repo 필요');
  }
  if (config.codeRabbit) ensure(typeof config.codeRabbit.required === 'boolean', 'codeRabbit.required: boolean 필요');
  for (const gate of ['plan', 'pr']) ensure(typeof config.approval?.[gate] === 'boolean', `approval.${gate}: boolean 필요`);
  ensure(config.checks && typeof config.checks === 'object' && !Array.isArray(config.checks), 'checks 객체 필요');
  ensure(Object.keys(config.checks).length > 0, '실행할 검사 명령이 하나 이상 필요함');
  for (const key of ['lint', 'typecheck', 'test', 'build']) {
    ensure(config.checks[key] || nonempty(config.notApplicable?.[key]), `${key} 명령 또는 구체적인 미적용 사유 필요`);
    ensure(!(config.checks[key] && config.notApplicable?.[key]), `${key}: 실행과 미적용을 동시에 지정할 수 없음`);
  }
  for (const [name, check] of Object.entries(config.checks)) {
    ensure(/^[a-z][a-z0-9-]*$/.test(name), `잘못된 검사 이름: ${name}`);
    ensure(Array.isArray(check.argv) && check.argv.length > 0 && check.argv.every(nonempty), `${name}: argv 문자열 배열 필요`);
    ensure(nonempty(check.cwd), `${name}: cwd 필요`);
    ensure(Number.isInteger(check.timeoutMs) && check.timeoutMs >= 100 && check.timeoutMs <= 1800000, `${name}: timeoutMs 범위 100~1800000`);
  }
  ensure(Array.isArray(config.context?.viewports) && config.context.viewports.length > 0 && config.context.viewports.every(v => Number.isInteger(v) && v >= 240), 'context.viewports: 240 이상 정수 배열 필요');
  return config;
}

export function loadConfig(root) { return validateConfig(readJson(inside(root, CONFIG))); }

export function sourceFiles(root) {
  const result = spawnSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: root, encoding: 'utf8' });
  ensure(result.status === 0, '먼저 Git 저장소를 초기화해야 함');
  return [...new Set(result.stdout.split('\0').filter(Boolean))]
    .filter(file => !file.startsWith(STATE_DIR + '/')).sort();
}

export function fingerprint(root) {
  const hash = crypto.createHash('sha256');
  for (const file of sourceFiles(root)) {
    const full = inside(root, file);
    let stat;
    try { stat = fs.lstatSync(full); } catch (error) {
      // A deleted path must disappear both before and after committing the deletion.
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    hash.update(file + '\0');
    ensure(stat.isFile() || stat.isSymbolicLink(), `지원하지 않는 Git 항목: ${file}`);
    hash.update(stat.isSymbolicLink() ? `link:${fs.readlinkSync(full)}` : `file:${stat.mode & 0o111}:`);
    if (stat.isFile()) hash.update(fs.readFileSync(full));
    hash.update('\0');
  }
  return hash.digest('hex');
}

export function featureDirectory(state) { return `${STATE_DIR}/features/${state.id}`; }
export function planHash(root, state) { return sha(fs.readFileSync(inside(root, state.plan))); }
export function configHash(root) { return sha(fs.readFileSync(inside(root, CONFIG))); }

export function loadState(root) {
  const state = readJson(inside(root, `${STATE_DIR}/state.json`));
  ensure(state.schemaVersion === 1 && /^[a-z0-9][a-z0-9-]{0,79}$/.test(state.id) && STAGES.includes(state.stage), '상태 파일 형식이 올바르지 않음');
  ensure(state.plan === `${featureDirectory(state)}/plan.md`, '기획서 경로가 상태와 일치하지 않음');
  return state;
}

/**
 * 기능 이력과 활성 상태를 먼저 저장한 뒤 파생 QA 문서를 갱신한다.
 * 문서 생성 실패 시 저장된 사실은 유지하고 명시적인 복구 오류를 반환한다.
 * @param {string} root 대상 프로젝트 루트
 * @param {object} state 변경한 기능 상태
 * @param {string} action 기록할 작업명
 * @param {object} detail 이력에 추가할 작업 정보
 */
export function saveState(root, state, action, detail = {}) {
  state.updatedAt = now();
  state.history.push({ at: state.updatedAt, action, stage: state.stage, ...detail });
  // Archive and active pointer contain the same data; recover from the archive after a crash.
  writeJson(inside(root, `${featureDirectory(state)}/state.json`), state);
  writeJson(inside(root, `${STATE_DIR}/state.json`), state);
  try { writeQaReport(root, state); } catch (error) {
    fail(`상태는 저장됐지만 QA.md 갱신 실패: ${error.message}. 원인을 해결한 뒤 qa-report로 다시 생성할 것`);
  }
}

/**
 * 현재 증거의 유효성을 재계산해 기능별 QA.md를 원자적으로 갱신한다.
 * @param {string} root 대상 프로젝트 루트
 * @param {object} state 저장된 기능 상태
 * @returns {string} 생성된 문서의 프로젝트 상대 경로
 */
export function writeQaReport(root, state) {
  const config = loadConfig(root);
  const relative = `${featureDirectory(state)}/QA.md`;
  const full = inside(root, relative);
  ensure(!fs.lstatSync(full, { throwIfNoEntry: false })?.isSymbolicLink(), 'QA.md 심볼릭 링크는 덮어쓸 수 없음');
  const validity = {
    plan: !config.approval.plan || approvalValid(root, state, 'plan'),
    checks: Object.fromEntries(Object.entries(state.checks).map(([name, record]) => [name, evidenceValid(root, state, record)])),
    evidence: Object.fromEntries(Object.entries(state.evidence).map(([kind, record]) => [kind, evidenceValid(root, state, record)])),
  };
  const block = renderQaReport({ state, config, validity, headSha: git(root, ['rev-parse', 'HEAD']),
    sourceFingerprint: fingerprint(root), generatedAt: now() });
  const content = mergeQaReport(fs.existsSync(full) ? fs.readFileSync(full, 'utf8') : '', block);
  const temporary = `${full}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, content, { flag: 'wx' });
  fs.renameSync(temporary, full);
  return relative;
}

export function approvalValid(root, state, gate) {
  const approval = state.approvals[gate];
  if (!approval || approval.planHash !== planHash(root, state) || approval.configHash !== configHash(root)) return false;
  if (gate === 'pr' && approval.fingerprint !== fingerprint(root)) return false;
  return fs.existsSync(inside(root, approval.file)) && sha(fs.readFileSync(inside(root, approval.file))) === approval.fileHash;
}

export function assertPlan(root, state, config) {
  ensure(!config.approval.plan || approvalValid(root, state, 'plan'), '기획서/설정에 대한 유효한 승인 기록이 없음. 실제 사용자 지시를 기록해야 함');
}

export function evidenceValid(root, state, record) {
  return Boolean(record && record.fingerprint === fingerprint(root) && record.planHash === planHash(root, state)
    && record.configHash === configHash(root)
    && (!record.summary?.headSha || record.summary.headSha === git(root, ['rev-parse', 'HEAD']))
    && record.files.every(item => {
      const full = inside(root, item.path);
      return fs.existsSync(full) && sha(fs.readFileSync(full)) === item.hash;
    }));
}

export function evidenceFile(root, state, relative) {
  const prefix = `${featureDirectory(state)}/evidence/`;
  ensure(relative?.startsWith(prefix) && path.posix.normalize(relative).startsWith(prefix) && !relative.includes('\\'), '증거는 현재 기능의 evidence/ 아래에 저장해야 함');
  const full = inside(root, relative);
  const evidenceRoot = fs.realpathSync(inside(root, prefix));
  ensure(fs.realpathSync(full).startsWith(evidenceRoot + path.sep), '다른 디렉터리로 연결된 증거를 사용할 수 없음');
  ensure(fs.statSync(full).isFile() && fs.statSync(full).size > 0, `비어 있지 않은 증거 파일 필요: ${relative}`);
  return { path: relative, hash: sha(fs.readFileSync(full)) };
}

export function validateReport(root, state, config, kind, report) {
  const extraFiles = [];
  if (kind === 'review') {
    ensure(['self', 'independent'].includes(report.method) && nonempty(report.reviewer), '리뷰 방법과 실제 리뷰어 필요');
    ensure(config.reviewMode !== 'independent' || report.method === 'independent', '독립 리뷰가 설정된 프로젝트임. 자체 리뷰로 대체할 수 없음');
    ensure(Array.isArray(report.findings), 'review.findings 배열 필요');
    for (const finding of report.findings) {
      ensure(['critical', 'high', 'medium', 'low'].includes(finding.severity) && ['open', 'fixed', 'accepted'].includes(finding.status) && nonempty(finding.detail), '리뷰 항목의 severity/status/detail 확인');
      ensure(!(['critical', 'high'].includes(finding.severity) && finding.status !== 'fixed'), 'Critical/High는 실제 수정 후에만 통과');
      ensure(finding.status !== 'open', '미해결 리뷰 항목이 있음');
      ensure(finding.status !== 'accepted' || nonempty(finding.reason), '수용한 위험의 사유 필요');
    }
    ensure(nonempty(report.scope), '실제 리뷰 범위 필요');
  } else if (kind === 'browser') {
    ensure(nonempty(report.url) && /^https?:\/\//.test(report.url) && nonempty(report.browser), '검증 URL과 브라우저/버전 필요');
    ensure(['mock', 'live', 'none'].includes(report.apiMode), 'apiMode: mock/live/none');
    ensure(!config.requireLiveApi || report.apiMode === 'live', '실제 API 연동 검증이 필수임');
    ensure(config.context.viewports.every(width => report.viewports?.includes(width)), '설정한 모든 뷰포트의 검증 필요');
    for (const name of BROWSER_CHECKS) {
      const check = report.checks?.[name];
      ensure(check && ['pass', 'na'].includes(check.status) && nonempty(check.detail), `브라우저 ${name}: 통과 결과 또는 미적용 사유 필요`);
      ensure(!(['journey', 'responsive', 'keyboard'].includes(name) && check.status === 'na'), `${name} 검증은 생략할 수 없음`);
    }
    ensure(Array.isArray(report.artifacts) && report.artifacts.length > 0, '스크린샷/trace/검사 결과 등 브라우저 증거 필요');
    for (const file of report.artifacts) extraFiles.push(evidenceFile(root, state, file));
  } else if (kind === 'coderabbit') {
    ensure(report.status === 'completed' && report.provider === 'coderabbitai', 'CodeRabbit의 실제 완료 결과 필요. skipped/rate_limited/pending은 통과하지 않음');
    ensure(report.headSha === git(root, ['rev-parse', 'HEAD']), 'CodeRabbit이 현재 HEAD를 리뷰하지 않았음');
    ensure(nonempty(state.pullRequestUrl) && report.reviewUrl?.startsWith(state.pullRequestUrl + '#'), '현재 PR의 실제 리뷰/검사 결과 링크 필요');
    ensure(Array.isArray(report.findings), 'CodeRabbit 지적과 처리 결과 findings 배열 필요');
    for (const finding of report.findings) {
      ensure(['critical', 'high', 'medium', 'low'].includes(finding.severity) && ['fixed', 'accepted'].includes(finding.status) && nonempty(finding.detail), 'CodeRabbit 미해결 지적이 있거나 severity/detail이 올바르지 않음');
      ensure(finding.status !== 'accepted' || nonempty(finding.reason), 'CodeRabbit 지적 수용 사유 필요');
      ensure(!['critical', 'high'].includes(finding.severity) || finding.status === 'fixed', 'CodeRabbit Critical/High를 먼저 수정해야 함');
    }
  } else if (kind === 'ci') {
    ensure(report.status === 'pass' && /^https:\/\//.test(report.runUrl || ''), '성공한 CI run URL 필요');
    ensure(report.headSha === git(root, ['rev-parse', 'HEAD']), 'CI가 현재 HEAD에서 실행되지 않았음');
  } else if (kind === 'merge') {
    ensure(report.merged === true && report.pullRequestUrl === state.pullRequestUrl && report.targetBranch === config.integrationBranch
      && /^[a-f0-9]{40}$/.test(report.mergeCommit || '') && nonempty(report.mergedAt), '실제 머지 결과/대상 브랜치/커밋/시각 필요');
  } else fail(`지원하지 않는 증거 종류: ${kind}`);
  return extraFiles;
}

export function assertReady(root, state, config) {
  assertPlan(root, state, config);
  for (const name of Object.keys(config.checks)) {
    const record = state.checks[name];
    ensure(record?.passed && evidenceValid(root, state, record), `현재 코드의 ${name} 검사 통과 기록이 없음`);
  }
  for (const kind of ['review', 'browser']) ensure(evidenceValid(root, state, state.evidence[kind]), `현재 코드의 ${kind} 증거가 없거나 변경됨`);
}

export function assertCleanSource(root) {
  const dirty = git(root, ['diff', 'HEAD', '--name-only', '--', '.', `:(exclude)${STATE_DIR}/**`]);
  const others = git(root, ['ls-files', '--others', '--exclude-standard']).split('\n').filter(file => file && !file.startsWith(STATE_DIR + '/'));
  ensure(!dirty && others.length === 0, 'PR/CI 기록 전에 제품 코드와 설정을 커밋해야 함');
}

export function withLock(root, callback) {
  const lock = inside(root, `${STATE_DIR}/.lock`);
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  try { fs.mkdirSync(lock); } catch (error) {
    if (error.code === 'EEXIST') fail('다른 하네스 명령이 실행 중이거나 종료되지 않은 lock이 있음. 실행 PID 확인 후 복구할 것');
    throw error;
  }
  fs.writeFileSync(path.join(lock, 'owner.json'), JSON.stringify({ pid: process.pid, at: now() }));
  try {
    const ignore = inside(root, `${STATE_DIR}/.gitignore`);
    const managed = '# frontend-workflow: private runtime files\n.lock/\n**/*.log\ninstall-*/\n';
    const existing = fs.existsSync(ignore) ? fs.readFileSync(ignore, 'utf8') : '';
    if (!existing.endsWith(managed)) fs.writeFileSync(ignore, existing + (existing && !existing.endsWith('\n') ? '\n' : '') + managed);
    return callback();
  } finally { fs.rmSync(lock, { recursive: true }); }
}
