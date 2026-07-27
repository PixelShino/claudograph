# Native Telegram Threads for claph — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Route each Claude Code tab into its own native Telegram forum topic (thread), keyed by a stable label, so tabs don't collide and closed/reopened tabs reuse their thread instead of spawning duplicates.

**Architecture:** The daemon is the single owner of the Bot API and of `state/threads.json`. `session-mcp` asks the daemon to ensure a thread for its label on startup and forwards the returned `message_thread_id` on every send/edit. The Python hooks (`stop-notify`, `progress-notify`) independently compute the same label and read `threads.json` to learn the `message_thread_id`. Inbound messages route by `message_thread_id → label → live session handle`.

**Tech Stack:** bun + grammy (TS: `daemon.ts`, `session-mcp.ts`, `shared.ts`), Python 3 stdlib (hooks: `stop-notify.py`, `progress-notify.py`), Telegram Bot API 10.x (`createForumTopic`, `editForumTopic`, `sendRichMessage` with `message_thread_id`).

## Global Constraints

- **Base dir:** `~/.claude/claph/` (outside the project repo; not committed to the SEO repo).
- **Label key** = `process.env.CLAPH_LABEL || basename(cwd)` (TS) / `os.environ.get('CLAPH_LABEL') or basename(payload['cwd'])` (Python). Computed identically both sides.
- **threads.json format:** `{ "<label>": { "thread_id": number, "name": string, "status": "active"|"idle", "ts": number } }`. **Only the daemon writes it** (atomic: temp file + rename). Hooks read only.
- **Rich send format:** `sendRichMessage(chat, { markdown }, extra)` / `editMessageText(chat, id, { markdown }, extra)`; direct-HTTP hooks use body `{chat_id, rich_message:{markdown}, message_thread_id?}`. Verified working (`ok:true`).
- **Backward compat:** if a thread can't be resolved (Threaded Mode off / no record), send WITHOUT `message_thread_id` — the flat-chat behavior must still work.
- **Cyrillic on Windows:** hooks read stdin as UTF-8 bytes; test scripts run with `PYTHONUTF8=1`; no non-cp1251 chars in `print`.
- **Hooks must never crash the session** — wrap failures, log, return.
- **Thread creation is bot-only** (`Disallow users to create new threads` = ON). Never rely on the user creating a thread.

---

### Task 1: `shared.ts` — threads state module

**Files:**
- Modify: `~/.claude/claph/shared.ts` (add exports near other `STATE_DIR` constants)
- Test: `~/.claude/claph/threads-state.test.ts` (new)

**Interfaces:**
- Produces:
  - `export const THREADS_FILE: string` — `join(STATE_DIR, 'threads.json')`
  - `export type ThreadStatus = 'active' | 'idle'`
  - `export type ThreadRecord = { thread_id: number; name: string; status: ThreadStatus; ts: number }`
  - `export type ThreadsFile = Record<string, ThreadRecord>`
  - `export function labelKey(cwd: string, envLabel?: string): string` — `envLabel?.trim() || basename(cwd)`
  - `export function readThreads(): ThreadsFile` — parse file, `{}` on missing/corrupt
  - `export function writeThreads(t: ThreadsFile): void` — atomic temp+rename, mode 0o600

- [ ] **Step 1: Write the failing test**

```ts
// threads-state.test.ts
import { test, expect } from 'bun:test'
import { rmSync } from 'fs'
import { labelKey, readThreads, writeThreads, THREADS_FILE } from './shared.ts'

test('labelKey prefers env label, falls back to cwd basename', () => {
  expect(labelKey('/home/u/Admin-Pannel-for-SEO')).toBe('Admin-Pannel-for-SEO')
  expect(labelKey('/home/u/Admin-Pannel-for-SEO', 'чат')).toBe('чат')
  expect(labelKey('/home/u/x', '  ')).toBe('x') // blank env ignored
})

test('write then read round-trips; missing file reads as {}', () => {
  rmSync(THREADS_FILE, { force: true })
  expect(readThreads()).toEqual({})
  const t = { 'proj': { thread_id: 348083, name: '🟢 proj', status: 'active' as const, ts: 111 } }
  writeThreads(t)
  expect(readThreads()).toEqual(t)
})

test('corrupt file reads as {} not throw', () => {
  writeThreads({} as any)
  require('fs').writeFileSync(THREADS_FILE, '{ not json')
  expect(readThreads()).toEqual({})
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ~/.claude/claph && bun test threads-state.test.ts`
Expected: FAIL — `labelKey`/`readThreads`/`writeThreads` not exported.

