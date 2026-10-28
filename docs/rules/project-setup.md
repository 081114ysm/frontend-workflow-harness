# 최초 설정과 스택 변경

사용할 때마다 긴 인터뷰를 반복하지 않는다. 실제 코드·문서·사용자 지시에서 알아낼 수 있는 값은 먼저 확인하고, 결정되지 않은 필수 항목만 묻는다. 이 번들은 앱의 패키지나 설정을 자동 교체하지 않는다.

## 확인 순서

1. 프로젝트 AGENTS/CLAUDE 지시, README, 개발 문서.
2. `package.json`과 실제 lockfile. `packageManager`, Node 버전, monorepo workspace·앱 경로.
3. route·rendering 방식, 상태 관리·API 클라이언트, 공통 UI·토큰, 테스트·CI 설정.
4. Git 리모트·default·통합 브랜치, 디자인과 API 원본, 배포·인증 환경.

```sh
node scripts/harness.mjs doctor
node scripts/harness.mjs init
```

생성된 `frontend-harness.config.json`은 `configured: false`인 예시다. 명령을 실제 프로젝트에 맞게 수정한 뒤에만 활성화한다.

```sh
node scripts/harness.mjs configure --from frontend-harness.config.json
```

## 확정할 값

| 값 | 판단 근거 |
|---|---|
| integrationBranch / defaultBranch | 실제 팀 전략과 리모트. 무조건 main으로 정하지 않는다 |
| branchPrefix | 기본 codex/. 기존 팀 규칙이 있으면 따른다 |
| checks | 실제 argv, 앱 기준 cwd, 제한 시간. shell 구문 대신 인자 배열 |
| notApplicable | lint/typecheck/test/build 중 미적용인 검사의 구체적인 사유 |
| reviewMode | self 또는 independent. 후자는 독립 검토 도구·사람을 실제로 사용할 때만 |
| requireLiveApi | 이번 앱에서 실제 API 연동을 PR 필수 조건으로 삼을지 |
| requireCi | CI 필수 여부. false여도 'CI 통과'라고 보고할 수는 없음 |
| github | 기본 GitHub 모드 여부와 실제 owner/repo. 로컬 전용이면 enabled: false |
| codeRabbit.required | 현재 PR head의 실제 CodeRabbit 리뷰를 완료 조건으로 삼을지 |
| approval | 기존 지시를 포함해 승인 근거를 요구할 단계 |
| context | framework, packageManager, designSource, apiSource, 지원 브라우저, viewports |

`configure`는 schema와 경로를 확인할 뿐 명령의 안전성·유효성이나 API 접근을 증명하지 않는다. 검토한 저장소의 명령만 실행한다. 명령 결과가 설정과 다르면 해당 검사부터 고친다.

기존 JS 앱에 typecheck가 없으면 `notApplicable.typecheck`에 사유를 남긴다. 낮은 영향의 문구 변경에 의미 없는 테스트를 새로 만들 필요는 없다. 기능의 위험에 맞는 기존 검사와 실제 브라우저 확인은 유지한다.

모노레포는 `cwd: "apps/web"`와 루트 패키지 매니저의 filter 인자를 실제 구조에 맞춰 사용한다. 실행하는 프로젝트와 `--root`가 같아야 한다. 설정을 바꾸면 기존 승인·검증 기록은 무효가 된다.

선택 도구는 [어댑터 목록](../adapters/README.md)에서 필요한 것만 적용한다. 안 쓰는 어댑터를 삭제하며 core 링크를 깨뜨리지 않는다.

최초 설정은 에이전트가 수행한다. GitHub 모드라면 `github.mjs check`로 대상과 default를 대조하고 `setup-github.mjs`로 템플릿·CodeRabbit 파일을 준비한다. 3단계 전략은 integrationBranch를 dev, defaultBranch를 main 등 실제 값으로 지정한다. 라벨은 기존 것을 재사용하고 필요하다고 합의한 경우에만 추가한다. 사용하지 않는 dev/staging 브랜치를 형식적으로 만들지 않는다.
