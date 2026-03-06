# PDF 분할 및 순서 변경 도구

Tauri + React 기반의 로컬 PDF 페이지 선택/재배치/저장 데스크톱 앱입니다.

## 최신 업데이트 (v0.1.3)

- 툴바 UX 개선: 툴바 접기/펼치기, localStorage 상태 복원, 컨트롤 정렬/배치 최적화.
- PDF 연결 프로그램(탐색기/Finder)으로 열기 흐름 지원 강화: 외부에서 연 PDF를 앱에서 바로 로드.
- 외부 파일 열기 진입 경로에서 멀티 윈도우 사용 시 동작 안정성 개선.

## 주요 기능

- PDF 열기 및 썸네일 가상 스크롤 미리보기
- 페이지 선택 방식:
  - 체크박스
  - 빠른 입력 (`1,3,5-9`)
  - 범위 추가/제외
- 왼쪽 썸네일 드래그앤드랍으로 페이지 순서 변경
- 썸네일 체크박스 옆 휴지통 버튼으로 선택 해제
- 페이지 회전(왼쪽/오른쪽)
- 미리보기 확대/축소(`-`, `+`, 맞춤)
- 다른 PDF를 현재 문서에 추가:
  - 앞쪽/뒤쪽 삽입 선택
  - 추가 페이지 범위 선택 (`1-3, 5, 9`)
- 선택 페이지 저장:
  - PDF (`<원본명>_<UUID>_selected.pdf`)
  - PNG/JPG (선택 페이지별 파일 저장)
- 한국어/영어 UI 전환

## 기술 스택

- Tauri 2
- React 19 + TypeScript
- Vite
- `pdf-lib` (PDF 병합/복사/저장)
- `pdfjs-dist` (미리보기/썸네일 렌더링)

## 개발 환경 준비

- Node.js 18 이상(권장: 최신 LTS)
- Rust 툴체인(Tauri 데스크톱 빌드용)

## 실행 방법

의존성 설치:

```bash
npm install
```

웹 개발 서버:

```bash
npm run dev
```

Tauri 데스크톱 개발 실행:

```bash
npm run tauri dev
```

프론트엔드 빌드:

```bash
npm run build
```

데스크톱 앱 빌드:

```bash
npm run tauri build
```

## 프로젝트 구조

- `src/App.tsx`: 메인 UI 및 PDF 처리 로직
- `src/App.css`: 스타일
- `src-tauri/`: Tauri(Rust) 데스크톱 래퍼

## 참고

- 모든 PDF 처리 작업은 로컬에서 수행됩니다.
- 대용량 PDF는 썸네일 가상화/큐 렌더링으로 처리합니다.
- 저장 시 선택 페이지는 현재 썸네일 재정렬 순서를 따릅니다.

## English README

- [README.md](./README.md)
