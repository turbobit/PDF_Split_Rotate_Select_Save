# E2E

Playwright 기반의 실제 사용자 조작형 UI 테스트 준비물입니다.

실행:

```bash
npm run e2e:test
```

헤드 모드 실행:

```bash
npm run e2e:test:headed
```

구성:

- `scripts/generate-e2e-fixtures.mjs`: 테스트용 PDF fixture 생성
- `playwright.config.ts`: Vite dev server + Playwright 설정
- `e2e/app.smoke.spec.ts`: 탭 열기, 단축키 전환, PDF 링크 클릭 smoke test

테스트는 `/?e2e=1` 모드에서만 노출되는 `window.__PDF_APP_E2E__` 브리지를 사용해 fixture PDF를 앱 내부 탭으로 엽니다.
