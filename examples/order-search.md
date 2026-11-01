# 주문 목록 검색: 적용 예제

아래는 사용 방법을 설명하는 가상 기능이다. 실제 서비스 구현·사용자 승인·브라우저 검증·GitHub 작업을 수행한 기록이 아니다. endpoint와 fixture는 실제 프로젝트 계약으로 바꿔야 한다.

## 기능 범위

사용자가 주문 번호나 주문자 이름으로 검색하고 결과 또는 빈 결과·오류 복구를 확인한다. 정렬 변경·주문 취소·내보내기는 제외한다.

| 인수 조건 | 사전 조건과 행동 | 기대 결과 |
|---|---|---|
| AC-01 | 검색어 입력 후 제출 | URL의 검색 조건과 첫 페이지 결과가 일치 |
| AC-02 | 결과 없는 검색어 | '검색 결과가 없습니다'와 검색 조건 변경 동작 |
| AC-03 | A 검색 뒤 즉시 B 검색, A 응답이 늦음 | B의 결과가 유지 |
| AC-04 | 서버 오류 뒤 다시 시도 | 입력을 보존하고 재요청, 성공 시 결과 표시 |
| AC-05 | 로그인 만료 | 기존 인증 계약에 따라 복구, 다른 계정 cache 표시 안 함 |
| AC-06 | 키보드와 IME 조합 입력 | 조합 중 Enter가 조기 제출되지 않고 초점이 유지 |

## 명령 흐름

번들 안의 CLI를 `H`라는 셸 함수로 감싼 예시다. 실제 프로젝트 루트에서 실행한다. main은 실제 통합 브랜치로 바꾼다.

```sh
H() { node .agents/skills/frontend-workflow-harness/scripts/harness.mjs "$@"; }
git switch -c codex/42-order-search main
H start --id 42-order-search --issue https://github.com/OWNER/REPO/issues/42
```

생성된 `.frontend-workflow/features/42-order-search/plan.md`를 원본·기존 코드·인수 조건·상태·API·검증 계획으로 채운다. 사용자의 실제 지시 원문과 출처를 `evidence/plan-authorization.md`에 저장한다. 승인되지 않았다면 다음 명령을 실행하지 않는다.

```sh
H approve --gate plan --by 실제승인자 --file .frontend-workflow/features/42-order-search/evidence/plan-authorization.md
H advance --to implement
```

구현하고 필요한 회귀 테스트를 추가한 뒤 검사한다. 예시 테스트 fixture를 실제 증거로 복사하지 않는다.

```sh
H run all
H advance --to review
```

실제 diff를 검토해 `evidence/review.json`에 결과를 쓴다. High 이상의 문제를 수정했다면 바뀐 코드에 대해 다시 리뷰·검사한다.

```sh
H record --kind review --file .frontend-workflow/features/42-order-search/evidence/review.json
H advance --to qa
```

실제 브라우저에서 인수 조건과 지원 viewport·키보드·console·network를 확인한다. 스크린샷·trace·결과 파일을 evidence에 저장하고 `browser.json`에 연결한다. Mock이면 apiMode를 mock으로 쓴다. API가 준비되지 않았다면 실제 연동 완료라고 쓰지 않는다.

```sh
H run all
H record --kind browser --file .frontend-workflow/features/42-order-search/evidence/browser.json
H qa-report
H advance --to ready
```

검사 실행·기록과 단계 변경에 따라 `.frontend-workflow/features/42-order-search/QA.md`가 자동 저장된다. 에이전트는 QA 보고 직전에 `H qa-report`로 증거의 최신성을 다시 확인하고 이 문서를 사용자에게 보여준다. 실행하지 않은 항목은 미실행으로 남기며, 자동 관리 영역 밖의 수동 메모는 유지한다.

실제 PR 생성 지시를 `evidence/pr-authorization.md`로 기록한다. 제품 코드와 설정을 커밋하고 권한 범위에서 실제 PR을 생성한 뒤 반환된 URL을 사용한다. 아래 URL은 형식 예시다.

```sh
H approve --gate pr --by 실제승인자 --file .frontend-workflow/features/42-order-search/evidence/pr-authorization.md
git add .
git commit -m 'feat(order): 주문 검색과 오류 복구 추가'
H advance --to pr --url https://github.com/OWNER/REPO/pull/99
```

현재 PR head의 CI 결과를 확인해 ci.json을 작성한다. 머지 지시와 실제 merge 결과가 있는 경우에만 merge.json을 채운다. 하네스가 PR이나 merge를 대신 실행하지 않는다.

```sh
H record --kind ci --file .frontend-workflow/features/42-order-search/evidence/ci.json
H record --kind merge --file .frontend-workflow/features/42-order-search/evidence/merge.json
H advance --to done
H issue-body
```

PR 전달까지만 요청된 작업은 pr 단계에 그대로 남긴다. 세션이 바뀌면 `H status`와 실제 Git·PR 상태를 읽고 이어간다. 승인된 검색 계약이 바뀌면 `H replan --reason '검색 URL 계약 변경'`으로 재검토한다.
