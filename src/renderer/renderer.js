'use strict';

/* =========================================================================
 * 클로드 코드 데스크 — 렌더러 (임베디드 터미널)
 *  - xterm.js 화면 ↔ 메인 프로세스의 PTY(node-pty)로 네이티브 claude 실행
 *  - 계정(격리된 설정폴더) 전환 / 작업폴더 변경 / 새 세션
 * ========================================================================= */

const api = window.claudeDesk;
const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));

const el = {
  app: $('#app'),
  terminal: $('#terminal'),
  btnWorkdir: $('#btn-workdir'),
  btnNewSession: $('#btn-new-session'),
  btnAddAccount: $('#btn-add-account'),
  accountList: $('#account-list'),
  chatTitle: $('#chat-title'),
  btnCmdModel: $('#btn-cmd-model'),
  btnCmdClear: $('#btn-cmd-clear'),
  btnCmdHelp: $('#btn-cmd-help'),
  btnSettings: $('#btn-settings'),
  accountChip: $('#account-chip'),
  accountAvatar: $('#account-avatar'),
  accountName: $('#account-name'),
  accountPlan: $('#account-plan'),
  settingsModal: $('#settings-modal'),
  settingsBody: $('#settings-body'),
  settingsClose: $('#settings-close'),
};

const state = {
  workdir: null,
  accounts: { activeId: null, accounts: [] },
  starting: false,
};

/* ───────────────────── xterm ───────────────────── */
// 베이지 앱과 어울리는 따뜻한 다크 팔레트 (코드블록 톤과 일치)
const THEME = {
  background: '#2C2620',
  foreground: '#F3ECDD',
  cursor: '#E7CBA0',
  cursorAccent: '#2C2620',
  selectionBackground: '#5A4E3C',
  black: '#3A332A', red: '#D2754F', green: '#9CB46F', yellow: '#E3B257',
  blue: '#86A2C0', magenta: '#C08AA6', cyan: '#76B3A8', white: '#E9E1D0',
  brightBlack: '#8A7C66', brightRed: '#E08A63', brightGreen: '#AEC384',
  brightYellow: '#F0C667', brightBlue: '#9DB6D2', brightMagenta: '#D29DB8',
  brightCyan: '#8FC6BB', brightWhite: '#FBF8F1',
};

const term = new Terminal({
  theme: THEME,
  fontFamily: '"Cascadia Code", "D2Coding", "Consolas", monospace',
  fontSize: 13.5,
  lineHeight: 1.15,
  letterSpacing: 0,
  cursorBlink: true,
  cursorStyle: 'bar',
  scrollback: 8000,
  allowProposedApi: true,
  macOptionIsMeta: true,
});
const fitAddon = new FitAddon.FitAddon();
term.loadAddon(fitAddon);
term.open(el.terminal);

function doFit() {
  try { fitAddon.fit(); } catch { /* noop */ }
  api.termResize(term.cols, term.rows);
}

term.onData((d) => api.termInput(d));
api.onTermData((d) => { term.write(d); }); // URL 자동 열기는 메인(raw PTY)에서 처리
api.onTermStarted(() => { state.starting = false; setTimeout(doFit, 30); term.focus(); });
api.onTermExit((e) => {
  const msg = (e && e.error)
    ? `\r\n\x1b[31m── 터미널을 시작하지 못했습니다: ${e.error} ──\x1b[0m\r\n`
    : `\r\n\x1b[90m── 세션이 종료되었습니다. 사이드바의 "↻ 새 세션 시작"으로 다시 시작하세요. ──\x1b[0m\r\n`;
  term.write(msg);
});

// 컨테이너 크기 변동 시 자동 리핏
const ro = new ResizeObserver(() => doFit());
ro.observe(el.terminal);
window.addEventListener('resize', doFit);

/* ───────── 터미널 복사/붙여넣기 (로그인 URL 자동 열기는 메인이 raw PTY 에서 처리) ───────── */

// 드래그로 선택하면 자동 복사(xterm 은 기본 우클릭 메뉴가 없으므로)
term.onSelectionChange(() => {
  const sel = term.getSelection();
  if (sel && sel.trim()) api.copyText(sel);
});
// 복사: Ctrl+Shift+C, 붙여넣기: Ctrl+Shift+V (선택 없을 때 Ctrl+C 는 터미널로 전달)
term.attachCustomKeyEventHandler((e) => {
  if (e.type !== 'keydown') return true;
  if (e.ctrlKey && e.shiftKey && e.code === 'KeyC') {
    const sel = term.getSelection();
    if (sel) { api.copyText(sel); return false; }
  }
  if (e.ctrlKey && e.shiftKey && e.code === 'KeyV') { // Ctrl+Shift+V 붙여넣기(터미널 표준)
    Promise.resolve(api.readText()).then((t) => { if (t) api.termInput(t); });
    return false;
  }
  return true;
});

