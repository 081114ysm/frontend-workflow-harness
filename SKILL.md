---
name: frontend-workflow-harness
description: 프론트엔드 기능 구현과 버그 수정을 기능 단위로 진행하고 화면·API·브라우저 검증 증거를 남긴다. 단순 설명이나 문장 수정에는 전체 사이클을 시작하지 않는다.
license: MIT
---

# 프론트엔드 기능 개발

대상 프로젝트의 기존 지시·문서·실제 코드를 먼저 읽는다. 이 스킬은 기술 스택이나 외부 서비스 변경 권한을 새로 부여하지 않는다. 문서의 경로는 이 SKILL.md가 있는 번들을 기준으로 읽고, CLI는 대상 프로젝트 루트에서 실행한다.

1. 사용자가 기능을 설명하면 [에이전트 자동 사이클](docs/rules/agent-cycle.md)에 따라 이슈·기획서·구현·검증·PR 작업을 수행한다. 사용자에게 내부 CLI 조작을 매번 떠넘기지 않는다. 실제 승인 게이트에서만 검토를 받는다.
2. 최초 설정 또는 스택 변경: [프로젝트 설정](docs/rules/project-setup.md). `scripts/harness.mjs doctor`로 실제 명령과 브랜치를 확인하고 설정한다. 명시된 사용자 선택을 우선하고, 빠진 필수 결정만 질문한다.
3. 기능 착수·재개: [워크플로우](docs/rules/workflow.md), [진행 복구](docs/rules/progress.md). 하나의 활성 기능과 기획서·승인 범위를 확인한다. 이미 주어진 승인을 반복해서 요구하지 않는다.
4. 계획·구현: [프론트엔드 계약](docs/rules/frontend-contract.md). 실제 원본, 화면 상태, 인수 조건, API 계약을 기획서에 연결하고 기존 구조를 재사용한다.
5. 검증: [리뷰](docs/rules/review.md), [브라우저 QA](docs/rules/verification.md). 실행하지 못한 항목은 미검증으로 남기고 Mock과 실제 연동, 자체와 독립 리뷰를 구분한다.
6. 전달: [GitHub 운영](docs/rules/github.md), [CodeRabbit](docs/adapters/coderabbit.md). 코드·기획 변경 뒤에는 이전 증거를 재사용하지 않는다. PR 생성 뒤 현재 head의 CI·실제 봇 리뷰와 머지를 확인한 뒤 완료한다.

번들의 CLI 경로는 `scripts/harness.mjs`다. 설치 후에는 보통 `.agents/skills/frontend-workflow-harness/scripts/harness.mjs`다. `--root`로 대상 프로젝트를 명시할 수 있다. 다른 프로젝트 경로와 섞지 않는다.

디자인·API 원본에 접근할 수 없으면 확인 가능한 범위부터 진행하고, 의존 작업은 미검증으로 남긴다. 원본·승인·테스트·스크린샷·리뷰 결과를 만들어내지 않는다. 계획 변경은 구체적인 영향과 함께 재검토하되 내부 함수 분리 같은 구현 세부사항은 계속 진행한다.

CLI는 워크플로우 검사용이다. 직접 파일 수정이나 GitHub 작업을 차단하는 보안 경계가 아니며, 승인자가 누구인지나 브라우저를 실제로 조작했는지 인증하지 못한다.
