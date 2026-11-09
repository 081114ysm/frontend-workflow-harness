# 브라우저 자동 검증과 성능 측정

프로젝트의 프레임워크와 무관하게 실행 중인 HTTP(S) 웹 앱을 Playwright로 검사한다. 프로젝트마다 경로·계정·화면·API가 다르므로 인수 조건을 자동으로 추측하지 않는다. 에이전트가 실제 앱을 읽고 시나리오를 채운 뒤 실행한다. [예시 JSON](../../config/browser.example.json)은 실제 실행 기록이 아니다.

## 실행

대상 앱에 이미 있는 `playwright` 또는 `@playwright/test`를 사용한다. 없으면 프로젝트의 패키지 관리자에 맞춰 개발 의존성과 선택 엔진을 설치한다. 예를 들어 npm 프로젝트에서는:

```sh
npm install --save-dev playwright
npx playwright install chromium
```

실행 중인 앱에 맞게 `qa/browser.json`을 작성한다. URL이나 비밀번호를 임의로 만들지 않는다. 시나리오는 Git에서 무시되지 않는 일반 파일이어야 코드 지문에 연결된다. 대상 앱 루트에서 하네스 CLI를 실행한다.

```sh
node .agents/skills/frontend-workflow-harness/scripts/harness.mjs browser-run --from qa/browser.json
```

- `baseUrl`은 페이지 경로가 없는 origin이다. `target`은 기본 `local`(루프백만), 승인된 비운영 원격 환경은 `test`다. API·리소스의 다른 origin은 규칙이나 `assetOrigins`에 명시한다.
- `engine`: `chromium`(기본), `firefox`, `webkit`. 엔진이 설치되지 않거나 사이트·인증을 사용할 수 없으면 차단으로 기록한다. 이 저장소의 실제 브라우저 통합 테스트는 Chromium으로 실행한다.
- `cases`: `journey`·`states`·`keyboard` 사례를 프로젝트 뷰포트마다 실행한다. 사용자 동작 뒤 화면 assertion, 키 입력 뒤 초점 확인을 넣는다. 화면 상태 검사가 실제로 해당 없으면 `statesNotApplicable`에 사유를 적는다.
- `steps.action`: `goto`(같은 origin의 `/경로`), `click`, `fill`(`value` 또는 환경변수 이름 `env`), `press`(`key`), `visible`, `text`(`value` 포함 확인), `focus`. `locator`는 `testId`, `label`, `role`/`name`, CSS `selector`를 지원한다. 값 입력용 비밀은 환경변수로만 전달한다. `storageStateEnv`는 비운영 로그인 상태 파일의 **프로젝트 상대 경로**를 담은 환경변수 이름이다. 로그인 상태 파일은 Git에서 제외한다.
- 가로 넘침, 브라우저 콘솔 오류와 네트워크 불일치도 기록한다. iframe·팝업·다운로드·복잡한 로그인처럼 이 형식이 다루지 않는 조작은 프로젝트의 전용 Playwright 테스트와 수기 증거로 확인한다. 자동 QA 필수 프로젝트는 필수 자동 시나리오도 따로 통과해야 한다.

실행 후 `evidence/browser-automation.json`, `evidence/browser.json`과 `QA.md`를 갱신한다. 실패하면 이전 브라우저 통과를 재사용하지 않는다. 보고서에는 케이스 ID, 오류 수, 허용 규칙 ID, HTTP 상태와 출처 판정만 넣으며 요청 query·본문·헤더 값·원시 콘솔 메시지·쿠키는 복사하지 않는다.

## API 판별

`api.expect`는 `none`, `live`, `mock`, `mixed` 중 하나다. `live`와 `mixed`에는 `required: true`인 live 경로를 하나 이상 지정한다. 각 뷰포트에서 실제 관측이 기대값과 필수 경로를 충족해야 한다.

| 관측 | 분류 |
|---|---|
| 정확한 origin·경로와 프로젝트가 발급하는 `proof` 응답 헤더 일치 | `live` |
| 하네스가 `mocks`로 직접 응답하거나 등록된 Mock 서버·Mock 표식과 일치 | `mock` |
| 실제와 Mock이 모두 관측됨 | `mixed` |
| 출처 표식 누락·충돌, 응답 실패, 등록되지 않은 fetch/XHR, 필요한 요청이 아예 없음 | `unknown` |
| API 호출 없음이 기대값이고 관측된 대상 요청이 없음 | `none` |

`mocks`는 정확한 `path`, 선택 `origin`/`method`/`status`, JSON `body`를 설정한다. 상태 코드를 의도적으로 검사하는 API 규칙에만 `allowStatuses`를 추가한다. 규칙이 겹치면 더 긴 경로를 우선한다. `requireLiveApi: true`일 때 수기 `live`, Mock, 혼합, 미확인은 통과하지 않는다.

판정 범위는 실행한 화면에서 **브라우저가 관측한 요청과 신뢰할 수 있게 구성한 표식**이다. 같은 origin에 프록시·SSR·Mock이 섞여도 서버가 출처를 드러내지 않으면 자동으로 확인할 수 없다. 브라우저 내부 대체 응답이나 서버 내부 호출까지 탐지한다고 가정하지 않는다. 서비스 워커는 이 실행기에서 차단하므로 MSW 브라우저 모드를 테스트하려면 전용 테스트를 쓰거나 HTTP Mock 서버 또는 하네스 fixture를 사용한다. [Playwright 네트워크 문서](https://playwright.dev/docs/network)에 관측 범위가 설명돼 있다.

## 성능 측정

브라우저 시나리오의 `performance`를 켜면 QA와 함께 측정한다. 운영 URL 측정은 별도 탐색 모드에서 실행한다.

```sh
node .agents/skills/frontend-workflow-harness/scripts/browser-runner.mjs --from qa/production-performance.json --mode performance
```

이 모드는 `target: production`, 승인된 운영 `baseUrl`, `performance.pages`의 페이지 ID·`path`·선택 `ready` locator와 지표 예산으로 설정할 수 있다. 운영 대상에서 조작 시나리오·로그인 상태·fixture 사용을 거부한다. 라우팅으로 관측한 GET/HEAD/OPTIONS 외 요청과 WebSocket은 차단한다. 읽기 전용 탐색이 가능한 페이지를 선택한다. 리다이렉트 이후 요청과 GET의 서버 부작용은 이 정책만으로 검증할 수 없다.

각 페이지를 새 브라우저 컨텍스트에서 반복 탐색하고 설정된 관측 시간 뒤 TTFB·FCP·LCP·CLS·load를 수집한다. 라우팅으로 브라우저 캐시는 꺼지며 네트워크·CPU 제한은 적용하지 않는다. 개별 표본·중앙값·표본 수와 예산을 기록하며, 예산 지표의 표본이 누락되거나 중앙값이 초과되면 실패한다. 엔진에서 지원하지 않는 지표는 미측정이다. 이 값은 [브라우저 탐색 타이밍](https://w3c.github.io/navigation-timing/)을 쓰는 실험실 값이며 실제 사용자 p75·INP나 운영 SLA를 대신하지 않는다. 운영 측정 결과는 현재 코드가 배포됐다는 증거가 아니다.

별도 성능 모드의 JSON은 표준 출력에 기록된다. 저장하려면 위 명령에 `> qa/production-performance-result.json`을 붙인다. 측정 또는 예산 검사가 실패하면 종료 코드는 1이다. 기능 QA에서 측정한 값은 `browser-run`이 QA.md에 자동으로 남긴다.