- [ ] **Step 3: Implement in `shared.ts`**

```ts
// add near STATE_DIR exports; `basename`/`join` already imported from 'path',
// `writeFileSync`/`readFileSync`/`renameSync`/`mkdirSync` from 'fs' (add missing).
export const THREADS_FILE = join(STATE_DIR, 'threads.json')
export type ThreadStatus = 'active' | 'idle'
export type ThreadRecord = { thread_id: number; name: string; status: ThreadStatus; ts: number }
export type ThreadsFile = Record<string, ThreadRecord>

export function labelKey(cwd: string, envLabel?: string): string {
  const e = (envLabel ?? '').trim()
  return e || basename(cwd)
}

export function readThreads(): ThreadsFile {
  try {
    return JSON.parse(readFileSync(THREADS_FILE, 'utf8')) as ThreadsFile
  } catch {
    return {}
  }
}

export function writeThreads(t: ThreadsFile): void {
  mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 })
  const tmp = THREADS_FILE + '.tmp'
  writeFileSync(tmp, JSON.stringify(t, null, 2), { mode: 0o600 })
  renameSync(tmp, THREADS_FILE)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd ~/.claude/claph && bun test threads-state.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit** (only if claph is a git repo; else skip — ask user)

```bash
cd ~/.claude/claph && git add shared.ts threads-state.test.ts && git commit -m "feat(threads): threads.json state module (labelKey/read/write)"
```

---

### Task 2: daemon `/ensure-thread` — create-or-reuse a thread for a label

**Files:**
- Modify: `~/.claude/claph/daemon.ts` (add route in `handle`, near `/register`; import threads helpers)
- Test: `~/.claude/claph/ensure-thread.itest.ts` (new; **integration — hits real Bot API**, run manually)

**Interfaces:**
- Consumes: `readThreads`, `writeThreads`, `labelKey`, `ThreadRecord` (Task 1); `loadAllowFrom`, `bot` (existing).
- Produces: HTTP `POST /ensure-thread {label: string} -> { thread_id: number }`. Behavior: if `threads.json[label]` exists, set status `active`, return its `thread_id`; else `createForumTopic(chat, "🟢 "+label)` on the first allow-listed chat, persist record, return `thread_id`.

- [ ] **Step 1: Add the route in `daemon.ts` `handle()` (after `/deregister` block)**

```ts
if (path === '/ensure-thread' && req.method === 'POST') {
  const { label } = (await req.json()) as { label: string }
  const threads = readThreads()
  const existing = threads[label]
  if (existing) {
    existing.status = 'active'; existing.ts = Date.now()
    threads[label] = existing; writeThreads(threads)
    return json({ thread_id: existing.thread_id })
  }
  const chat = loadAllowFrom()[0]
  if (!chat) return json({ error: 'no allow-listed chat' }, 400)
  const name = `🟢 ${label}`
  try {
    const topic = await bot.api.createForumTopic(chat, name)
    threads[label] = { thread_id: topic.message_thread_id, name, status: 'active', ts: Date.now() }
    writeThreads(threads)
    return json({ thread_id: topic.message_thread_id })
  } catch (err) {
    // Threaded Mode off / not a forum → caller falls back to flat chat.
    logInbound({ kind: 'ensure-thread:fail', label, error: String(err).slice(0, 140) })
    return json({ error: 'thread unavailable' }, 200)
  }
}
```

- [ ] **Step 2: Integration test (manual, real Bot API)**

```ts
// ensure-thread.itest.ts — run: bun ensure-thread.itest.ts  (requires daemon running)
const r1 = await fetch('http://127.0.0.1:8787/ensure-thread', {
  method: 'POST', headers: { 'content-type': 'application/json', 'x-bridge-secret': process.env.SEC! },
  body: JSON.stringify({ label: 'itest-label' }),
})
const a = await r1.json(); console.log('first:', a)
const r2 = await fetch('http://127.0.0.1:8787/ensure-thread', {
  method: 'POST', headers: { 'content-type': 'application/json', 'x-bridge-secret': process.env.SEC! },
  body: JSON.stringify({ label: 'itest-label' }),
})
const b = await r2.json(); console.log('reuse:', b)
if (a.thread_id !== b.thread_id) throw new Error('reuse must return the same thread_id')
console.log('OK: create then reuse returns same thread_id')
```

- [ ] **Step 3: Run it**

Run: `cd ~/.claude/claph && SEC=$(cat state/daemon.secret) bun ensure-thread.itest.ts`
Expected: `first` and `reuse` print the same `thread_id`; "OK" printed; a topic `🟢 itest-label` appears in the bot. Clean up after: delete that topic manually or via `deleteForumTopic`.

- [ ] **Step 4: Commit**

```bash
cd ~/.claude/claph && git add daemon.ts ensure-thread.itest.ts && git commit -m "feat(threads): daemon /ensure-thread create-or-reuse by label"
```

---

### Task 3: daemon send/edit carry `message_thread_id`

**Files:**
- Modify: `~/.claude/claph/daemon.ts` (`/send`, `/edit` route bodies; `sendToUser`, `deliverClassic`, `editMessage`, `sendMessage` signatures)

**Interfaces:**
- Consumes: existing `sendToUser(handle, text, buttons, reply_to, format)`.
- Produces: same functions with an added optional `threadId?: number` threaded through to grammy calls as `message_thread_id`. `/send` and `/edit` bodies accept `message_thread_id?: number`.

- [ ] **Step 1: Thread `message_thread_id` through the send path**

In `/send` body type add `message_thread_id?: number`; pass it to `sendToUser(..., body.message_thread_id)`. In `sendToUser`/`deliverClassic`/`sendRichMessage`/edit, add the field to the grammy `extra` object:

```ts
// in sendToUser signature add: threadId?: number
const threadExtra = threadId ? { message_thread_id: threadId } : {}
// sendRichMessage:
const sent = await bot.api.sendRichMessage(chatId, { markdown: text }, {
  ...replyExtra, ...threadExtra, ...(kb ? { reply_markup: kb } : {}),
})
// deliverClassic sendMessage: add ...threadExtra to its extra object too
```

For `/edit`: add `message_thread_id?` to the body type and pass to `editMessage(...)`. (Editing a message already in a thread does not strictly need it, but pass for symmetry where grammy accepts it; if grammy rejects it on edit, drop it from edit only.)

- [ ] **Step 2: Verify with a real send into a thread**

Run (daemon up, reuse `itest-label` thread_id from Task 2, e.g. via `/send`):
```bash
cd ~/.claude/claph
TID=$(SEC=$(cat state/daemon.secret) bun -e 'const t=(await (await fetch("http://127.0.0.1:8787/ensure-thread",{method:"POST",headers:{"content-type":"application/json","x-bridge-secret":process.env.SEC},body:JSON.stringify({label:"itest-label"})})).json()).thread_id; console.log(t)')
# register a handle, then /send with message_thread_id: TID, and confirm it lands in the topic (is_topic_message)
```
Expected: message appears inside the `itest-label` topic, not the flat chat.

- [ ] **Step 3: Commit**

```bash
cd ~/.claude/claph && git add daemon.ts && git commit -m "feat(threads): daemon send/edit carry message_thread_id"
```

---

### Task 4: `session-mcp` ensures its thread + forwards thread_id + `rename_thread` tool

**Files:**
- Modify: `~/.claude/claph/session-mcp.ts` (after `register`; in send/edit tool handlers; add tool)

**Interfaces:**
- Consumes: `/ensure-thread` (Task 2), `/send`+`/edit` with `message_thread_id` (Task 3), `/rename-thread` (Task 6).
- Produces: module-level `let threadId: number | undefined`; every `api('/send',…)`/`api('/edit',…)` includes `message_thread_id: threadId`; MCP tool `rename_thread {name: string}`.

- [ ] **Step 1: After register, ensure the thread**

```ts
// after: handle = (await api('/register', { label: LABEL })).handle
let threadId: number | undefined
try {
  const r = await api('/ensure-thread', { label: LABEL })
  threadId = typeof r.thread_id === 'number' ? r.thread_id : undefined
} catch { threadId = undefined } // flat-chat fallback
```

- [ ] **Step 2: Forward threadId in send/edit tool handlers**

In the `send` tool handler: `await api('/send', { handle, ...args, ...(threadId ? { message_thread_id: threadId } : {}) })`. Same for `edit`.

- [ ] **Step 3: Add `rename_thread` tool**

Register a tool `rename_thread` with input `{ name: string }` that calls `await api('/rename-thread', { label: LABEL, name: args.name })` and returns a short confirmation. (Depends on Task 6's route; if implementing out of order, stub returns "not yet".)

- [ ] **Step 4: Verify end-to-end**

Restart one tab; confirm in the bot a topic `🟢 <foldername>` appears and this tab's explicit `send` (with buttons) lands inside that topic. Ask me to call `rename_thread` and confirm the topic renames.

- [ ] **Step 5: Commit**

```bash
cd ~/.claude/claph && git add session-mcp.ts && git commit -m "feat(threads): session-mcp ensures thread + forwards thread_id + rename_thread"
```

---

### Task 5: daemon routes inbound by `message_thread_id`

**Files:**
- Modify: `~/.claude/claph/daemon.ts` (`routeText`)

**Interfaces:**
- Consumes: `readThreads`, `labelKey`, existing `sessions` map, `msgToHandle`.
- Produces: `routeText` first tries `ctx.message.message_thread_id` → find `label` whose record `thread_id` matches → route to the live session whose `LABEL===label`. Falls back to current swipe/ambiguous logic when no thread match.

- [ ] **Step 1: Add thread-first routing at the top of `routeText`'s target resolution**

```ts
// before the swipe-reply block:
const tid = (ctx.message as any)?.message_thread_id as number | undefined
let target: string | undefined
let ambiguous = false
if (tid != null) {
  const threads = readThreads()
  const label = Object.keys(threads).find(k => threads[k].thread_id === tid)
  if (label) {
    for (const [h, s] of sessions) if (s.label === label) { target = h; break }
  }
}
// then existing swipe-reply / lastSendHandle fallback ONLY if target still unset
```

Note: sessions store `label` (from `/register {label}` = `LABEL` = the tab's label). Confirm `Session.label` holds the label key; it does (register passes `label`).

- [ ] **Step 2: Verify**

From the bot, type a message **inside** a tab's topic. Confirm it reaches exactly that tab (not ambiguous), and a message in General still falls back (or is handled per Task 7 of the spec — soft hint; minimal: still routes via fallback, ambiguous flag set).

- [ ] **Step 3: Commit**

```bash
cd ~/.claude/claph && git add daemon.ts && git commit -m "feat(threads): route inbound by message_thread_id -> label -> session"
```

---

### Task 6: daemon `/deregister` sets 💤 + `/rename-thread`

**Files:**
- Modify: `~/.claude/claph/daemon.ts` (`/deregister` block; new `/rename-thread` route)

**Interfaces:**
- Consumes: `readThreads`/`writeThreads`, `editForumTopic`, `sessions`.
- Produces: on `/deregister`, if no other live session shares that label, set its thread record `status='idle'` and rename topic `💤 <label>`. `POST /rename-thread {label, name} -> {ok}` renames via `editForumTopic` and updates the record's `name`.

- [ ] **Step 1: `/deregister` — flip to idle when last tab of the label closes**

```ts
if (path === '/deregister' && req.method === 'POST') {
  const { handle: h } = (await req.json()) as { handle: string }
  const label = sessions.get(h)?.label
  sessions.delete(h)
  if (label && ![...sessions.values()].some(s => s.label === label)) {
    const threads = readThreads(); const rec = threads[label]
    if (rec) {
      rec.status = 'idle'; const nm = `💤 ${label.replace(/^([🟢💤]\s*)/u, '')}`
      try { await bot.api.editForumTopic(loadAllowFrom()[0], rec.thread_id, { name: nm }) } catch {}
      rec.name = nm; threads[label] = rec; writeThreads(threads)
    }
  }
  return json({ ok: true })
}
```

- [ ] **Step 2: `/rename-thread` route**

```ts
if (path === '/rename-thread' && req.method === 'POST') {
  const { label, name } = (await req.json()) as { label: string; name: string }
  const threads = readThreads(); const rec = threads[label]
  if (!rec) return json({ error: 'no thread for label' }, 404)
  const display = `🟢 ${name}`
  try { await bot.api.editForumTopic(loadAllowFrom()[0], rec.thread_id, { name: display }) } catch (e) {
    return json({ error: String(e).slice(0, 120) }, 200)
  }
  rec.name = display; threads[label] = rec; writeThreads(threads)
  return json({ ok: true })
}
```

- [ ] **Step 3: Verify**

Close a tab → its topic renames to `💤 …`. Reopen → back to `🟢 …`. Call `rename_thread` → topic name changes.

- [ ] **Step 4: Commit**

```bash
cd ~/.claude/claph && git add daemon.ts && git commit -m "feat(threads): idle status on deregister + /rename-thread"
```

---

### Task 7: `stop-notify.py` — thread routing + summary/`<details>` + drop LIMIT

**Files:**
- Modify: `~/.claude/claph/stop-notify.py`
- Test: `~/.claude/claph/test_stop_summary.py` (new; pure-function unit test)

**Interfaces:**
- Consumes: `threads.json` (read-only), payload `cwd`+`session_id`.
- Produces:
  - `_label(payload) -> str` = `os.environ.get('CLAPH_LABEL') or basename(payload.get('cwd') or '.')`
  - `_thread_id(label) -> int | None` from `threads.json`
  - `_split_summary(answer) -> tuple[str, str|None]` — (visible summary, details-or-None) per Global Constraints rule
  - `_send(token, chat, text, thread_id)` includes `message_thread_id` when set
  - `LIMIT` removed; rich body is full text (plain fallback still capped at 4096)

- [ ] **Step 1: Write the failing unit test for `_split_summary`**

```python
# test_stop_summary.py
import importlib.util, pathlib
p = pathlib.Path.home()/".claude"/"claph"/"stop-notify.py"
spec = importlib.util.spec_from_file_location("sn", p)
spec.loader.exec_module(sn := importlib.util.module_from_spec(spec))

