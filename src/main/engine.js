'use strict';

/* =========================================================================
 * engine.js — Claude Agent SDK 래퍼 (메인 프로세스)
 *
 * 스트리밍 입력 모드로 query()를 띄워 하나의 대화 세션을 유지합니다.
 * - 사용자가 메시지를 보내면 큐에 넣어 turn을 진행
 * - SDK 메시지를 렌더러용 단순 이벤트로 변환해 onEvent로 전달
 * - canUseTool 권한 콜백을 onPermission(렌더러 모달)으로 라우팅
 * - 모델/추론강도(effort)는 세션 중에도 변경 가능
 * ========================================================================= */

let _sdkPromise = null;
function getSdk() {
  if (!_sdkPromise) _sdkPromise = import('@anthropic-ai/claude-agent-sdk');
  return _sdkPromise;
}

function mapPermissionMode(mode) {
  switch (mode) {
    case 'acceptEdits': return 'acceptEdits';
    case 'plan': return 'plan';
    case 'bypassPermissions': return 'bypassPermissions';
    case 'prompt':
    default: return 'default';
  }
}

class Session {
  constructor(opts) {
    this.cwd = opts.cwd || undefined;
    this.model = opts.model || undefined;
    this.effort = opts.effort || undefined;
    this.permissionMode = mapPermissionMode(opts.permissionMode);
    this.account = opts.account || null;
    this.configDir = opts.configDir || null; // 앱 전용 ~/.claude 격리 디렉터리
    this.resume = opts.resume || null;       // 이어가기용 세션 id
    this.sessionId = null;                    // SDK가 알려준 현재 세션 id
    this.onEvent = opts.onEvent || (() => {});
    this.onPermission = opts.onPermission || (async () => 'deny');

    this._queue = [];
    this._wake = null;
    this._closed = false;
    this._query = null;
    this._streamedText = false;
    this._abort = null;
  }

  async *_inputStream() {
    while (!this._closed) {
      if (this._queue.length) {
        yield this._queue.shift();
      } else {
        await new Promise((resolve) => { this._wake = resolve; });
      }
    }
  }

  pushUser(text) {
    this._queue.push({
      type: 'user',
      message: { role: 'user', content: text },
      parent_tool_use_id: null,
    });
    if (this._wake) { const w = this._wake; this._wake = null; w(); }
  }

  async start() {
    const { query } = await getSdk();
    const env = { ...process.env };
    // 앱 전용 설정 디렉터리로 시스템 ~/.claude 와 격리 (앰비언트 로그인 누출 방지)
    if (this.configDir) env.CLAUDE_CONFIG_DIR = this.configDir;
    if (this.account && this.account.token) {
      env.CLAUDE_CODE_OAUTH_TOKEN = this.account.token;
    }
    this._abort = new AbortController();

    this._query = query({
      prompt: this._inputStream(),
      options: {
        cwd: this.cwd,
        model: this.model,
        effort: this.effort,
        permissionMode: this.permissionMode,
        includePartialMessages: true,
        abortController: this._abort,
        resume: this.resume || undefined,
        env,
        stderr: () => {},
        canUseTool: async (toolName, input, ctx) => {
          let decision = 'deny';
          try {
            decision = await this.onPermission({
              tool: toolName,
              input,
              title: ctx && ctx.title,
              description: ctx && ctx.description,
              displayName: ctx && ctx.displayName,
              toolUseID: ctx && ctx.toolUseID,
            });
          } catch {
            decision = 'deny';
          }
          if (decision === 'deny') {
            return { behavior: 'deny', message: '사용자가 도구 사용을 거부했습니다.' };
          }
          // allow: updatedInput(실행할 도구 입력)은 런타임 스키마에서 필수.
          const allow = { behavior: 'allow', updatedInput: input };
          if (decision === 'always' && ctx && Array.isArray(ctx.suggestions) && ctx.suggestions.length) {
            allow.updatedPermissions = ctx.suggestions;
          }
          return allow;
        },
      },
    });

    this._consume();
  }

