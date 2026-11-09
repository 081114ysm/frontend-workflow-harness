---
name: frontend-workflow-harness
description: 프론트엔드 기능과 버그 수정을 기획 승인부터 QA·PR까지 진행한다. 단순 설명·문구 수정에는 전체 사이클을 시작하지 않는다.
license: MIT
---

# 프론트엔드 기능 개발

대상 프로젝트 지시를 확인하고, 앱 루트에서 번들의 `scripts/harness.mjs status --compact`로 현재 단계와 기획·QA 경로를 읽는다. 처음 설정하거나 스택이 바뀔 때만 `doctor`를 실행한다.

요청에 나온 화면·경로·심볼부터 `rg`로 찾고 일치한 코드 주변만 연다. 구현 파일, 직접 영향받는 호출부와 관련 테스트부터 본다. 확인할 계약이나 의존성이 생길 때만 범위를 넓힌다. 변경은 승인 범위에 필요한 파일로 제한하고, 제출 전에 변경 파일 목록으로 무관한 변경이 섞였는지 확인한다.

아래에서 **현재 단계에 필요한 문서만** 연다. 이미 읽은 문서는 새 판단에 필요한 내용이 있을 때만 다시 확인한다.

| 상황 | 읽을 문서 |
|---|---|
| 첫 설정·스택 변경 | [프로젝트 설정](docs/rules/project-setup.md) |
| 기능 시작·복구 | [자동 사이클](docs/rules/agent-cycle.md) 또는 [진행 복구](docs/rules/progress.md) |
| 화면·API 계약 변경 | [프론트엔드 계약](docs/rules/frontend-contract.md) |
| diff 검토·QA | [리뷰](docs/rules/review.md), [검증](docs/rules/verification.md). 자동 브라우저 실행 시 [어댑터](docs/adapters/browser-automation.md) |
| GitHub 전달 | [GitHub 운영](docs/rules/github.md). 봇 리뷰 시 [CodeRabbit](docs/adapters/coderabbit.md) |

검사는 `run all --compact`로 실행한다. 실패하면 표시된 로그에서 관련 오류부터 찾는다. 상세 상태·로그·보고서는 현재 판단에 필요할 때만 연다.

하나의 기능을 기획 승인 범위 안에서 구현한다. 계약 변경 시 재승인받고, 코드·기획·설정 변경 뒤에는 만료된 증거를 재사용하지 않는다. 검증하지 않은 항목은 미검증으로 남긴다. PR·머지 등 원격 작업은 사용자 지시 범위를 따른다.
