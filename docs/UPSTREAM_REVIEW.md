# 원본 전체 검토와 프론트엔드 변환

2026-10-28에 [원본](https://github.com/4n5rud/focus-one-feature-backend/tree/37426ee2d9935347b4a5f2b6bd1678e1a6e5a0e7)의 recursive tree를 확인하고 텍스트 29개를 모두 읽었다. `docs/` 22개, README 2개, 진입점 2개, plugin 설정 2개, LICENSE 1개다. tree 응답의 truncated는 false였다. [파일별 blob SHA](../config/upstream-source.json)에 읽은 버전을 고정했다.

## 핵심 판단

기능 단위 범위 통제, core/adapter 분리, 승인 기획서, 외부화된 상태, 설계 변경과 내부 구현의 구분을 유지했다. 문서만으로 강제한다고 표현하는 대신 로컬 CLI로 확인 가능한 게이트를 구현하고 확인 불가능한 진위는 한계로 밝혔다.

| 원본 | 확인한 내용 | 프론트엔드 반영 |
|---|---|---|
| README.md / README.en.md | 설치, core/adapter, 0~15단계, 한 번에 하나 | 설치·복구·명령을 실제 배포 파일과 맞춤 |
| CLAUDE.md / SKILL.md | 짧은 규칙 진입점 | Codex/다른 에이전트가 읽는 짧은 SKILL과 원본 유지보수 지시 분리 |
| docs/rules/branch-workflow.md | 기획·승인·브랜치·구현·리뷰·QA·PR | 7개 상태와 검증 가능한 단계 조건. 기능 브랜치를 기획 전에 생성 |
| docs/rules/progress-tracking.md | 단일 활성 기능과 이슈 체크리스트 | 로컬 state를 단일 기준으로 두고 이슈를 projection으로 사용 |
| docs/rules/project-setup.md | 최초 스택 인터뷰와 예시 교체 | 문서·코드에서 먼저 탐색하고 없는 필수 결정만 질문 |
| docs/rules/api-design.md | 계약·오류·일관성·성능·호환성 | API 소비 계약·nullable·응답 경합·캐시·실제 연동 검증. 본문 복제 안 함 |
| docs/rules/code-review-isolation.md | 별도 에이전트의 컨텍스트 격리 | 도구 가용성과 권한을 확인. 자체/독립을 실제 수행 기준으로 구분 |
| docs/rules/code-review-template.md | 심각도·재현·위치·대안 | 구조화된 findings와 미해결 High 차단. 형식적 대안 개수 강제 제거 |
| docs/rules/commit-convention.md | 작은 task 커밋과 conventional 형태 | 실제 팀 규칙 우선, 리뷰 가능한 작업 단위 |
| docs/rules/issue-template.md | 라벨·frontmatter·body-file | 기존 라벨 보존, 실제 단계 블록 포함, 자동 원격 쓰기 제거 |
| docs/rules/pr-template.md | 사용자 확인·로컬/CI·이슈 종료 | PR 전 로컬 검증, 생성 뒤 현재 head CI, 생성/머지/배포 권한 분리 |
| docs/rules/sentence-refinement.md | 문장·주석 지침과 별도 CC 고지 | 라이선스 구분 확인. 본문·예제·표 복제 안 함 |
| docs/adapters/branch-strategy.md | 통합/default 분리, 보호와 종료 시점 | 실제 브랜치 config, 보호 브랜치에서 start 거부 |
| docs/adapters/code-style.md | 도구별 실행 명령·기존 구조 | 프레임워크별 기존 코드와 인자 배열 명령 |
| docs/adapters/test-convention.md | 실패 케이스와 실행 명령 | 단위·컴포넌트·E2E·실제 브라우저 역할 분리 |
| docs/adapters/migration-convention.md | DB 버전·충돌 | 서버 DB 정책은 프론트 core에서 제외. persistence 변경은 프로젝트별 결정 |
| docs/adapters/external-doc-sync.md | 확정 명세는 머지 후 동기화 | 머지 후, 실제 사용자 지시 범위에서만 |
| docs/adapters/api-client-collection.md | QA 요청 재사용·secret 분리 | API/Mock 어댑터와 실제 연동 증거 |
| docs/adapters/review-bot.md | 독립 리뷰를 보완하는 봇 | 선택 서비스. 봇 도입·계정 연결 자동화 없음 |
| docs/templates/issue-feature.md | 배경·범위·완료 조건 | 화면·API 원본·인수 조건·실제 진행 블록 포함 |
| docs/templates/issue-bug.md | 재현·예상/실제·증거 | 브라우저·viewport·인증·회귀 조건 포함 |
| docs/templates/pull-request.md | 관련 이슈·작업·확인 | 실행 증거·API 모드·미검증·롤백 포함 |
| docs/assets/README.md | 아직 없는 media를 가리키는 설치 안내 | 없는 screenshot/demo 링크를 배포 README에 싣지 않음 |
| docs/skills/README.md | 향후 확장 placeholder | 빈 확장 폴더 대신 실제 재사용 스킬 제공 |
| .claude-plugin/plugin.json / marketplace.json | Claude marketplace용 metadata | 검증하지 않은 marketplace 배포를 주장하지 않고 로컬 설치 제공 |
| LICENSE | 원본 MIT 고지 | 원본 고지 보존, 별도 라이선스 문서는 복제 제외 |

## 바로 복사하지 않은 이유

- README는 0~15 체크리스트를 설명하지만 원본 이슈 템플릿에는 그 블록이 없다. 이번 템플릿은 실제 상태 이름을 담는다.
- 원본은 기획서를 브랜치보다 먼저 만들면서 통합 브랜치 직접 변경을 금지한다. 이번 흐름은 기능 브랜치를 먼저 만든다.
- 원본은 QA에서 CI 통과를 요구하고 그 뒤 PR 생성을 배치한다. PR event 전용 CI에서는 선후관계가 맞지 않는다. 이번에는 로컬 ready와 PR 이후 CI를 분리한다.
- 원본의 '모호한 표현 금지' 같은 문장 규칙을 불확실한 사실까지 확정적으로 쓰라는 지시로 사용하지 않는다.
- 원본의 '필드 추가는 항상 안전' 가정은 strict schema나 exhaustive client에서 성립하지 않을 수 있다. 실제 소비자 검증을 요구한다.
- 선택 어댑터 삭제와 필수 독립 에이전트·특정 스킬 가정 대신, 설정과 실제 가용성을 기록한다.

원본을 읽었다는 사실과 이 하네스를 실제 서비스에 적용해 검증했다는 주장은 다르다. 후자는 소비 앱에서 별도로 수행해야 한다.