  async _consume() {
    try {
      for await (const msg of this._query) {
        this._handle(msg);
      }
    } catch (e) {
      if (!this._closed) {
        this.onEvent({ type: 'error', message: String((e && e.message) || e) });
      }
    }
  }

  _handle(msg) {
    switch (msg.type) {
      case 'system':
        if (msg.subtype === 'init') {
          if (msg.session_id) this.sessionId = msg.session_id;
          this.onEvent({
            type: 'system_init',
            model: msg.model,
            tools: msg.tools,
            cwd: msg.cwd,
            apiKeySource: msg.apiKeySource,
            permissionMode: msg.permissionMode,
            sessionId: msg.session_id || this.sessionId || null,
          });
        }
        break;

      case 'stream_event': {
        const ev = msg.event;
        if (!ev) break;
        if (ev.type === 'message_start') {
          this._streamedText = false;
          this.onEvent({ type: 'assistant_boundary' });
        } else if (ev.type === 'content_block_delta' && ev.delta) {
          if (ev.delta.type === 'text_delta') {
            this._streamedText = true;
            this.onEvent({ type: 'assistant_delta', text: ev.delta.text });
          } else if (ev.delta.type === 'thinking_delta') {
            this.onEvent({ type: 'thinking_delta', text: ev.delta.thinking });
          }
        }
        break;
      }

      case 'assistant': {
        const content = (msg.message && msg.message.content) || [];
        if (!this._streamedText) {
          const text = content.filter((b) => b.type === 'text').map((b) => b.text).join('');
          if (text) this.onEvent({ type: 'assistant_delta', text });
        }
        for (const b of content) {
          if (b.type === 'tool_use') {
            this.onEvent({ type: 'tool_use', id: b.id, name: b.name, input: b.input });
          }
        }
        this._streamedText = false;
        break;
      }

      case 'user': {
        const content = msg.message && msg.message.content;
        if (Array.isArray(content)) {
          for (const b of content) {
            if (b && b.type === 'tool_result') {
              let text = '';
              if (typeof b.content === 'string') text = b.content;
              else if (Array.isArray(b.content)) text = b.content.map((c) => c.text || '').join('');
              this.onEvent({ type: 'tool_result', id: b.tool_use_id, ok: !b.is_error, content: text });
            }
          }
        }
        break;
      }

      case 'result':
        if (msg.session_id) this.sessionId = msg.session_id;
        this.onEvent({
          type: 'turn_done',
          cost: msg.total_cost_usd,
          isError: !!msg.is_error,
          result: msg.result,
          sessionId: msg.session_id || this.sessionId || null,
        });
        break;
    }
  }

  async interrupt() {
    if (this._query && this._query.interrupt) {
      try { await this._query.interrupt(); } catch { /* noop */ }
    }
  }

  async setPermissionMode(mode) {
    this.permissionMode = mapPermissionMode(mode);
    if (this._query && this._query.setPermissionMode) {
      try { await this._query.setPermissionMode(this.permissionMode); } catch { /* noop */ }
    }
  }

  async setModel(model) {
    this.model = model || undefined;
    if (this._query && this._query.setModel) {
      try { await this._query.setModel(this.model); } catch { /* noop */ }
    }
  }

  async setEffort(effort) {
    this.effort = effort || undefined;
    // 세션 중 변경: 설정 레이어에 effortLevel 머지 (low~xhigh). 'max'는 런타임이 받으면 적용.
    if (this._query && this._query.applyFlagSettings) {
      try { await this._query.applyFlagSettings({ effortLevel: effort }); } catch { /* noop */ }
    }
  }

  close() {
    this._closed = true;
    if (this._wake) { const w = this._wake; this._wake = null; w(); }
    if (this._abort) { try { this._abort.abort(); } catch { /* noop */ } }
  }
}

module.exports = { Session };
