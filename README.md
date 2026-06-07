# 클로드 코드 데스크 (Claude Desk)

Claude Code를 터미널 대신 **한국어·베이지 테마 GUI**로 사용하는 Electron 데스크톱 앱.

## 특징

- **임베디드 PTY 터미널**: `@homebridge/node-pty-prebuilt-multiarch` + `xterm.js`로 진짜 PTY 안에서 번들된 네이티브 `claude`를 실행
- **무설치 동작**: `claude.exe`를 앱에 번들하므로 받는 사람 PC에 Claude가 깔려 있지 않아도 됨
- **멀티 계정**: 계정별로 격리된 `CLAUDE_CONFIG_DIR`을 주입해 로그인·세션 기록을 분리
- **터미널 내 OAuth 로그인**: 로그인 URL을 자동으로 브라우저로 열고, 받은 코드는 `Ctrl+Shift+V`로 붙여넣기
- 헤더 슬래시 바로가기(`/model`, `/clear`, `/help`)와 설정 모달(계정 추가/전환/로그아웃)

## 개발 실행

```sh
npm install
npm start        # 개발자도구까지 보려면 npm run dev
```

## 빌드 (Windows 설치파일)

```sh
npm run dist     # → dist\ClaudeDesk-Setup-<version>.exe
```

> ⚠️ **OneDrive 주의**: 프로젝트는 OneDrive **밖** 경로(예: `C:\Users\<id>\claude-desk`)에 두세요.
> 번들 바이너리 `claude.exe`(약 230MB)가 OneDrive "온라인 전용(공간 절약)"으로 비워진 상태에서 빌드하면
> 설치파일에서 누락되어, 받는 사람 PC에서 터미널이 뜨지 않습니다.

## 요구사항

- Node.js 18+
- Windows 10/11 (현재 win32-x64 타깃)

## 구조

```
src/main/        메인 프로세스 (main · accounts · preload)
src/renderer/    렌더러 (index.html · renderer.js · slash-commands.js · styles.css · vendor/xterm)
assets/          아이콘
```

## 라이선스

MIT
