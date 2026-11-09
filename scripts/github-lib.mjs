import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import {
  ensure, inside, loadConfig, loadState, saveState, writeJson, readJson, progressBlock,
  git, assertReady, assertCleanSource, approvalValid, featureDirectory, sha, withLock,
  activeState, terminal, evidenceValid, evidenceFile, fingerprint, planHash, configHash, now, requiredGithubChecks,
} from './lib.mjs';
export { progressBlock } from './lib.mjs';

export function gh(root, args) {
  const result = spawnSync('gh', args, { cwd: root, encoding: 'utf8', shell: false,
    timeout: 120000, maxBuffer: 20 * 1024 * 1024,
    env: { ...process.env, GH_PROMPT_DISABLED: '1', GIT_TERMINAL_PROMPT: '0' } });
  ensure(result.status === 0 && !result.error, `GitHub 명령 실패: ${result.stderr || result.error?.message || '응답 없음'}`);
  return result.stdout.trim();
}

export function mergeProgress(body, block) {
  const begin = '<!-- frontend-workflow:begin -->'; const end = '<!-- frontend-workflow:end -->';
  const starts = body.split(begin).length - 1; const ends = body.split(end).length - 1;
  ensure(starts === ends && starts <= 1, '이슈 진행 블록이 깨졌거나 중복됨. 원문을 확인해야 함');
  if (starts === 0) return body.trimEnd() + '\n\n' + block + '\n';
  const first = body.indexOf(begin); const last = body.indexOf(end);
  ensure(first < last, '이슈 진행 블록 순서가 올바르지 않음');
  return body.slice(0, first) + block + body.slice(last + end.length);
}

function target(config) {
  ensure(config.github?.enabled, 'github.enabled가 활성화된 실제 저장소 설정 필요');
  return config.github.repository;
}
function numberFromUrl(url, repository, kind) {
  const escaped = repository.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`^https://github\\.com/${escaped}/${kind}/([1-9]\\d*)$`).exec(url || '');
  ensure(match, `설정된 ${repository}의 ${kind} URL 필요`); return match[1];
}
function bodyFile(root, relative) {
  const full = inside(root, relative);
  const body = fs.readFileSync(full, 'utf8');
  ensure(body.trim() && !/^---\r?\n/.test(body), '실제 본문 파일 필요. CLI 본문에는 YAML frontmatter를 포함하지 않을 것');
  return full;
}

const PR_FIELDS = 'url,state,headRefOid,headRefName,baseRefName,mergedAt,mergeCommit,reviews,statusCheckRollup';
const latestCheck = (checks, head, name, app) => checks
  .filter(check => check.head_sha === head && check.name === name && check.app?.slug === app)
  .sort((a, b) => b.id - a.id)[0];
const succeeded = check => check?.status === 'completed' && check?.conclusion === 'success';
const reviewed = check => succeeded(check) && check.output?.title === 'Finished';
/** 지정한 커밋의 모든 체크 페이지를 가져온다. 재실행 결과도 현재 판정에 필요하다. */
function checkRuns(json, repo, head) {
  const pages = json(['api', `repos/${repo}/commits/${head}/check-runs?filter=all&per_page=100`, '--paginate', '--slurp']);
  ensure(Array.isArray(pages) && pages.every(page => Array.isArray(page?.check_runs)), 'GitHub check runs 응답 형식 오류');
  return pages.flatMap(page => page.check_runs);
}

