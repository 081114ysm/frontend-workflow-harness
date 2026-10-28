# CodeRabbit과 GitHub 연결

## 준비된 것과 실제 연결의 차이

이 번들은 `.coderabbit.yaml`, 프로젝트 통합 브랜치에 맞추는 설정 생성기, PR 결과 조회와 완료 증거 게이트를 제공한다. CodeRabbit 계정·GitHub App 설치는 실제 계정에서 별도로 해야 한다. 저장소에 YAML을 추가하는 것만으로 GitHub App이 설치되지는 않는다. [공식 시작 가이드](https://docs.coderabbit.ai/getting-started/quickstart)

## 최초 한 번

1. 실제 GitHub 저장소와 소유자 권한을 확인한다. CodeRabbit 계정으로 로그인하고 [GitHub 연동 가이드](https://docs.coderabbit.ai/platforms/github-com)에 따라 대상 저장소를 연결한다. 설치 범위를 요청한 저장소로 제한한다.
2. 브라우저가 새 약관 동의나 코드·PR 접근 권한 부여를 요구하면, 보이는 범위와 대상이 정해진 상태에서 사용자가 승인한다. 로그인 정보나 토큰을 문서에 적지 않는다.
3. 앱의 실제 `frontend-harness.config.json`에서 `github.repository`, 통합/default 브랜치, `codeRabbit.required: true`를 설정한다.
4. 에이전트가 `node 번들/scripts/setup-github.mjs`로 파일을 준비한다. 기존 `.coderabbit.yaml`이나 GitHub 템플릿이 있으면 덮어쓰지 않고 차이를 병합한다. config 변경은 feature 승인 전에 끝낸다.
5. 실제 PR을 열어 현재 head에서 CodeRabbit 결과가 게시되는지 확인한다. 이 확인 전에는 '연동 완료'라고 보고하지 않는다.

## 기본 동작

한국어 리뷰, 균형 잡힌 지적, 일반 PR의 자동 리뷰와 push 후 증분 리뷰를 켠다. Draft는 제외하며 5개 리뷰 커밋 뒤 자동 pause를 적용한다. 통합 브랜치가 default와 다르면 `^브랜치명$` 형태로 정확히 추가한다. 생성기에서 정규식 특수문자도 이스케이프한다. [자동 리뷰 제어](https://docs.coderabbit.ai/configuration/auto-review)

설정 원본은 `config/coderabbit.json`이다. `.coderabbit.yaml`은 동일 내용을 YAML에 유효한 JSON flow 형식으로 저장한 파일이며 외부 YAML dependency 없이 생성한다. 원본과 생성 파일의 일치는 저장소 검사에서 확인한다.

자동 코드 수정·테스트 생성·문서 생성·충돌 해결 기능은 끈다. 사용자가 요청한 범위는 리뷰 자동화다. 기능 구현은 기존 승인·검증 흐름에서 수행한다. 자세한 필드 의미는 [공식 configuration reference](https://docs.coderabbit.ai/reference/configuration)를 따른다.

## 현재 PR에서 확인

에이전트가 connector로 PR 리뷰·스레드·체크를 읽거나 `github.mjs pr-inspect`를 실행한다. 실제 PR head와 로컬 HEAD가 다르면 먼저 push 상태를 정리한다. helper는 현재 head의 CodeRabbit App check가 completed/success이며 제목이 Finished인 경우만 실제 완료 후보로 표시한다. legacy status나 다른 출력 형식은 원본 결과를 직접 확인한다.

**초록색 체크는 지적이 모두 해결됐다는 뜻이 아니다.** skipped·rate limited·일부 실패 상태도 브랜치 필수 체크에서 통과로 취급될 수 있다. 실제 리뷰 본문과 미해결 스레드를 읽고 수정 또는 근거 있는 수용을 기록한다. 이 때문에 단순한 status success만으로 done을 허용하지 않는다. [CodeRabbit 체크 의미](https://docs.coderabbit.ai/pr-reviews/status-check)

`evidence/coderabbit.json`에 실제 provider/status/headSha/reviewUrl과 지적 처리 결과를 기록하고 `H record --kind coderabbit --file ...`로 연결한다. skipped/rate_limited/pending과 다른 head는 거부한다. Critical/High는 수정 전 통과하지 않는다.

## 재리뷰와 문제 해결

자동 pause·한도·누락이 있으면 현재 PR의 CodeRabbit 설명과 계정 상태를 확인한다. 봇 명령 댓글이 허용된 경우 `@coderabbitai review` 또는 필요한 전체 재리뷰 명령을 요청한다. 반복 실패를 무한 재시도하거나 유료 요금제를 임의 활성화하지 않는다.

브랜치 보호에서 CodeRabbit 체크를 필수로 삼으려면 실제 체크가 게시된 뒤 이름과 App source를 확인해 등록한다. 기존 보호 규칙을 완화하지 않는다. 해당 계정의 플랜·요금·좌석·리뷰 한도는 실제 화면에서 확인하고, 설정 파일만 보고 사용 가능하다고 단정하지 않는다.
