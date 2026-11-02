const BEGIN = '<!-- frontend-workflow:qa:begin -->';
const END = '<!-- frontend-workflow:qa:end -->';
const LABELS = {
  journey: '사용자 여정', states: '화면 상태·오류 복구', responsive: '반응형',
  keyboard: '키보드·초점', console: '콘솔', network: '네트워크',
};
const STATUSES = { pass: '통과', fail: '실패', blocked: '차단', na: '해당 없음' };

// Escape report data so a detail cannot add Markdown columns, HTML or remote images.
const text = value => String(value ?? '—').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/\\/g, '\\\\').replace(/([`*_[\]~|])/g, '\\$1').replace(/\r\n|\r|\n/g, '<br>');
const row = cells => '| ' + cells.map(text).join(' | ') + ' |';
const result = (record, valid) => !record ? '미실행' : !valid ? '재검증 필요' : record.passed === false ? '실패' : '통과';
const link = relative => `[${text(relative)}](${relative.split('/').map(segment => encodeURIComponent(segment)
  .replace(/[!'()*]/g, character => '%' + character.charCodeAt(0).toString(16).toUpperCase())).join('/')})`;

/**
 * 저장된 검증 사실과 현재 유효성으로 사람이 읽을 QA 문서를 만든다.
 * 검증 실행·승인·게이트 판정은 변경하지 않는다.
 * @param {object} input 현재 상태, 설정, 증거 유효성 및 생성 시각
 * @returns {string} 자동 관리 마커를 포함한 Markdown 블록
 */
export function renderQaReport({ state, config, validity, headSha, sourceFingerprint, generatedAt }) {
  const rejected = state.qaFailures?.browser;
  const browserRecord = rejected || state.evidence.browser;
  const browser = browserRecord?.summary;
  const ready = validity.plan && Object.keys(config.checks).every(name => state.checks[name]?.passed && validity.checks[name])
    && validity.evidence.review && validity.evidence.browser && !rejected;
  const lines = [BEGIN, `# ${text(state.id)} QA`, '',
    '> 자동 생성 영역이다. 수동 메모는 이 영역 아래에 쓴다. 이 문서는 생성 시점의 스냅샷이며, 코드·기획·설정·증거 변경 뒤에는 `qa-report`로 갱신하고 필요한 검증을 다시 실행한다.', '',
    `- 생성 시각: ${text(generatedAt)}`, `- 현재 단계: ${text(state.stage)}`,
    `- 브랜치: ${text(state.branch)}`, `- 생성 시 HEAD: ${text(headSha)}`,
    `- 코드 지문: ${text(sourceFingerprint)}`, `- 기획서: ${link('plan.md')}`,
    `- 이슈: ${text(state.issue || '미연결')}`, `- PR: ${text(state.pullRequestUrl || '미생성')}`,
    `- QA 완료 조건: **${ready ? '충족' : '미충족'}** (현재 기획 승인·자동 검사·리뷰·브라우저 증거 기준)`, '',
    '## 자동 검사', '', '| 검사 | 결과 | 실행 시각 | 명령·종료 정보 |', '|---|---|---|---|'];
  for (const [name, command] of Object.entries(config.checks)) {
    const record = state.checks[name];
    const detail = record ? `${command.argv.join(' ')} / 종료 코드: ${record.exitCode ?? '없음'}${record.signal ? ` / signal: ${record.signal}` : ''}${record.error ? ` / ${record.error}` : ''}${record.sourceChanged ? ' / 실행 중 코드 변경' : ''}` : command.argv.join(' ');
    lines.push(row([name, result(record, validity.checks[name]), record?.at, detail]));
  }
  for (const [name, reason] of Object.entries(config.notApplicable || {})) lines.push(row([name, '해당 없음', '—', reason]));
  lines.push('', '## 브라우저 QA', '',
    `- 기록 상태: ${rejected ? '기록 거부 — 통과 증거로 사용하지 않음' : result(browserRecord, validity.evidence.browser)}`,
    `- 기록 시각: ${text(browserRecord?.at || '미실행')}`,
    `- URL: ${text(browser?.url || '미기록')}`, `- 브라우저: ${text(browser?.browser || '미기록')}`,
    `- API 모드: ${text(browser?.apiMode || '미기록')}`,
    `- 보고된 뷰포트: ${text(Array.isArray(browser?.viewports) ? browser.viewports.join(', ') : '미기록')}`,
    `- 필요한 뷰포트: ${text(config.context.viewports.join(', '))}`);
  if (rejected) lines.push(`- 거부 이유: ${text(rejected.error)}`);
  lines.push('', '| 영역 | 보고된 결과 | 실제 결과·미적용 사유 |', '|---|---|---|');
  for (const [name, label] of Object.entries(LABELS)) {
    const check = browser?.checks?.[name];
    lines.push(row([label, check ? STATUSES[check.status] || '형식 오류' : '미실행', check?.detail || '아직 기록하지 않음']));
  }
  lines.push('', '## 증거 파일', '');
  const records = [...Object.values(state.checks), ...Object.values(state.evidence), ...(rejected ? [rejected] : [])];
  const files = [...new Set(records.flatMap(record => record.files.map(file => file.path)))];
  for (const file of files) lines.push(`- ${link(file.slice(`.frontend-workflow/features/${state.id}/`.length))}`);
  if (!files.length) lines.push('- 아직 연결된 검증 증거가 없음. 시작 시 복사한 JSON 예시는 실행 결과가 아님.');
  lines.push('', '## 리뷰·후속 검증', '', '| 항목 | 결과 | 기록 시각 |', '|---|---|---|');
  for (const [kind, label] of [['review', '코드 리뷰'], ['ci', 'PR CI'], ['coderabbit', 'CodeRabbit'], ['merge', '머지']]) {
    const record = state.evidence[kind];
    lines.push(row([label, result(record, validity.evidence[kind]), record?.at]));
  }
  lines.push('', '## 미검증·주의 사항', '');
  if (!validity.plan) lines.push('- 현재 기획·설정에 대한 유효한 승인 기록이 없음.');
  if (!ready) lines.push('- QA 완료 조건이 충족되지 않았다. 위 미실행·실패·차단·재검증 항목을 해결해야 한다.');
  if (browser?.apiMode === 'mock') lines.push('- Mock으로 확인한 결과다. 실제 서버·쿠키·CORS·인증 연동은 별도 검증이 필요하다.');
  if (rejected) lines.push('- 거부된 보고서의 내용은 실패·차단 기록으로만 남긴다. 성공한 브라우저 증거를 다시 기록해야 한다.');
  lines.push('- 브라우저 결과는 실제 조작 후 기록해야 한다. 이 문서의 자동 생성이 브라우저 검증 실행을 뜻하지 않는다.',
    '- 원시 stdout/stderr·쿠키·토큰은 이 문서에 복사하지 않는다. 공유할 화면과 보고서의 민감정보를 확인한다.', '', END);
  return lines.join('\n');
}

/**
 * 자동 영역만 교체하고 기존 수동 메모를 보존한다.
 * @param {string} existing 기존 QA 문서
 * @param {string} block 새 자동 관리 블록
 * @returns {string} 병합된 QA 문서
 */
export function mergeQaReport(existing, block) {
  const starts = existing.split(BEGIN).length - 1; const ends = existing.split(END).length - 1;
  if (starts !== ends || starts > 1 || (starts && existing.indexOf(BEGIN) >= existing.indexOf(END))) {
    throw new Error('QA.md 자동 영역 마커가 깨졌거나 중복됨. 수동 내용을 보존하고 마커를 복구할 것');
  }
  if (!starts) return (existing ? existing + (existing.endsWith('\n') ? '\n' : '\n\n') : '') + block + '\n\n' + (existing ? '' : '## 수동 메모\n\n');
  return existing.slice(0, existing.indexOf(BEGIN)) + block + existing.slice(existing.indexOf(END) + END.length);
}