/** 실제 PR head의 체크와 통합 브랜치 이력을 확인한 뒤 완료 증거를 저장한다. */
function finishRemote(root, state, config, repo, pr, json) {
  ensure(state.stage === 'pr', 'PR 단계에서만 원격 완료를 확인할 수 있음');
  assertReady(root, state, config); assertCleanSource(root);
  const head = git(root, ['rev-parse', 'HEAD']);
  ensure(pr.url === state.pullRequestUrl && pr.headRefName === state.branch && pr.headRefOid === head, 'PR 주소/브랜치/head가 현재 작업과 다름');
  const mergeCommit = pr.mergeCommit?.oid;
  ensure(pr.state === 'MERGED' && Number.isFinite(Date.parse(pr.mergedAt)) && /^[a-f0-9]{40}$/.test(mergeCommit || ''), 'GitHub에서 실제 머지가 확인되지 않음');
  const required = requiredGithubChecks(config);
  const checks = required.length || config.codeRabbit?.required ? checkRuns(json, repo, head) : [];
  const passed = required.map(({ name, app }) => {
    const check = latestCheck(checks, head, name, app);
    ensure(succeeded(check), `현재 PR head의 필수 검사 미통과: ${app}/${name}`);
    return { name, app, id: check.id, url: check.details_url, conclusion: check.conclusion };
  });
  if (config.codeRabbit?.required) {
    ensure(reviewed(latestCheck(checks, head, 'CodeRabbit', 'coderabbitai')), '현재 PR head의 실제 CodeRabbit 리뷰 미완료');
    ensure(evidenceValid(root, state, state.evidence.coderabbit), '현재 코드의 CodeRabbit 지적 처리 기록 필요');
  }
  const targetRef = config.integrationBranch.split('/').map(encodeURIComponent).join('/');
  const targetTip = json(['api', `repos/${repo}/git/ref/heads/${targetRef}`]).object?.sha;
  ensure(/^[a-f0-9]{40}$/.test(targetTip || ''), '원격 통합 브랜치 커밋 확인 실패');
  if (targetTip !== mergeCommit) {
    const comparison = json(['api', `repos/${repo}/compare/${mergeCommit}...${targetTip}`]);
    ensure(comparison.status === 'ahead' && comparison.merge_base_commit?.sha === mergeCommit, '머지 커밋이 현재 원격 통합 브랜치 이력에 없음');
  }
  ensure(git(root, ['rev-parse', 'HEAD']) === head && git(root, ['branch', '--show-current']) === state.branch, '원격 확인 중 브랜치 또는 HEAD 변경');
  assertReady(root, state, loadConfig(root)); assertCleanSource(root);
  const merge = { merged: true, pullRequestUrl: pr.url, targetBranch: pr.baseRefName, mergeCommit, mergedAt: pr.mergedAt, headSha: head, targetTip };
  const ci = passed.length ? { status: 'pass', headSha: head, checks: passed } : null;
  const relative = `${featureDirectory(state)}/evidence/github-completion.json`;
  writeJson(inside(root, relative), { source: 'github-api', merge, ci, observedAt: now() });
  const common = { at: now(), fingerprint: fingerprint(root), planHash: planHash(root, state), configHash: configHash(root), files: [evidenceFile(root, state, relative)], remote: true };
  state.evidence.merge = { ...common, summary: merge };
  if (ci) state.evidence.ci = { ...common, summary: ci };
  else delete state.evidence.ci;
  state.stage = 'done';
  saveState(root, state, 'github-finalize');
  return { stage: 'done', merge, ci, evidence: relative };
}

