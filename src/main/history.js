'use strict';

/* =========================================================================
 * history.js — 대화 기록 저장 (메인 프로세스)
 *
 * 계정별로 대화를 JSON 파일 하나씩 저장합니다.
 *   <userData>/history/<accountId>/<convoId>.json
 *
 * 한 대화 파일 구조:
 *   { id, title, cwd, sessionId, createdAt, updatedAt, messages: [...] }
 *   messages 항목:
 *     { role:'user',      text }
 *     { role:'assistant', text }
 *     { role:'tool', id, name, preview, ok, content }
 * ========================================================================= */

const fs = require('fs');
const path = require('path');

function safe(s) {
  return String(s == null ? '_' : s).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80) || '_';
}

class History {
  constructor(dataDir) {
    this.root = path.join(dataDir, 'history');
  }

  _dir(accountId) {
    const d = path.join(this.root, safe(accountId));
    try { fs.mkdirSync(d, { recursive: true }); } catch { /* noop */ }
    return d;
  }

  /** 대화 목록(가벼운 메타만) — 최신순 */
  list(accountId) {
    try {
      const d = this._dir(accountId);
      return fs.readdirSync(d)
        .filter((f) => f.endsWith('.json'))
        .map((f) => {
          try {
            const j = JSON.parse(fs.readFileSync(path.join(d, f), 'utf-8'));
            return {
              id: j.id,
              title: j.title || '새 대화',
              cwd: j.cwd || null,
              createdAt: j.createdAt || 0,
              updatedAt: j.updatedAt || j.createdAt || 0,
              count: Array.isArray(j.messages) ? j.messages.length : 0,
            };
          } catch { return null; }
        })
        .filter(Boolean)
        .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    } catch {
      return [];
    }
  }

  load(accountId, id) {
    try {
      return JSON.parse(fs.readFileSync(path.join(this._dir(accountId), safe(id) + '.json'), 'utf-8'));
    } catch {
      return null;
    }
  }

  /** 저장(있으면 덮어쓰기). 빈 대화(메시지 0)는 저장하지 않음. */
  save(accountId, convo) {
    if (!convo || !convo.id) return false;
    if (!Array.isArray(convo.messages) || convo.messages.length === 0) return false;
    const now = Date.now();
    if (!convo.createdAt) convo.createdAt = now;
    convo.updatedAt = now;
    try {
      fs.writeFileSync(path.join(this._dir(accountId), safe(convo.id) + '.json'), JSON.stringify(convo));
      return true;
    } catch {
      return false;
    }
  }

  remove(accountId, id) {
    try { fs.unlinkSync(path.join(this._dir(accountId), safe(id) + '.json')); } catch { /* noop */ }
    return true;
  }
}

module.exports = { History };