// 우클릭: 선택 있으면 복사, 없으면 클립보드 붙여넣기
el.terminal.addEventListener('contextmenu', async (e) => {
  e.preventDefault();
  const sel = term.getSelection();
  if (sel) { api.copyText(sel); term.clearSelection(); }
  else { const t = await api.readText(); if (t) api.termInput(t); }
});

async function startSession(accountId) {
  if (state.starting) return;
  state.starting = true;
  term.reset();
  doFit();
  await api.termStart({
    accountId: accountId || state.accounts.activeId,
    cwd: state.workdir,
    cols: term.cols,
    rows: term.rows,
  });
  updateTitle();
}

function updateTitle() {
  const active = (state.accounts.accounts || []).find((a) => a.id === state.accounts.activeId);
  const folder = state.workdir ? state.workdir.replace(/\\/g, '/').split('/').filter(Boolean).pop() : '세션';
  el.chatTitle.textContent = folder + (active ? `  ·  ${active.label}` : '');
}

/* ───────────────────── 계정 ───────────────────── */
function initialOf(label) { return (label || '계').trim().charAt(0) || '계'; }

function applyActiveAccount() {
  const list = state.accounts.accounts || [];
  const active = list.find((a) => a.id === state.accounts.activeId) || list[0];
  if (!active) {
    el.accountAvatar.textContent = '계';
    el.accountName.textContent = '계정';
    el.accountPlan.textContent = '터미널';
    return;
  }
  el.accountAvatar.textContent = initialOf(active.label);
  el.accountName.textContent = active.label;
  el.accountPlan.textContent = active.loggedIn ? '로그인됨' : '로그인 필요';
}

function renderAccounts() {
  const list = state.accounts.accounts || [];
  el.accountList.innerHTML = list.map((a) => `
    <button class="account-row-side ${a.id === state.accounts.activeId ? 'active' : ''}" data-id="${a.id}" title="${escapeAttr(a.label)}">
      <span class="avatar sm">${initialOf(a.label)}</span>
      <span class="acc-side-meta">
        <span class="acc-side-name">${escapeHtml(a.label)}</span>
        <span class="acc-side-state">${a.loggedIn ? '로그인됨' : '로그인 필요'}</span>
      </span>
      ${a.id === state.accounts.activeId ? '<span class="acc-dot"></span>' : ''}
    </button>`).join('');
  $$('#account-list .account-row-side').forEach((node) => node.addEventListener('click', async () => {
    const id = node.dataset.id;
    if (id === state.accounts.activeId) { term.focus(); return; }
    state.accounts = await api.setActiveAccount(id);
    applyActiveAccount(); renderAccounts(); updateTitle();
    startSession(id);
  }));
}

async function addAccount() {
  const meta = await api.addAccount();
  state.accounts = await api.listAccounts();
  applyActiveAccount(); renderAccounts();
  startSession(meta.id);
}

/* ───────────────────── 작업 폴더 / 세션 제어 ───────────────────── */
async function pickFolder() {
  const dir = await api.pickFolder();
  if (dir) {
    state.workdir = dir;
    el.btnWorkdir.textContent = dir;
    el.btnWorkdir.title = dir;
    updateTitle();
    startSession(); // 새 폴더로 세션 재시작
  }
}

