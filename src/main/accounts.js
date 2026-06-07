'use strict';

/* =========================================================================
 * accounts.js — 계정 관리 (메인 프로세스, 터미널/네이티브 claude 기반)
 *
 * 각 계정은 **격리된 설정 디렉터리**(<userData>/accounts/<id>)를 가진다.
 * 그 디렉터리를 CLAUDE_CONFIG_DIR 로 주입해 네이티브 claude 를 실행하면,
 * 로그인/자격증명(.credentials.json)·세션 기록이 계정별로 분리되어 저장된다.
 *  - 첫 실행: 자격증명 없음 → 터미널에서 claude 가 로그인 안내(진짜 TTY라 정상 동작)
 *  - 로그인 후: 해당 폴더에 자격증명 저장 → 다음부터 자동 로그인
 *  - 토큰을 우리가 직접 저장하지 않으므로 안전(클로드가 OS 보안저장소/파일로 관리)
 * ========================================================================= */

const fs = require('fs');
const path = require('path');

class Accounts {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.root = path.join(dataDir, 'accounts');
    this.file = path.join(dataDir, 'accounts.json');
    try { fs.mkdirSync(this.root, { recursive: true }); } catch { /* noop */ }
    this.data = this._load();
  }

  _load() {
    try {
      const j = JSON.parse(fs.readFileSync(this.file, 'utf-8'));
      return { activeId: j.activeId || null, accounts: Array.isArray(j.accounts) ? j.accounts : [] };
    } catch {
      return { activeId: null, accounts: [] };
    }
  }
  _save() {
    try { fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2)); } catch { /* noop */ }
  }

  configDir(id) { return path.join(this.root, id); }
  credsPath(id) { return path.join(this.configDir(id), '.credentials.json'); }
  isLoggedIn(id) {
    const a = id || this.data.activeId;
    return !!(a && fs.existsSync(this.credsPath(a)));
  }
  _meta(a) { return { id: a.id, label: a.label, addedAt: a.addedAt || 0, loggedIn: fs.existsSync(this.credsPath(a.id)) }; }

  list() {
    let activeId = this.data.activeId;
    if (activeId && !this.data.accounts.some((a) => a.id === activeId)) activeId = null;
    return { activeId, accounts: this.data.accounts.map((a) => this._meta(a)) };
  }

  /** 계정이 하나도 없으면 기본 계정 생성, 활성 계정이 유효하지 않으면 보정 */
  ensureDefault() {
    if (!this.data.accounts.length) {
      this.add('내 Claude 계정');
    } else if (!this.data.activeId || !this.data.accounts.some((a) => a.id === this.data.activeId)) {
      this.data.activeId = this.data.accounts[0].id;
      this._save();
    }
    return this.list();
  }

  add(label) {
    const id = 'acc_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
    const n = this.data.accounts.length;
    const def = n === 0 ? '내 Claude 계정' : ('Claude 계정 ' + (n + 1));
    const acc = { id, label: label || def, addedAt: Date.now() };
    this.data.accounts.push(acc);
    try { fs.mkdirSync(this.configDir(id), { recursive: true }); } catch { /* noop */ }
    this.data.activeId = id;
    this._save();
    return this._meta(acc);
  }

  setActive(id) {
    if (this.data.accounts.some((a) => a.id === id)) { this.data.activeId = id; this._save(); }
    return this.list();
  }

  rename(id, label) {
    const a = this.data.accounts.find((x) => x.id === id);
    if (a && label) { a.label = label; this._save(); }
    return this.list();
  }

  remove(id) {
    this.data.accounts = this.data.accounts.filter((a) => a.id !== id);
    if (this.data.activeId === id) this.data.activeId = this.data.accounts.length ? this.data.accounts[0].id : null;
    try { fs.rmSync(this.configDir(id), { recursive: true, force: true }); } catch { /* noop */ }
    this._save();
    return this.list();
  }

  /** 로그아웃 = 활성 계정의 자격증명 파일 삭제(계정 항목은 유지) */
  logout(id) {
    const a = id || this.data.activeId;
    if (a) { try { fs.rmSync(this.credsPath(a), { force: true }); } catch { /* noop */ } }
    return this.list();
  }

  activeId() {
    const id = this.data.activeId;
    return (id && this.data.accounts.some((a) => a.id === id)) ? id : null;
  }
}

module.exports = { Accounts };
