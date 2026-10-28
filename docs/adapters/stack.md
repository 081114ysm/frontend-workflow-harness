# 스택과 명령 어댑터

실제 repository의 scripts와 lockfile을 기준으로 명령을 정한다. 아래 표는 확인할 책임이며, 아직 없는 도구를 설치하라는 지시가 아니다.

| 유형 | 먼저 볼 것 | 자주 놓치는 경계 |
|---|---|---|
| Next.js 등 SSR React | route 구조, server/client 구분, 인증·서버 fetch, framework 설정 | hydration, server cache의 계정 격리, 직접 진입, 환경변수 공개 범위 |
| Vite React SPA | router, API client, 기존 state/query 계층, 호스팅 fallback | 새로고침 404, base path, stale 요청, logout cache |
| Vue/Nuxt | SFC, composable, store, route와 SSR 방식 | effect cleanup, reactive identity, client-only API |
| Svelte/SvelteKit | route/load/action, store, SSR 설정 | 서버·클라이언트 데이터 경계, hydration, form failure |
| 기존 JS 앱 | 실제 빌드·린트·테스트와 배포 방식 | 없는 typecheck를 있다고 가정하거나 전체 TS 전환을 끼워 넣기 |

React나 전역 store를 하네스 적용을 이유로 도입하지 않는다. 실제 프로젝트의 추상화와 관례를 먼저 따른다.

## 명령 예시

```json
{
  "checks": {
    "lint": { "argv": ["pnpm", "run", "lint"], "cwd": ".", "timeoutMs": 120000 },
    "typecheck": { "argv": ["pnpm", "run", "typecheck"], "cwd": ".", "timeoutMs": 120000 },
    "test": { "argv": ["pnpm", "exec", "vitest", "run"], "cwd": ".", "timeoutMs": 120000 },
    "build": { "argv": ["pnpm", "run", "build"], "cwd": ".", "timeoutMs": 180000 },
    "e2e": { "argv": ["pnpm", "exec", "playwright", "test"], "cwd": ".", "timeoutMs": 180000 }
  }
}
```

이 예시는 관련 도구가 이미 존재하는 앱에만 맞는다. scripts 이름과 실행 가능성을 확인한 뒤 쓴다. watch가 기본인 테스트는 일회 실행 모드로 고친다. 설정에 추가한 모든 검사는 ready의 필수 검사다.

Windows에서 npm.cmd 같은 shim 실행이 필요한 환경은 해당 프로젝트에서 검토한 Node wrapper 또는 WSL 환경을 사용하고 실제 실행을 확인한다. 이 번들의 검증은 macOS/Linux 명령 실행을 기준으로 한다.