/* ───────────────────── 설정 모달 ───────────────────── */
function openSettings() {
  const list = state.accounts.accounts || [];
  const rows = list.map((a) => `
    <div class="account-row" data-id="${a.id}" style="${a.id === state.accounts.activeId ? 'border-color:var(--accent);' : ''}">
      <span class="avatar">${initialOf(a.label)}</span>
      <span class="account-meta">
        <span class="account-name">${escapeHtml(a.label)}${a.id === state.accounts.activeId ? ' · 사용 중' : ''}</span>
        <span class="account-plan">${a.loggedIn ? '로그인됨' : '로그인 필요'}</span>
      </span>
      ${a.loggedIn
        ? `<button class="btn btn-ghost btn-sm acc-logout" data-id="${a.id}" title="이 계정 로그아웃">로그아웃</button>`
        : `<button class="btn btn-soft btn-sm acc-login" data-id="${a.id}" title="이 계정으로 로그인">로그인</button>`}
      <button class="btn btn-ghost btn-sm acc-remove" data-id="${a.id}" title="이 계정 삭제">삭제</button>
    </div>`).join('');
  el.settingsBody.innerHTML = `
    <div class="settings-section">
      <h3>계정 (클릭해 전환 · 각 계정은 독립 로그인)</h3>
      ${rows || '<div style="color:var(--ink-faint); font-size:12.5px;">계정이 없습니다.</div>'}
      <div style="margin-top:10px;"><button class="btn btn-soft btn-sm" id="s-add">+ 다른 계정 추가</button></div>
    </div>
    <div class="settings-section">
      <h3>작업 폴더</h3>
      <div style="font-family:var(--mono); font-size:12.5px; color:var(--ink-soft); word-break:break-all;">${escapeHtml(state.workdir || '(기본값)')}</div>
    </div>
    <div class="settings-section">
      <h3>정보</h3>
      <div style="color:var(--ink-soft); font-size:12.5px; line-height:1.7;">
        클로드 코드 데스크 · 앱 안의 진짜 터미널에서 네이티브 Claude Code 실행<br>
        로그인·세션 기록은 각 계정 폴더에 저장됩니다.
      </div>
    </div>`;
  el.settingsModal.hidden = false;
  $$('#settings-body .account-row').forEach((row) => row.addEventListener('click', async (e) => {
    if (e.target.closest('.acc-remove') || e.target.closest('.acc-logout')) return;
    state.accounts = await api.setActiveAccount(row.dataset.id);
    applyActiveAccount(); renderAccounts(); updateTitle();
    el.settingsModal.hidden = true;
    startSession(row.dataset.id);
  }));
  $$('#settings-body .acc-remove').forEach((btn) => btn.addEventListener('click', async (e) => {
    e.stopPropagation();
    const wasActive = btn.dataset.id === state.accounts.activeId;
    state.accounts = await api.removeAccount(btn.dataset.id);
    if (!state.accounts.accounts.length) state.accounts = await api.listAccounts(); // ensureDefault 보정
    applyActiveAccount(); renderAccounts(); updateTitle();
    openSettings();
    if (wasActive) startSession();
  }));
  $$('#settings-body .acc-logout').forEach((btn) => btn.addEventListener('click', async (e) => {
    e.stopPropagation();
    const wasActive = btn.dataset.id === state.accounts.activeId;
    state.accounts = await api.logout(btn.dataset.id);
    applyActiveAccount(); renderAccounts();
    openSettings();
    if (wasActive) startSession(); // 재시작하면 터미널에서 다시 로그인 안내
  }));
  $$('#settings-body .acc-login').forEach((btn) => btn.addEventListener('click', async (e) => {
    e.stopPropagation();
    state.accounts = await api.setActiveAccount(btn.dataset.id);
    applyActiveAccount(); renderAccounts(); updateTitle();
    el.settingsModal.hidden = true;
    startSession(btn.dataset.id); // 활성화 후 터미널에서 claude 로그인 플로우 시작
  }));
  const add = $('#s-add');
  if (add) add.addEventListener('click', () => { el.settingsModal.hidden = true; addAccount(); });
}

/* ───────────────────── 유틸 ───────────────────── */
function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function escapeAttr(s) { return escapeHtml(s); }

/* 헤더의 슬래시 명령 바로가기 (터미널로 입력 전송) */
function sendSlash(cmd) { api.termInput(cmd + '\r'); term.focus(); }

/* ───────────────────── 이벤트 바인딩 ───────────────────── */
el.btnWorkdir.addEventListener('click', pickFolder);
el.btnNewSession.addEventListener('click', () => startSession());
el.btnAddAccount.addEventListener('click', addAccount);
el.btnSettings.addEventListener('click', openSettings);
el.accountChip.addEventListener('click', openSettings);
el.settingsClose.addEventListener('click', () => (el.settingsModal.hidden = true));
el.btnCmdModel.addEventListener('click', () => sendSlash('/model'));
el.btnCmdClear.addEventListener('click', () => sendSlash('/clear'));
el.btnCmdHelp.addEventListener('click', () => sendSlash('/help'));
el.terminal.addEventListener('click', () => term.focus());

/* ───────────────────── 초기화 ───────────────────── */
(async function init() {
  try {
    const info = await api.init();
    state.workdir = info.defaultCwd;
    state.accounts = info.accounts || state.accounts;
    el.btnWorkdir.textContent = info.defaultCwd || '폴더 선택…';
    el.btnWorkdir.title = info.defaultCwd || '';
    applyActiveAccount();
    renderAccounts();
    updateTitle();
    // 레이아웃이 잡힌 다음 핏 → 세션 시작
    requestAnimationFrame(() => requestAnimationFrame(() => { doFit(); startSession(); }));
  } catch (e) {
    term.write('\x1b[31m초기화 오류: ' + String(e) + '\x1b[0m\r\n');
  }
})();
