'use strict';

/* =========================================================================
 * history.js — 대화 기록(세션) 목록 (메인 프로세스, 터미널/네이티브 claude 기반)
 *
 * PTY 안의 네이티브 claude 는 대화를 계정별 설정폴더에 자동 기록한다:
 *   <CLAUDE_CONFIG_DIR>/projects/<폴더슬러그>/<sessionId>.jsonl
 * 이 모듈은 그 파일들을 읽어 사이드바에 보여줄 "대화 목록"을 만든다.
 *  - 제목: claude 가 자동 생성한 ai-title → 없으면 첫 사용자 프롬프트
 *  - 이어가기: 렌더러가 sessionId 로 `claude --resume` 실행(main.startTerm)
 *  - 삭제: 해당 .jsonl 파일 제거
 * 우리가 따로 저장하지 않고 claude 의 실제 세션을 그대로 활용하므로,
 * 터미널에서 진행한 대화가 자동으로 목록에 쌓인다.
 * ========================================================================= */

const fs = require('fs');
const path = require('path');

const HEAD_BYTES = 96 * 1024; // 제목/메타는 파일 앞부분에 있어 앞 96KB만 읽음(대용량 세션 대비)
const TITLE_MAX = 90;

function projectsDir(configDir) { return path.join(configDir, 'projects'); }

// 파일 앞부분만 읽기 (수 MB짜리 세션도 전체 파싱하지 않도록)
function readHead(file, maxBytes) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const len = Math.min(maxBytes, size);
    if (!len) return '';
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, 0);
    return buf.toString('utf-8');
  } catch {
    return '';
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* noop */ } }
  }
}

function textOf(message) {
  const c = message && message.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.filter((p) => p && p.type === 'text').map((p) => p.text || '').join(' ');
  return '';
}

// 사람이 직접 친 프롬프트인지(시스템/슬래시/주입 텍스트 제외)
function isHumanPrompt(s) {
  const t = (s || '').trim();
  if (!t) return false;
  if (t[0] === '<') return false;          // <command-name> · <local-command-…> · <system-reminder> …
  if (t.startsWith('Caveat:')) return false;
  if (t[0] === '/') return false;          // 순수 슬래시 명령
  return true;
}

function cleanTitle(s) {
  const t = (s || '').replace(/\s+/g, ' ').trim();
  return t.length > TITLE_MAX ? t.slice(0, TITLE_MAX - 1) + '…' : t;
}

// 한 세션 파일 → { title, cwd }  (대화 흔적이 없으면 title='')
function summarize(file) {
  const head = readHead(file, HEAD_BYTES);
  if (!head) return { title: '', cwd: '' };
  const lines = head.split('\n');
  let aiTitle = '', firstHuman = '', cwd = '';
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];
    if (!ln || ln[0] !== '{') continue;
    let o;
    try { o = JSON.parse(ln); } catch { continue; } // 마지막 잘린 줄 등은 건너뜀
    if (!cwd && o.cwd) cwd = o.cwd;
    if (!aiTitle && o.type === 'ai-title' && o.aiTitle) aiTitle = String(o.aiTitle);
    if (!firstHuman && o.type === 'user' && o.message && !o.isMeta) {
      const t = textOf(o.message);
      if (isHumanPrompt(t)) firstHuman = t;
    }
    if (aiTitle && cwd) break; // 제목+cwd 다 찾으면 조기 종료
  }
  return { title: cleanTitle(aiTitle || firstHuman), cwd };
}

// 활성 계정(configDir)의 모든 세션 목록 — 최근 수정순.
// 대화 흔적이 없는(제목 못 뽑은) 빈 세션은 제외해 목록을 깔끔히 유지한다.
function listSessions(configDir) {
  const root = projectsDir(configDir);
  let entries;
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return []; }
  const out = [];
  for (const d of entries) {
    if (!d.isDirectory()) continue;
    const dir = path.join(root, d.name);
    let files;
    try { files = fs.readdirSync(dir); } catch { continue; }
    for (const f of files) {
      if (!f.endsWith('.jsonl')) continue;
      const full = path.join(dir, f);
      let st;
      try { st = fs.statSync(full); } catch { continue; }
      if (!st.size) continue;
      const info = summarize(full);
      if (!info.title) continue; // 아직 아무 대화도 없는 세션
      out.push({ id: f.slice(0, -6), title: info.title, cwd: info.cwd, mtime: st.mtimeMs });
    }
  }
  out.sort((a, b) => b.mtime - a.mtime);
  return out;
}

// 세션 id 의 .jsonl 삭제 (어느 프로젝트 슬러그에 있든 찾아서 제거)
function deleteSession(configDir, id) {
  if (!id) return false;
  const root = projectsDir(configDir);
  let entries;
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return false; }
  let removed = false;
  for (const d of entries) {
    if (!d.isDirectory()) continue;
    const file = path.join(root, d.name, id + '.jsonl');
    if (fs.existsSync(file)) {
      try { fs.rmSync(file, { force: true }); removed = true; } catch { /* noop */ }
    }
  }
  return removed;
}

module.exports = { listSessions, deleteSession, projectsDir };
