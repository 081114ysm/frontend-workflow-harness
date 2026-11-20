# Frontend Workflow Harness

프론트엔드 기능 하나를 기획하고, 승인 범위 안에서 구현한 뒤 실제 화면과 API 동작을 검증해 전달하는 하네스다. 규칙 문서·프로젝트별 어댑터·템플릿과 Node CLI를 함께 제공한다. 앱이나 UI 라이브러리는 포함하지 않는다.

## 무엇을 해결하나

- 기능 하나를 기준으로 범위·기획·구현·리뷰·QA·PR을 연결한다.
- 화면의 로딩·빈 상태·오류·인증·중복 제출·성공·복구를 계획에 포함한다.
- 실제 API 계약, 상태·캐시·요청 경합, 접근성·반응형·SSR 경계를 확인한다.
- 실행 결과·코드 지문·기획서·설정·증거 파일의 해시를 연결해 오래된 통과 기록을 거부한다.
- 설정한 브라우저 시나리오를 자동 실행하고 API 출처와 성능을 기능별 QA 문서에 남긴다.
- 실제 API·Mock·혼합·미확인, 자체·독립 리뷰, 로컬 전달·GitHub 머지 완료를 구분한다.
- 기존에 받은 사용자 승인을 재사용하되 실제 근거를 기록한다. 답이 없다는 이유로 승인됐다고 처리하지 않는다.
- GitHub 이슈 생성·진행 갱신·PR 생성·머지 후 이슈 종료를 에이전트가 수행하고, CodeRabbit의 현재 PR head 리뷰를 확인한다.

```text
plan → implement → review → qa → ready → pr → done
  승인                 QA        └→ delivered (로컬 전용)
```

PR을 만들기 전에는 로컬 검사와 브라우저 증거를 확인한다. PR에서만 도는 CI는 생성 뒤 현재 head를 기준으로 확인한다. 문서가 서로를 먼저 요구하는 교착을 피했다.

## 빠르게 적용하기

Node.js 22 이상과 Git이 필요하다. 기본 CLI는 외부 npm 패키지 없이 실행된다. 브라우저 자동화에는 대상 앱의 Playwright와 브라우저가 필요하다. GitHub 원격 작업에는 해당 저장소의 접근 도구와 사용자 지시가 추가로 필요하다.

**기능을 설명하면 에이전트가 내부 명령을 수행한다.** 사용자는 기획서와 QA 결과를 검토하고 승인한다. 아래 설치·CLI 명령은 최초 적용이나 수동 점검용이다. 전체 자연어 흐름은 [에이전트 사이클](docs/rules/agent-cycle.md)에 있다.

GitHub 모드의 준비물은 리모트가 있는 프로젝트, 인증된 GitHub connector 또는 `gh auth login`, 실제 저장소 접근 권한이다. 자동 봇 리뷰에는 해당 저장소에 연결한 CodeRabbit GitHub App이 추가로 필요하다. App 연결과 YAML 설정은 별개의 단계다.