def test_marker():
    s, d = sn._split_summary("<!-- tg: Готово: X. Дальше Y -->\n## Заголовок\nтело тело")
    assert s == "Готово: X. Дальше Y"
    assert d and "тело тело" in d

def test_short_no_details():
    s, d = sn._split_summary("Короткий ответ.")
    assert s == "Короткий ответ." and d is None

def test_long_first_para_skips_heading():
    body = "## Итог\nПервый абзац суть.\n\nВторой абзац детали."
    s, d = sn._split_summary(body)
    assert s == "Первый абзац суть."
    assert d and "Второй абзац детали." in d

for t in (test_marker, test_short_no_details, test_long_first_para_skips_heading):
    t(); print("ok", t.__name__)
```

- [ ] **Step 2: Run it (fails — `_split_summary` missing)**

Run: `cd ~/.claude/claph && PYTHONUTF8=1 python test_stop_summary.py`
Expected: FAIL (`AttributeError: _split_summary`).

- [ ] **Step 3: Implement**

```python
import os, re
from pathlib import Path

def _label(payload):
    return (os.environ.get("CLAPH_LABEL") or "").strip() or Path(payload.get("cwd") or ".").name

def _thread_id(label):
    try:
        import json
        t = json.loads((TG_DIR.parent / "claph" / "state" / "threads.json").read_text("utf-8"))
    except Exception:
        return None
    rec = t.get(label)
    return rec.get("thread_id") if rec else None