/** 현재 프로젝트의 GitHub 명령을 실행한다. 전송 함수 주입으로 원격 없이 실패 경로를 검증한다. */
export function githubWorkflow(root, command, options = {}, call = args => gh(root, args)) {
  const config = loadConfig(root); const repo = target(config);
  const invoke = args => call(args);
  const json = args => JSON.parse(invoke(args));
  if (command === 'check') {
    const info = json(['repo', 'view', repo, '--json', 'nameWithOwner,defaultBranchRef,viewerPermission,url']);
    ensure(info.nameWithOwner.toLowerCase() === repo.toLowerCase(), 'GitHub 저장소 응답 불일치');
    ensure(info.defaultBranchRef?.name === config.defaultBranch, '설정과 실제 default 브랜치가 다름');
    return info;
  }
  return withLock(root, () => {
    if (command === 'issue-create') {
      ensure(/^[a-z0-9][a-z0-9-]{0,79}$/.test(options.key || '') && options.title?.trim(), '--key 고유요청ID와 --title 필요');
      const active = activeState(root, config);
      ensure(!active || terminal(active), '활성 기능이 있음. 새 기능 이슈의 자동 착수는 보류');
      const journalFile = inside(root, `.frontend-workflow/requests/${options.key}.json`);
      const previous = fs.existsSync(journalFile) ? readJson(journalFile) : null;
      ensure(!previous || previous.repository === repo, '요청 기록과 대상 저장소가 다름');
      if (previous?.url && !options.existing) return { url: previous.url, reused: true };
      if (options.existing) {
        numberFromUrl(options.existing, repo, 'issues');
        const issue = json(['issue', 'view', options.existing, '--repo', repo, '--json', 'url,state']);
        ensure(issue.state === 'OPEN', '연결하려는 이슈가 열려 있지 않음');
        writeJson(journalFile, { repository: repo, status: 'created', url: issue.url });
        return { url: issue.url, reused: true };
      }
      ensure(!previous, '이전 이슈 생성의 성공 여부가 불확실함. 원격을 확인한 뒤 --existing URL로 연결할 것');
      const full = bodyFile(root, options['body-file']);
      writeJson(journalFile, { repository: repo, status: 'uncertain', title: options.title });
      const url = invoke(['issue', 'create', '--repo', repo, '--title', options.title, '--body-file', full]);
      numberFromUrl(url, repo, 'issues');
      writeJson(journalFile, { repository: repo, status: 'created', url });
      return { url, created: true };
    }
    const state = loadState(root);
    ensure(git(root, ['branch', '--show-current']) === state.branch, '현재 작업 브랜치와 기능 기록이 다름');
    if (command === 'issue-sync' || command === 'resume') {
      numberFromUrl(state.issue, repo, 'issues');
      const issue = json(['issue', 'view', state.issue, '--repo', repo, '--json', 'url,body,state,updatedAt']);
      const block = issue.body.match(/<!-- frontend-workflow:begin -->[\s\S]*?<!-- frontend-workflow:end -->/)?.[0] || '';
      if (command === 'resume') return { issue, localStage: state.stage, localPlan: state.plan,
        synced: sha(block) === state.remoteProgressHash,
        note: '원격 이슈와 로컬 증거를 대조할 것. 체크박스만으로 승인·검증을 복원하지 않음.' };
      ensure(!state.remoteProgressHash || state.remoteProgressHash === sha(block), '원격 진행 블록이 다른 곳에서 변경됨. resume으로 대조한 뒤 정리할 것');
      const body = mergeProgress(issue.body, progressBlock(state));
      const fresh = json(['issue', 'view', state.issue, '--repo', repo, '--json', 'body,updatedAt']);
      ensure(fresh.body === issue.body && fresh.updatedAt === issue.updatedAt, '이슈가 동시에 변경됨. 다시 읽어야 함');
      const file = inside(root, `${featureDirectory(state)}/evidence/issue-body.md`);
      fs.writeFileSync(file, body);
      invoke(['issue', 'edit', state.issue, '--repo', repo, '--body-file', file]);
      const verified = json(['issue', 'view', state.issue, '--repo', repo, '--json', 'body']);
      ensure(verified.body === body, '원격 이슈 갱신 결과가 다름. 수동 확인 필요');
      state.remoteProgressHash = sha(progressBlock(state));
      saveState(root, state, 'issue-sync'); return { synced: true, issue: state.issue };
    }
    if (command === 'pr-create') {
      requiredGithubChecks(config);
      if (state.stage === 'pr' && state.pullRequestUrl) return { url: state.pullRequestUrl, reused: true };
      ensure(state.stage === 'ready', 'ready 단계에서만 PR을 생성할 수 있음');
      assertReady(root, state, config); assertCleanSource(root);
      ensure(!config.approval.pr || approvalValid(root, state, 'pr'), 'PR 생성 승인 필요');
      ensure(options.title?.trim(), '--title 필요');
      const full = bodyFile(root, options['body-file']);
      const existing = json(['pr', 'list', '--repo', repo, '--head', state.branch, '--state', 'open', '--json', 'url,baseRefName']);
      ensure(existing.length <= 1, '같은 head의 여러 PR이 있음. 대상을 명확히 해야 함');
      ensure(!existing.length || existing[0].baseRefName === config.integrationBranch, '기존 PR의 대상 브랜치가 다름');
      const url = existing[0]?.url || invoke(['pr', 'create', '--repo', repo, '--head', state.branch, '--base', config.integrationBranch, '--title', options.title, '--body-file', full]);
      numberFromUrl(url, repo, 'pull');
      const actual = json(['pr', 'view', url, '--repo', repo, '--json', 'url,headRefOid,headRefName,baseRefName']);
      ensure(actual.headRefName === state.branch && actual.baseRefName === config.integrationBranch
        && actual.headRefOid === git(root, ['rev-parse', 'HEAD']), '실제 PR head/base가 현재 작업과 다름. push와 원격을 확인할 것');
      state.stage = 'pr'; state.pullRequestUrl = url;
      saveState(root, state, 'pr-create'); return { url, reused: existing.length > 0 };
    }
    if (command === 'pr-recover') {
      requiredGithubChecks(config);
      ensure(state.stage === 'ready', 'ready 스냅샷에서만 PR 연결 복구 가능');
      assertReady(root, state, config); assertCleanSource(root);
      ensure(!config.approval.pr || approvalValid(root, state, 'pr'), 'PR 생성 승인 기록 필요');
      numberFromUrl(options.url, repo, 'pull');
      const pr = json(['pr', 'view', options.url, '--repo', repo, '--json', PR_FIELDS]);
      ensure(pr.url === options.url && ['OPEN', 'MERGED'].includes(pr.state) && pr.baseRefName === config.integrationBranch
        && pr.headRefName === state.branch && pr.headRefOid === git(root, ['rev-parse', 'HEAD']), '실제 PR과 현재 기능 브랜치·커밋이 일치하지 않음');
      state.stage = 'pr'; state.pullRequestUrl = pr.url;
      saveState(root, state, 'pr-recover');
      return { url: pr.url, stage: 'pr' };
    }
    if (['pr-inspect', 'finalize', 'issue-close'].includes(command)) {
      numberFromUrl(state.pullRequestUrl, repo, 'pull');
      const pr = json(['pr', 'view', state.pullRequestUrl, '--repo', repo, '--json', PR_FIELDS]);
      ensure(pr.baseRefName === config.integrationBranch, '실제 PR의 통합 대상이 다름');
      if (command === 'finalize') return finishRemote(root, state, config, repo, pr, json);
      if (command === 'pr-inspect') {
        ensure(pr.headRefOid === git(root, ['rev-parse', 'HEAD']), '로컬과 실제 PR head가 다름');
        const checks = checkRuns(json, repo, pr.headRefOid);
        const codeRabbit = latestCheck(checks, pr.headRefOid, 'CodeRabbit', 'coderabbitai');
        const result = { ...pr, codeRabbit: codeRabbit || null,
          actualCodeRabbitReviewCompleted: reviewed(codeRabbit),
          note: '완료 상태와 별개로 실제 리뷰 지적·스레드를 읽고 처리해야 함. legacy status는 직접 확인.' };
        writeJson(inside(root, `${featureDirectory(state)}/evidence/github-pr.json`), result);
        return result;
      }
      ensure(state.stage === 'done' && pr.state === 'MERGED' && pr.mergedAt && pr.mergeCommit?.oid, 'done 단계와 실제 PR 머지가 확인돼야 이슈를 닫을 수 있음');
      numberFromUrl(state.issue, repo, 'issues');
      const issue = json(['issue', 'view', state.issue, '--repo', repo, '--json', 'state']);
      if (issue.state !== 'CLOSED') invoke(['issue', 'close', state.issue, '--repo', repo, '--reason', 'completed']);
      const actual = json(['issue', 'view', state.issue, '--repo', repo, '--json', 'state']);
      ensure(actual.state === 'CLOSED', '원격 이슈 종료 확인 실패');
      saveState(root, state, 'issue-close'); return { closed: true };
    }
    ensure(false, `알 수 없는 GitHub 명령: ${command}`);
  });
}
