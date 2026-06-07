'use strict';

/**
 * Claude Code 명령어 도우미 데이터.
 * - app: true  → 이 데스크톱 앱이 직접 처리하는 명령
 * - skill: true → Claude(에이전트)에게 전달되어 실행되는 기능
 * 그 외는 설명/참고용.
 */
window.SLASH_COMMANDS = [
  // ── 앱이 직접 처리 ──────────────────────────────
  { cmd: '/new',       app: true, action: 'newChat',     desc: '새 대화를 시작합니다', cat: '대화' },
  { cmd: '/clear',     app: true, action: 'newChat',     desc: '현재 대화를 비우고 새로 시작', cat: '대화' },
  { cmd: '/folder',    app: true, action: 'pickFolder',  desc: '작업 폴더(프로젝트)를 변경', cat: '환경' },
  { cmd: '/accounts',  app: true, action: 'accounts',    desc: '계정 전환 / 다른 계정 추가', cat: '계정' },
  { cmd: '/login',     app: true, action: 'login',       desc: '새 Claude 계정으로 로그인', cat: '계정' },
  { cmd: '/settings',  app: true, action: 'settings',    desc: '설정 창 열기', cat: '환경' },
  { cmd: '/help',      app: true, action: 'help',        desc: '사용법과 명령어 목록 보기', cat: '도움말' },

  // ── Claude에게 전달되는 기능(스킬) ───────────────
  { cmd: '/init',            skill: true, desc: '이 폴더를 분석해 CLAUDE.md 문서를 생성', cat: '코드' },
  { cmd: '/review',          skill: true, desc: '변경 사항(PR)을 코드 리뷰', cat: '코드' },
  { cmd: '/security-review', skill: true, desc: '보안 관점에서 변경 사항을 점검', cat: '코드' },

  // ── 참고용(설명) ────────────────────────────────
  { cmd: '/model',   app: true, action: 'model',   desc: '사용할 모델 선택(Opus/Sonnet/Haiku)', cat: '환경' },
  { cmd: '/compact', app: true, action: 'compact', desc: '긴 대화를 요약해 토큰 절약', cat: '대화' },
  { cmd: '/cost',    app: true, action: 'cost',    desc: '이번 세션의 토큰 사용량 보기', cat: '정보' },
];

/** 입력 문자열로 명령어 필터링 (앞부분 "/xxx" 매칭) */
window.filterSlashCommands = function (query) {
  const q = (query || '').replace(/^\//, '').toLowerCase();
  const list = window.SLASH_COMMANDS;
  if (!q) return list;
  const starts = [];
  const contains = [];
  for (const c of list) {
    const name = c.cmd.replace(/^\//, '').toLowerCase();
    if (name.startsWith(q)) starts.push(c);
    else if (name.includes(q) || c.desc.toLowerCase().includes(q)) contains.push(c);
  }
  return starts.concat(contains);
};