_MARKER = re.compile(r"<!--\s*tg:\s*(.*?)\s*-->", re.S)
SHORT = 600

def _split_summary(answer):
    m = _MARKER.search(answer)
    body = _MARKER.sub("", answer).strip()
    if m:
        return m.group(1).strip(), (body or None)
    if len(body) <= SHORT:
        return body, None
    lines = body.split("\n")
    i = 0
    while i < len(lines) and lines[i].lstrip().startswith("#"):
        i += 1
    # first paragraph after any leading heading
    para = []
    while i < len(lines) and lines[i].strip():
        para.append(lines[i]); i += 1
    summary = " ".join(l.strip() for l in para).strip() or body[:SHORT]
    return summary, body
```

Then in `main()`: compute `label = _label(payload)`, `tid = _thread_id(label)`; build message as `summary` + (details ? `\n\n<details><summary>Подробнее</summary>\n\n{details}\n</details>` : ""); pass `tid` into `_send`. In `_send`, add `message_thread_id` to both the `sendRichMessage` and `sendMessage` bodies when `thread_id` is set. **Delete `LIMIT` and its truncation line.** For the plain fallback path only, cap at 4096.

(Confirm `TG_DIR` path to `threads.json`: it's `~/.claude/claph/state/threads.json`. If `TG_DIR` in the hook points at `~/.claude/channels/telegram`, hardcode `Path.home()/".claude"/"claph"/"state"/"threads.json"` instead of the `.parent` trick above.)

- [ ] **Step 4: Run unit test (passes)**

Run: `cd ~/.claude/claph && PYTHONUTF8=1 python test_stop_summary.py`
Expected: `ok test_marker` / `ok test_short_no_details` / `ok test_long_first_para_skips_heading`.

- [ ] **Step 5: Compile-check + commit**

```bash
cd ~/.claude/claph && python -m py_compile stop-notify.py && git add stop-notify.py test_stop_summary.py && git commit -m "feat(threads): stop-notify routes to thread + summary/<details>, drop LIMIT"
```

---

### Task 8: `progress-notify.py` — thread routing for the progress line

**Files:**
- Modify: `~/.claude/claph/progress-notify.py`

**Interfaces:**
- Consumes: `threads.json`, payload `cwd`; existing `_create_rich`/`_edit_rich`.
- Produces: `_label(payload)` + `_thread_id(label)` (same as Task 7); `_create_rich` includes `message_thread_id` when set; edit inherits the thread from the created message (no change needed for edit body, but pass symmetrically).

- [ ] **Step 1: Add label/thread lookup**

Add `_label` and `_thread_id` (copy from Task 7). In `_handle_tool`, compute `tid = _thread_id(_label(payload))`, and pass into `_create_rich(token, chat, text, tid)`.

- [ ] **Step 2: Thread the id into create**

```python
def _create_rich(token, chat, text, thread_id=None):
    body = {"chat_id": chat, "rich_message": {"markdown": text}, "disable_notification": True}
    if thread_id:
        body["message_thread_id"] = thread_id
    try:
        return _api(token, "sendRichMessage", body)
    except urllib.error.HTTPError:
        pb = {"chat_id": chat, "text": text, "disable_notification": True}
        if thread_id: pb["message_thread_id"] = thread_id
        return _api(token, "sendMessage", pb)
