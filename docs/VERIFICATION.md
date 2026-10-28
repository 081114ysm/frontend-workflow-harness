# 이 배포 원본의 검증 범위

## 실행

```sh
npm run verify
```

Node 내장 test runner만 사용한다. 임시 디렉터리에서 테스트용 Git 저장소와 합성 보고서를 생성하며 원격 이슈·PR·API·배포는 호출하지 않는다. 실제 사용자 승인이나 브라우저 결과로 오해하지 않도록 fixture에 합성 자료임을 표시한다.

## 검증하는 조건

- 승인 누락·기획/설정/근거 변경 시 게이트 거부.
- 단일 활성 기능, 통합 브랜치·다른 작업 브랜치·단계 건너뛰기 거부.
- 명령의 실패 종료 코드, 실행 파일 없음, timeout, 자동 수정 감지, 첫 실패 중단.
- shell 치환을 실행하지 않는 인자 전달.
- 코드·새 파일·삭제·검사 JSON·브라우저 artifact 변경에 대한 증거 무효화.
- 삭제·이름 변경을 커밋한 전후의 지문 일치와 소비 앱 ignore 유무에 상관없는 원시 로그 제외.
- 미해결 High, 독립 리뷰 대체, 브라우저 누락·blocked·viewport 누락, live 필수 조건 거부.
- PR 승인·커밋 조건, PR 생성 전 CI를 요구하지 않는 전체 사이클.
- 다른 head의 CI 및 코드 내용이 같아도 달라진 head의 CI 거부.
- 재기획 시 상태 초기화와 이력, 경로 탈출·symlink·동시 lock 거부.
- 기존 지시·문서를 보존하는 설치와 설치 번들의 CLI 실행.
- CodeRabbit 생략·다른 head·미해결 High 거부와 통과 체크만으로 완료를 추론하지 않는 판정.
- 합성 GitHub 전송기를 이용한 이슈 중복 생성 방지·불확실한 응답 복구·본문 보존·동시 변경 감지.
- GitHub 파일 준비의 기존 설정 보존, 정확한 추가 base 브랜치 정규식, Codex/Claude 프로젝트 설치.
- 문서 상대 링크, JSON 구문, Node 구문과 필수 배포 파일 존재.

2026-10-28 로컬 실행 기록은 아래 명령으로 재현한다. `.coderabbit.yaml`은 CodeRabbit의 공식 `https://coderabbit.ai/integrations/schema.v2.json`을 내려받아 YAML parsing과 JSON Schema 검증을 통과했다. 검증용 Python 패키지는 임시 폴더에만 두었고 배포 번들의 런타임 dependency로 추가하지 않았다.

당일 Node.js 24.16.0에서 `npm run verify`의 47개 테스트, 상대 링크 44개·JSON 9개·JS 구문 10개 검사가 통과했다. skill-creator의 `quick_validate.py`도 통과했다. GitHub helper의 원격 결과는 합성 전송기로 검증했으며 실제 저장소의 PR·CI·CodeRabbit 리뷰 성공을 뜻하지 않는다.

2026-10-29에는 로컬 진행 본문과 GitHub 동기화 본문의 일치·PR URL 포함을 확인하는 회귀 검사를 추가한 뒤 48개 테스트가 통과했다. 기본 브랜치의 기준 커밋 `0e415db4b140cd5a42206b0916903a9ae3c86d90`은 [GitHub CI](https://github.com/081114ysm/frontend-workflow-harness/actions/runs/40701661621)도 통과했다.

## 검증하지 않은 것

소비 앱이 아직 연결되지 않아 실제 React/Vue/Next UI, 브라우저 조작, 실제 API, Figma 일치, 실제 GitHub CI·머지, 전체 WCAG 준수, 성능 수치, Windows native 실행은 검증 범위 밖이다. 소비 앱을 적용할 때 해당 앱의 검증을 별도로 남겨야 한다.

테스트 성공은 CLI의 확인 로직이 동작한다는 근거다. 스킬을 읽는 에이전트가 모든 판단을 정확히 한다거나 모든 서비스에서 결함이 없다는 증거는 아니다.
