'use strict';

/* =========================================================================
 * main.js — 메인 프로세스 (임베디드 터미널 방식)
 *
 * node-pty 로 진짜 PTY를 만들어 그 안에서 네이티브 `claude` 를 실행한다.
 * 렌더러의 xterm.js 가 화면을 그리고, 입력/출력/리사이즈를 IPC로 주고받는다.
 *  - 로그인/세션기록은 네이티브 claude 가 계정별 CLAUDE_CONFIG_DIR 에 관리
 * ========================================================================= */

const { app, BrowserWindow, ipcMain, dialog, shell, clipboard } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');
const pty = require('@lydell/node-pty');
const { Accounts } = require('./accounts');
const history = require('./history');

const isDev = process.argv.includes('--dev');

/** @type {BrowserWindow | null} */
let mainWindow = null;
/** @type {Accounts | null} */
let accounts = null;
/** 현재 PTY (node-pty IPty) */
let term = null;
let termMeta = { accountId: null, cwd: null, sessionId: null };
let sessionWatcher = null;   // 활성 계정 projects 폴더 감시(세션 목록 자동 갱신)
let watchTimer = null;

// 로그인 URL 자동 열기: PTY raw 출력(화면 wrap 영향 없는 claude 원본)에서 완성된 OAuth URL 감지
let _authBuf = '';
let _lastAuthUrl = '';
const _URLCHAR = /[A-Za-z0-9\-._~:\/?#\[\]@!$&'()*+,;=%]/;
function cleanForUrl(s) {
  return s
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')   // OSC 시퀀스
    .replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]/g, '')           // CSI 시퀀스
    .replace(/\r/g, '');                                  // \n 은 유지(hard-wrap 판단)
}
// claude 가 URL 을 터미널 폭으로 hard-wrap(중간 \n) 하므로, 단일 \n 은 이어붙이고
// 빈 줄/공백/비URL 문자에서 끝내 원본 URL 복원. redirect_uri 포함 시에만 완성 인정.
function detectAuthUrl(buf) {
  const clean = cleanForUrl(buf);
  const start = clean.search(/https?:\/\/[^\s]*(?:oauth|authorize)/i);
  if (start < 0) return null;
  const lines = clean.slice(start).split('\n');
  if (lines.length < 2) return null;            // 아직 줄바꿈 전(수신 중) — 더 기다림
  const W = lines[0].length;                     // hard-wrap 폭 = 첫 줄 길이
  let url = lines[0];
  let done = false;
  for (let k = 1; k < lines.length; k++) {
    if (!_URLCHAR.test(lines[k].charAt(0))) { done = true; break; } // 다음 줄이 비URL → 끝
    url += lines[k];
    if (lines[k].length < W - 1) { done = true; break; }            // 폭보다 짧은 줄 → URL 마지막 조각
  }
  if (!done || !/redirect_uri=/.test(url)) return null;
  // state 는 PKCE base64url 43자. 그 뒤에 hard-wrap 으로 붙은 안내문("Paste code here…") 제거
  const m = url.match(/^(https?:\/\/[\s\S]*?[?&]state=[A-Za-z0-9_-]{43})/);
  return m ? m[1] : (/[?&]state=/.test(url) ? url : null);
}

function send(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1180, height: 800, minWidth: 900, minHeight: 600,
    backgroundColor: '#2C2620',
    title: '클로드 코드 데스크',
    icon: path.join(__dirname, '..', '..', 'assets', 'icon.ico'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });
  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  if (isDev) mainWindow.webContents.openDevTools({ mode: 'detach' });
  mainWindow.on('closed', () => { killTerm(); stopWatchSessions(); mainWindow = null; });
}