```

Edits target an existing message id, which already lives in the thread — no `message_thread_id` needed on `_edit_rich`.

- [ ] **Step 2b: Verify (real)**

Trigger a multi-tool turn in a tab; confirm the progress line appears **inside that tab's topic** and updates there (bold header), then is deleted on Stop.

- [ ] **Step 3: Compile-check + commit**

```bash
cd ~/.claude/claph && python -m py_compile progress-notify.py && git add progress-notify.py && git commit -m "feat(threads): progress line posts into the tab's thread"
```

---

## Self-Review

**Spec coverage:**
- §1 label-key identification → Task 1 (`labelKey`), Task 2 (ensure), Task 4 (session-mcp), Task 7/8 (`_label`). ✓
- §2 lifecycle + 🟢/💤 status → Task 2 (🟢 on ensure), Task 6 (💤 on deregister). ✓
- §3 bot-only creation → Task 2 (only daemon creates). ✓
- §4 no streaming → not implemented by design (progress+final in thread: Task 7/8). ✓
- §5 inbound routing by thread → Task 5. General soft-hint is the spec's stated behavior; minimal fallback keeps working — **note:** the explicit "soft hint on General" message is NOT built (kept as fallback-ambiguous). Flag to user.
- §6 summary + `<details>`, drop LIMIT → Task 7. ✓
- §7 hooks learn thread_id via threads.json → Task 7/8. ✓
- §8 migration / flat fallback → Global Constraints + every task's "no record → no thread_id" path. ✓

**Placeholder scan:** `rename_thread` tool (Task 4 step 3) depends on Task 6 route — noted with stub guidance. `TG_DIR` path to threads.json flagged in Task 7 step 3 to confirm during implementation. No other TODOs.

**Type consistency:** `ThreadRecord`/`ThreadsFile`/`labelKey`/`readThreads`/`writeThreads` used consistently Tasks 1→2→5→6. `message_thread_id` name consistent across TS and Python. `Session.label` reuse confirmed in Task 5 note.

## Known deferrals (flag to user)

- **General-topic soft hint (spec §5)** — not built; a message typed in General falls back to ambiguous routing as today. Add later if it annoys.
- **Two tabs, same repo, no `CLAPH_LABEL`** — share one thread by design.
- **Commits** assume `~/.claude/claph` is a git repo; if not, skip commit steps (ask user first).