비공개 배포 원본을 내려받으려면 [GitHub CLI를 설치](https://cli.github.com/)하고 `gh auth login`으로 저장소 접근 권한이 있는 GitHub 계정을 인증한다.

```sh
gh repo clone 081114ysm/frontend-workflow-harness
cd frontend-workflow-harness
```

내려받은 하네스 폴더에서 대상 프로젝트에 설치한다. 대상 경로는 실제 앱 경로로 바꾼다.

```sh
node scripts/install.mjs --target /path/to/frontend-app
```

Claude Code의 프로젝트 스킬 경로를 쓰려면 `--host claude`를 추가한다. 기본 host는 codex다. 마켓플레이스 배포를 한 것으로 가정하는 설치 명령은 제공하지 않는다.

대상 프로젝트의 `.agents/skills/frontend-workflow-harness/`에 번들을 만든다. 기존 설치는 명시적으로 업데이트한다. Codex의 repository skill 경로는 [공식 스킬 문서](https://learn.chatgpt.com/docs/build-skills)에 따른다.

```sh
node scripts/install.mjs --target /path/to/frontend-app --update --dry-run
node scripts/install.mjs --target /path/to/frontend-app --update
```

관리 파일을 직접 수정했거나 새 파일 이름이 기존 파일과 충돌하면 업데이트를 중단한다. 앱 설정·기능 상태·번들의 사용자 추가 파일을 보존하고, 교체 전 번들은 `.frontend-workflow/runtime/install-backup-*/bundle`에 저장한다. 업데이트 성공 출력의 백업 경로를 보관한다. 이전 번들로 복구할 때는 현재 번들을 별도 경로에 보관한 뒤 백업 폴더를 같은 설치 경로로 옮긴다. 관리 매니페스트가 없는 1.0 설치는 당시 배포 원본 경로를 `--baseline /path/to/original-harness`로 함께 지정해 일치 여부를 먼저 확인한다.

업데이트 도중 프로세스가 종료됐다면 [잠금 복구 절차](docs/rules/progress.md)에 따라 종료된 실행의 잠금을 확인한다. 이후 같은 `--update` 명령을 다시 실행하면 미완료 교체의 이전 설치본을 자동 복원한 뒤 업데이트를 이어간다.

**이후 명령은 대상 앱의 루트에서 실행한다.**

```sh
node .agents/skills/frontend-workflow-harness/scripts/harness.mjs doctor
node .agents/skills/frontend-workflow-harness/scripts/harness.mjs init
```

생성된 `frontend-harness.config.json`의 브랜치·실행 명령·원본·지원 환경을 실제 앱에 맞춰 수정하고 `configured: true`로 바꾼다. 예시의 Vitest 실행 인자나 main 브랜치를 그대로 믿지 않는다.

```sh
node .agents/skills/frontend-workflow-harness/scripts/harness.mjs configure --from frontend-harness.config.json
node .agents/skills/frontend-workflow-harness/scripts/setup-github.mjs
```

`setup-github.mjs`는 실제 통합 브랜치에 맞춘 `.coderabbit.yaml`과 GitHub 이슈·PR 템플릿을 준비하며 기존 파일을 보존한다. App 연결 절차는 [CodeRabbit 연동](docs/adapters/coderabbit.md)을 따른다. 이 단계까지 에이전트에게 맡겨도 된다.

설정은 [최초 설정](docs/rules/project-setup.md), 도구별 선택은 [어댑터 목록](docs/adapters/README.md)을 참고한다. JS 앱의 없는 typecheck 같은 항목은 구체적인 이유와 함께 `notApplicable`에 남긴다.

자동 QA를 쓰려면 앱 루트에서 `browser-init --url 실제페이지주소`로 시나리오 초안과 Playwright 준비 명령을 받는다. 첫 탐색을 확인한 뒤 실제 인수 조건과 API 출처 규칙을 채운다. 운영 성능은 지정 URL에서 별도로 반복 측정한다. [브라우저 설정](docs/adapters/browser-automation.md)

## 에이전트에게 요청하기

설치한 프로젝트에서 스킬을 선택하거나 다음처럼 요청한다.

> `$frontend-workflow-harness`로 주문 목록 검색을 구현해줘. 기존 검색 API와 디자인을 기준으로 하고, 이번 범위는 검색·빈 결과·오류 복구까지야. 먼저 기획서를 정리해줘.

스킬은 현재 지시와 설정을 읽고 필요한 문서만 불러온다. 하네스 자체를 수정하거나 단순 설명·문구 수정에 전체 사이클을 강제하지 않는다. 사용자가 이미 구체적으로 구현·PR 권한을 부여했다면 같은 질문을 반복하지 않고 근거를 기록한다.

```text
기능 설명 → 기존 코드 확인 → GitHub 이슈 생성 → 기능 브랜치와 기획서
→ 기획 승인 → 구현 → 코드 리뷰 → 자동 검사·브라우저 QA
→ QA 확인·PR 승인 → push·PR 생성 → CI·CodeRabbit 자동 리뷰 확인
→ 지적 처리와 재검증 → 머지 지시가 있을 때 머지 → 이슈 종료
```

세션을 다시 시작하면 로컬 활성 상태와 GitHub 이슈를 읽고 이어간다. 새 체크아웃에서는 해당 기능 브랜치의 보관 상태를 복구할 수 있다.

## CLI 사용

아래는 **이 번들의 CLI 위치를 기준으로 한 표**다. 설치한 앱에서는 `scripts/harness.mjs` 앞에 `.agents/skills/frontend-workflow-harness/`를 붙인다. 모든 명령에 `--root /실제/앱`을 지정할 수도 있다.

| 명령 | 동작 |
|---|---|
| `doctor` | scripts·lockfile·브랜치·리모트·번들 버전·Playwright 탐색 |
| `init` | 미설정 상태의 config 예시 생성, 기존 config 보존 |
| `configure --from 파일` | 실제 설정의 형식과 실행 경로 검사·저장 |
| `start --id 42-order-search --issue URL` | 현재 기능 브랜치에서 상태·계획·증거 틀 생성 |
| `start --id 43-order-parser --qa non-ui --reason 사유` | 허용된 프로젝트에서 실제 test 검사와 리뷰를 요구하는 비화면 QA 선택 |
| `restore --id 42-order-search` | 기능 브랜치에서 보관한 상태를 로컬 활성 상태로 복구 |
| `status --compact` | 현재 단계, 확인할 파일 경로, 승인·검사·증거의 상태만 표시. 전체 상태는 `status` |
| `qa-report` | 현재 기록과 증거 유효성으로 기능별 `QA.md` 재생성. 검증을 새로 실행하지 않음 |
| `browser-init --url 주소` | Playwright 준비 명령과 최초 탐색용 시나리오 초안 생성 |
| `approve --gate plan --by 승인자 --file 근거.md` | 실제 사용자 지시를 현재 기획서·설정에 연결 |
| `advance --to implement` | 조건을 확인하고 바로 다음 단계로 이동 |
| `run all --compact` 또는 `run test --compact` | 실제 명령과 증거 저장은 동일하게 실행하고 검사 결과와 실패 로그 경로만 표시. 상세 출력은 `--compact` 생략 |
| `browser-run --from qa/browser.json` | 설정한 브라우저 여정·API·성능 실행 및 증거 저장 |
| `record --kind review --file 보고서.json` | review·수기 browser·coderabbit 증거 연결 |
| `advance --to delivered` | GitHub를 사용하지 않는 작업의 로컬 전달 완료 |
| `replan --reason 변경이유` | 계약 변경으로 계획 복귀, 승인·검사·증거 초기화 |
| `issue-body` | 상태 기반 이슈 진행 블록 출력. 원격에 자동 업로드하지 않음 |

GitHub 작업은 `scripts/github.mjs`를 사용한다. `pr-inspect`로 실제 PR head의 체크를 읽고, `finalize`로 필수 체크와 통합 브랜치 머지를 확인한다. 새 체크아웃에서 이미 생성된 PR은 `pr-recover --url 실제PR주소`로 다시 연결한다. 이슈 생성·갱신·종료는 사용자 지시 범위에서 실행한다. 이슈 생성의 성공 여부가 불확실하면 자동 재생성을 거부한다.

기능 브랜치는 `start` 전에 만든다. 실제 통합 브랜치를 기준으로 생성하고 기존 미커밋 변경을 보존한다. 기획서와 근거 파일은 `.frontend-workflow/features/{id}/`에 생성된다. 증거 경로는 이 기능의 `evidence/` 하위여야 한다.

전체 명령 흐름은 [주문 검색 예제](examples/order-search.md), 상태 복구는 [진행 기록](docs/rules/progress.md)을 참고한다.

## QA 문서 자동 저장

기능을 시작하면 `.frontend-workflow/features/{id}/QA.md`가 미실행 상태로 생성된다. 이후 검사 실행·브라우저 결과 기록·단계 전환 등 상태가 저장될 때 같은 문서가 자동 갱신된다. 에이전트는 QA 검토를 요청할 때 이 파일을 보여준다.

- 검사별 통과·실패·미실행·재검증 여부와 실행 시각·종료 정보.
- 사용자 여정·화면 상태·반응형·키보드·콘솔·네트워크 결과.
- 브라우저·URL·뷰포트, API 출처별 관측 건수, 성능 샘플·중앙값·예산과 증거 파일 링크.
- 기록이 거부된 브라우저 보고서의 실패·차단 내용과 사유.
- 리뷰·CI·CodeRabbit 결과, 남은 검증과 현재 QA 완료 조건.

문서는 저장된 JSON과 실제 검사 결과에서 생성한다. 자동 관리 영역 밖의 수동 메모는 보존한다. 자동 실행과 에이전트가 작성한 수기 브라우저 보고서를 구분하고, 실행 전에는 미실행으로 표시한다. 원시 stdout/stderr는 복사하지 않는다.

파일을 직접 수정한 직후에는 이전 문서가 스냅샷으로 남아 있을 수 있다. `qa-report`로 현재 코드·기획·설정·증거를 다시 대조하면 오래된 결과를 **재검증 필요**로 표시한다. 이 명령만으로 실패가 통과로 바뀌지는 않는다. `status`는 계속 읽기 전용으로 동작한다.

## 구조와 읽는 순서

```text
SKILL.md                    짧은 에이전트 진입점
AGENTS.md / CLAUDE.md        이 배포 원본을 수정할 때의 지시
docs/rules/                 워크플로우·프론트 계약·리뷰·검증·GitHub·복구
docs/adapters/              스택·디자인·API/Mock·브라우저·선택 서비스
docs/templates/             계획·이슈·PR·검증 JSON
config/                     프로젝트 설정과 도구 설정
scripts/                    CLI·설치·저장소 검증·선택형 브라우저 실행
tests/                      임시 Git 저장소와 로컬 Chromium 검증
examples/                   실제 적용 절차와 인수 조건 예시
.github/                    이 하네스 자체의 CI·이슈·PR 템플릿
.coderabbit.yaml            이 저장소의 자동 리뷰 설정
```

기능 개발 중에는 [스킬의 단계별 안내](SKILL.md)를 따라 현재 판단에 필요한 문서와 코드만 읽는다.

## 검증과 한계

이 저장소 자체의 검증은 다음 한 명령으로 실행한다. 외부 계정·서버·유료 API를 호출하지 않는다.

```sh
npm run verify
```

검증은 문서 링크·구문, 승인·상태 복구·증거 무효화·실패 경로·설치 업데이트와 GitHub 합성 응답을 다룬다. `npm run test:browser`는 기본 Chromium으로 로컬 앱과 API를 실제 실행한다. 환경변수 `HARNESS_TEST_BROWSER`로 Firefox·WebKit을 선택할 수 있다. [검증 기록](docs/VERIFICATION.md)

CLI는 기록과 게이트를 검증한다. 승인·수기 리뷰의 진위와 시나리오의 충분성은 사용자가 검토한다. API 출처 근거가 빠지면 미확인으로 기록한다. Git ignore 파일·외부 서비스·환경변수가 바뀌면 다시 검증한다.

로컬 모드의 완료는 `delivered`다. GitHub 모드의 `done`은 설정된 필수 체크와 실제 통합 브랜치 머지를 GitHub에서 확인한 상태다. 머지·배포는 별도 지시 범위를 따른다.

[MIT License](LICENSE)