app.whenReady().then(() => {
  accounts = new Accounts(app.getPath('userData'));
  accounts.ensureDefault();
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => { killTerm(); if (process.platform !== 'darwin') app.quit(); });

// ─────────────────────── 터미널(PTY) ───────────────────────
function defaultCwd() {
  try { return app.getPath('documents'); } catch { return os.homedir(); }
}

// 번들된 네이티브 claude.exe (친구 PC에 Claude 미설치여도 동작)
function bundledClaudePath() {
  const rel = ['node_modules', '@anthropic-ai', 'claude-agent-sdk-win32-x64', 'claude.exe'];
  const packaged = path.join(process.resourcesPath || '', 'app.asar.unpacked', ...rel);
  if (fs.existsSync(packaged)) return packaged;
  // 자가복구: NSIS 차등 설치가 claude.exe 를 claude.exe.old.<ts> 로 백업만 하고
  // 제 이름으로 되돌리지 못한 경우(설치 중 기존 앱이 켜져 파일 잠김 등) → 가장 온전한 백업을 복구.
  try {
    const dir = path.dirname(packaged);
    const olds = fs.readdirSync(dir)
      .filter((f) => f.startsWith('claude.exe.old.'))
      .map((f) => { const p = path.join(dir, f); return { p, size: fs.statSync(p).size }; })
      .sort((a, b) => b.size - a.size);
    if (olds.length) {
      fs.renameSync(olds[0].p, packaged);
      for (let i = 1; i < olds.length; i++) { try { fs.rmSync(olds[i].p, { force: true }); } catch { /* noop */ } }
      if (fs.existsSync(packaged)) return packaged;
    }
  } catch { /* noop */ }
  const dev = path.join(app.getAppPath(), ...rel);
  if (fs.existsSync(dev)) return dev;
  return process.platform === 'win32' ? 'claude.exe' : 'claude';
}

function killTerm() {
  if (term) { try { term.kill(); } catch { /* noop */ } term = null; }
}

function stopWatchSessions() {
  if (watchTimer) { clearTimeout(watchTimer); watchTimer = null; }
  if (sessionWatcher) { try { sessionWatcher.close(); } catch { /* noop */ } sessionWatcher = null; }
}

// 활성 계정의 projects 폴더를 감시 → 세션이 추가/변경되면 렌더러에 알림(목록 자동 갱신)
function watchSessions(configDir) {
  stopWatchSessions();
  const root = history.projectsDir(configDir);
  try { fs.mkdirSync(root, { recursive: true }); } catch { /* noop */ }
  try {
    sessionWatcher = fs.watch(root, { recursive: true }, () => {
      if (watchTimer) clearTimeout(watchTimer);
      watchTimer = setTimeout(() => send('sessions:changed'), 500);
    });
  } catch { /* noop — 감시 실패해도 수동 새로고침은 동작 */ }
}

function startTerm(opts) {
  opts = opts || {};
  killTerm();
  let id = opts.accountId || accounts.activeId();
  if (!id) id = accounts.ensureDefault().activeId;
  if (opts.accountId && opts.accountId !== accounts.activeId()) accounts.setActive(opts.accountId);

  const dir = accounts.configDir(id);
  try { fs.mkdirSync(dir, { recursive: true }); } catch { /* noop */ }
  const useCwd = opts.cwd || termMeta.cwd || defaultCwd();
  const claude = bundledClaudePath();

  const env = Object.assign({}, process.env, {
    CLAUDE_CONFIG_DIR: dir,
    TERM: 'xterm-256color',
    FORCE_COLOR: '1',
    COLORTERM: 'truecolor',
    // 번들 claude.exe 의 자동 업데이트 차단: 켜져 있으면 claude 가 app.asar.unpacked 안의
    // claude.exe 를 claude.exe.old.<ts> 로 rename 후 교체를 시도하다 실패해 바이너리가
    // 통째로 사라질 수 있다(앱 깨짐). 번들은 고정 버전이므로 자동업데이트가 불필요.
    DISABLE_AUTOUPDATER: '1',
  });
  delete env.CLAUDE_CODE_OAUTH_TOKEN; // 설정폴더 자격증명만 사용(앰비언트 토큰 격리)

  const args = [];
  if (opts.resumeId) args.push('--resume', String(opts.resumeId)); // 기존 대화 이어가기

  try {
    term = pty.spawn(claude, args, {
      name: 'xterm-256color',
      cols: Math.max(20, opts.cols || 100),
      rows: Math.max(6, opts.rows || 30),
      cwd: useCwd,
      env,
    });
  } catch (e) {
    send('term:exit', { error: String((e && e.message) || e) });
    return false;
  }
  termMeta = { accountId: id, cwd: useCwd, sessionId: opts.resumeId || null };
  watchSessions(dir);
  _authBuf = ''; _lastAuthUrl = '';
  term.onData((d) => {
    send('term:data', d);
    _authBuf = (_authBuf + d).slice(-32000);
    const url = detectAuthUrl(_authBuf);
    if (url && url !== _lastAuthUrl) {
      _lastAuthUrl = url;
      shell.openExternal(url).catch(() => { /* noop */ });
      send('term:data', '\r\n\x1b[32m── 로그인 페이지를 브라우저로 열었습니다 ──\x1b[0m\r\n\x1b[33m── 인증 후 받은 코드는 [Ctrl+Shift+V] 로 붙여넣으세요 ──\x1b[0m\r\n');
    }
  });
  term.onExit((e) => { send('term:exit', e || {}); term = null; });
  send('term:started', { accountId: id, cwd: useCwd, sessionId: opts.resumeId || null });
  return true;
}

// ─────────────────────── IPC ───────────────────────
ipcMain.handle('app:init', () => ({
  defaultCwd: defaultCwd(),
  accounts: accounts.list(),
}));

ipcMain.handle('term:start', (_e, opts) => startTerm(opts || {}));
ipcMain.handle('term:restart', (_e, opts) =>
  startTerm(Object.assign({ accountId: termMeta.accountId, cwd: termMeta.cwd }, opts || {})));
ipcMain.handle('term:kill', () => { killTerm(); return true; });
ipcMain.on('term:input', (_e, data) => { if (term) { try { term.write(data); } catch { /* noop */ } } });
ipcMain.on('term:resize', (_e, { cols, rows }) => {
  if (term) { try { term.resize(Math.max(2, cols || 80), Math.max(1, rows || 24)); } catch { /* noop */ } }
});

// ─────────────────────── 대화 기록(세션) ───────────────────────
ipcMain.handle('sessions:list', () => {
  const id = accounts.activeId();
  return id ? history.listSessions(accounts.configDir(id)) : [];
});
ipcMain.handle('sessions:delete', (_e, id) => {
  const acc = accounts.activeId();
  if (acc) history.deleteSession(accounts.configDir(acc), id);
  return acc ? history.listSessions(accounts.configDir(acc)) : [];
});

ipcMain.handle('accounts:list', () => accounts.list());
ipcMain.handle('accounts:add', (_e, label) => accounts.add(label));
ipcMain.handle('accounts:setActive', (_e, id) => accounts.setActive(id));
ipcMain.handle('accounts:rename', (_e, { id, label }) => accounts.rename(id, label));
ipcMain.handle('accounts:remove', (_e, id) => accounts.remove(id));
ipcMain.handle('accounts:logout', (_e, id) => accounts.logout(id));

ipcMain.handle('dialog:pickFolder', async () => {
  if (!mainWindow) return null;
  const res = await dialog.showOpenDialog(mainWindow, {
    title: '작업 폴더 선택',
    properties: ['openDirectory', 'createDirectory'],
  });
  // 네이티브 대화상자가 닫힌 뒤 창/웹콘텐츠에 포커스를 되돌린다. 안 그러면
  // 폴더 변경 후 claude '이 폴더 신뢰?' 프롬프트에서 키 입력이 안 먹어
  // (터미널이 키보드 포커스를 잃은 상태) Yes 를 못 누른다.
  try { mainWindow.focus(); mainWindow.webContents.focus(); } catch { /* noop */ }
  if (res.canceled || !res.filePaths.length) return null;
  return res.filePaths[0];
});
ipcMain.handle('app:openExternal', (_e, url) => shell.openExternal(String(url)));
ipcMain.handle('clip:write', (_e, text) => { clipboard.writeText(text == null ? '' : String(text)); return true; });
ipcMain.handle('clip:read', () => clipboard.readText());
