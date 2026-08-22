#!/usr/bin/env bun
/**
 * claph daemon — the single, shared process.
 *
 * Owns the one getUpdates poller Telegram allows per token, and exposes a
 * loopback HTTP API so any number of Claude Code sessions (session-mcp
 * instances) can send messages/buttons and receive their own inbound events.
 *
 * Routing is the whole point:
 *  - button taps carry the originating session's `handle` in callback_data,
 *    so a tap always returns to the exact session that sent the button.
 *  - free text is routed by swipe-reply: the daemon remembers which session
 *    sent each message; a reply to it goes back to that session. Text with no
 *    reply falls back to the most-recently-active session, flagged ambiguous.
 */

import { Bot, GrammyError, InlineKeyboard, InputFile } from 'grammy'
import type { Context } from 'grammy'
import type { ReactionTypeEmoji } from 'grammy/types'
import { readFileSync, writeFileSync, rmSync, mkdirSync } from 'fs'
import { join } from 'path'
import { toMarkdownV2 } from './format.ts'
import {
  loadToken, loadAllowFrom, loadEnvValue, ensureSecret,
  chunk, CALLBACK_MAX, CHUNK_LIMIT,
  HOST, PORT, DAEMON_PID, INBOX_DIR, STATE_DIR,
  readThreads, writeThreads, baseName,
  type PollEvent, type Button,
} from './shared.ts'

const TOKEN = loadToken()
const SECRET = ensureSecret()
const bot = new Bot(TOKEN)

// --- session registry -----------------------------------------------------

type Session = {
  handle: string
  label: string
  /** A subagent or background job, not the tab the user is typing in. */
  child: boolean
  lastActive: number
  queue: PollEvent[]
  waiter: ((e: PollEvent) => void) | null
}
const sessions = new Map<string, Session>()
let handleSeq = 0
let lastSendHandle: string | null = null
let polling = false
let lastPollError = ''

// Ring buffer of recent inbound events for /debug — locates where delivery breaks.
const recentInbound: Array<Record<string, unknown>> = []
function logInbound(e: Record<string, unknown>): void {
  recentInbound.unshift({ ts: new Date().toISOString(), ...e })
  if (recentInbound.length > 30) recentInbound.length = 30
}

const SESSION_TTL = 70_000 // reap a session this long without /poll or /send
const STT_MAX_BYTES = 25 * 1024 * 1024 // OpenAI's upload cap; a voice note is ~1MB/10min

function newHandle(): string {
  // Short base36 handle keeps callback_data well under Telegram's 64-byte cap.
  return `h${(handleSeq++).toString(36)}`
}

function push(s: Session, ev: PollEvent): void {
  s.lastActive = Date.now()
  if (s.waiter) {
    const w = s.waiter
    s.waiter = null
    w(ev)
  } else {
    s.queue.push(ev)
  }
}

/** Who receives a message typed in this label's topic. One busy tab registers
 *  many sessions — every subagent and background job spawns its own MCP server
 *  and inherits the tab's label — and picking the first by registration order
 *  handed the user's message to a background job that would never answer it.
 *  Prefer the real tab; among equals the most recently active one. */
function pickForLabel(label: string): string | undefined {
  const mine = [...sessions.values()].filter(s => s.label === label)
  const primary = mine.filter(s => !s.child)
  const pool = primary.length ? primary : mine // all children -> best effort
  return pool.sort((a, b) => b.lastActive - a.lastActive)[0]?.handle
}

/** Flip the tab's topic to 💤, but only once its LAST session is gone (another
 *  tab with the same label keeps it active). Both ways a session can end —
 *  clean /deregister and silent reap — must route through here, else a tab that
 *  died without shutting down (crash, killed window, sleep) stays 🟢 forever. */
async function markIdle(label: string): Promise<void> {
  if ([...sessions.values()].some(s => s.label === label)) return
  const rec = readThreads()[label]
  if (!rec || rec.status === 'idle') return
  const nm = `💤 ${baseName(rec.name, label)}`
  try { await bot.api.editForumTopic(loadAllowFrom()[0], rec.thread_id, { name: nm }) } catch {}
  const fresh = readThreads() // re-read after the await, then merge
  if (fresh[label]) { fresh[label].status = 'idle'; fresh[label].name = nm; writeThreads(fresh) }
}

// Reap dead sessions so taps on their buttons report "session closed".
setInterval(() => {
  const now = Date.now()
  for (const [h, s] of sessions) {
    if (now - s.lastActive > SESSION_TTL) {
      if (s.waiter) { const w = s.waiter; s.waiter = null; w({ type: 'idle' }) }
      sessions.delete(h)
      void markIdle(s.label)
    }
  }
}, 30_000).unref()

// --- outbound bookkeeping -------------------------------------------------

// message_id -> handle that sent it (for swipe-reply routing).
const msgToHandle = new Map<string, string>()
// message_id -> {key: label} (to show a human label when a button is tapped).
const buttonLabels = new Map<string, Record<string, string>>()

function trim(m: Map<string, unknown>, cap = 2000): void {
  while (m.size > cap) {
    const first = m.keys().next().value
    if (first === undefined) break
    m.delete(first)
  }
}

function buildKeyboard(handle: string, buttons: Button[]): InlineKeyboard {
  const kb = new InlineKeyboard()
  buttons.forEach((b, i) => {
    const data = `${handle}|${b.key}`
    if (b.key.includes('|')) throw new Error(`button key must not contain '|': ${b.key}`)
    if (Buffer.byteLength(data) > CALLBACK_MAX) throw new Error(`callback_data too long (>${CALLBACK_MAX}B): ${data}`)
    kb.text(b.label, data)
    if (i % 2 === 1) kb.row() // two buttons per row
  })
  return kb
}

// --- topics ---------------------------------------------------------------

/** Create-or-reuse the forum topic for a tab label; undefined when the Bot API
 *  refuses (Threaded Mode off, not a forum) so callers fall back to flat chat.
 *  The daemon is the only writer of threads.json, so allocation lives here — and
 *  the hooks reach it through /notify, which needs a topic of its own the first
 *  time a label appears (a hook can fire before the tab's session-mcp starts).
 *
 *  `title` is the session's display name. The label is the session's id and never
 *  moves, so renaming a session in the harness renames THIS topic instead of
 *  forking a second one. A tab with no session name passes none, and the stored
 *  name — including one set by hand via /rename-thread — is left alone. */
async function ensureThread(label: string, title?: string): Promise<number | undefined> {
  const wanted = (title ?? '').trim()
  const threads = readThreads()
  const existing = threads[label]
  if (existing) {
    // 🟢 covers both the wake from 💤 and a rename; one comparison decides both.
    const display = `🟢 ${wanted || baseName(existing.name, label)}`
    const changed = display !== existing.name
    existing.status = 'active'; existing.ts = Date.now(); existing.name = display
    threads[label] = existing; writeThreads(threads)
    if (changed) {
      try { await bot.api.editForumTopic(loadAllowFrom()[0], existing.thread_id, { name: display }) } catch {}
    }
    return existing.thread_id
  }
  const chat = loadAllowFrom()[0]
  if (!chat) return undefined
  const name = `🟢 ${wanted || label}`
  try {
    const topic = await bot.api.createForumTopic(chat, name)
    // Re-read after the await: another ensureThread (different label) may have
    // written during it; merging into a stale snapshot would clobber that label.
    const fresh = readThreads()
    fresh[label] = { thread_id: topic.message_thread_id, name, status: 'active', ts: Date.now() }
    writeThreads(fresh)
    return topic.message_thread_id
  } catch (err) {
    logInbound({ kind: 'ensure-thread:fail', label, error: String(err).slice(0, 140) })
    return undefined
  }
}

// --- live progress bar ----------------------------------------------------
// ONE line per tab. The PostToolUse hook fires in the tab, in every subagent and
// in every workflow agent — separate processes with separate session ids — and
// keying the line by session id painted a separate bar for each, several of them
// side by side in the same topic. Keyed by LABEL and owned by the daemon (the one
// process that talks to Telegram) it is a single message every agent under the tab
// advances, and there is no cross-process race left to lose.

type Bar = {
  ids: Record<string, string>
  started: number
  count: number
  lastEdit: number
  /** A create is in flight; a concurrent tick must not start a second one. */
  creating: boolean
}
// Persisted, because a daemon restart mid-turn would otherwise orphan every live
// line: the ids are lost, the next tool call paints a SECOND bar and the first one
// sits there claiming work forever. Daemon-only writer, so no locking needed.
const BARS_FILE = join(STATE_DIR, 'bars.json')

function loadBars(): Map<string, Bar> {
  try {
    return new Map(Object.entries(JSON.parse(readFileSync(BARS_FILE, 'utf8')) as Record<string, Bar>))
  } catch {
    return new Map() // missing or corrupt -> start clean; a bar is never worth a crash
  }
}

function saveBars(): void {
  try {
    writeFileSync(BARS_FILE, JSON.stringify(Object.fromEntries(bars)), { mode: 0o600 })
  } catch {}
}

const bars = loadBars()

const BAR_CELLS = 10         // a PULSE, not a percentage: total steps are unknowable
const BAR_THROTTLE = 3_000   // Telegram throttles editMessageText below this
const BAR_WARMUP_TOOLS = 3   // don't paint before this many tools...
const BAR_WARMUP_MS = 10_000 // ...unless the turn has already run this long

const pad2 = (n: number) => String(n).padStart(2, '0')

function composeBar(label: string, tool: string, hint: string, b: Bar): string {
  const elapsed = Math.max(0, Math.floor((Date.now() - b.started) / 1000))
  let h = hint.trim().replace(/\s+/g, ' ')
  if (h.length > 70) h = h.slice(0, 70).trimEnd() + '…'
  const filled = ((b.count - 1) % BAR_CELLS) + 1
  const cells = '▰'.repeat(filled) + '▱'.repeat(BAR_CELLS - filled)
  const now = new Date()
  return `### ${label}\n\n\`${cells}\`\n\n> \`${tool}\` · ${h}\n\n` +
    `**шаг ${b.count}**\n` +
    `таймер ${Math.floor(elapsed / 60)}:${pad2(elapsed % 60)}\n` +
    `обновлено ${pad2(now.getHours())}:${pad2(now.getMinutes())}:${pad2(now.getSeconds())}`
}

/** One tick of a tab's live line: create it, edit it, or clear it. */
async function liveBar(
  body: { bar?: string; clear?: boolean; tool?: string; hint?: string; title?: string },
): Promise<{ ok: boolean }> {
  const label = body.bar!
  if (body.clear) {
    const b = bars.get(label)
    bars.delete(label)
    saveBars()
    for (const [chat, mid] of Object.entries(b?.ids ?? {})) {
      await bot.api.deleteMessage(chat, Number(mid)).catch(() => {}) // already gone is fine
    }
    return { ok: true }
  }
  const now = Date.now()
  const b = bars.get(label) ?? { ids: {}, started: now, count: 0, lastEdit: 0, creating: false }
  bars.set(label, b)
  b.count++
  saveBars()
  if (b.creating) return { ok: true }
  const live = Object.keys(b.ids).length > 0
  // Quiet until the turn has some heft, so a two-tool answer never flashes a line.
  if (!live && b.count < BAR_WARMUP_TOOLS && now - b.started < BAR_WARMUP_MS) return { ok: true }
  if (live && now - b.lastEdit < BAR_THROTTLE) return { ok: true }
  b.lastEdit = now
  const text = composeBar((body.title ?? '').trim() || label, body.tool ?? '?', body.hint ?? '', b)
  if (live) {
    for (const [chat, mid] of Object.entries(b.ids)) {
      await editMessage(chat, Number(mid), text, 'markdown', undefined)
    }
    return { ok: true }
  }
  b.creating = true
  try {
    const threadId = await ensureThread(label, body.title)
    for (const chat of loadAllowFrom()) {
      const sent = await deliverToChat(chat, text, 'markdown', undefined, undefined, threadId, true)
      const last = sent[sent.length - 1]
      if (last) b.ids[chat] = last
    }
  } finally {
    b.creating = false
    saveBars()
  }
  return { ok: true }
}

// --- HTTP API (loopback only, secret-gated) -------------------------------

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

async function handle(req: Request): Promise<Response> {
  const url = new URL(req.url)
  const path = url.pathname

  if (path === '/health') return json({ ok: true, sessions: sessions.size, polling, lastPollError })

  if (req.headers.get('x-bridge-secret') !== SECRET) return json({ error: 'unauthorized' }, 401)

  if (path === '/debug') return json({
    polling, lastPollError, lastSendHandle,
    sessions: [...sessions.values()].map(s => ({
      handle: s.handle, label: s.label, child: s.child, queueLen: s.queue.length, waiting: !!s.waiter,
      ageMs: Date.now() - s.lastActive, routed: pickForLabel(s.label) === s.handle,
    })),
    bars: [...bars.entries()].map(([label, b]) => ({
      label, ids: b.ids, count: b.count, ageMs: Date.now() - b.started,
    })),
    recentInbound,
  })

  // Test-only: inject an event straight into a session's queue to verify
  // routing isolation without touching Telegram. Off unless CLAPH_TEST=1.
  if (process.env.CLAPH_TEST === '1' && path === '/test/push' && req.method === 'POST') {
    const { handle: h, event } = (await req.json()) as { handle: string; event: PollEvent }
    const s = sessions.get(h)
    if (!s) return json({ error: 'unknown handle' }, 404)
    push(s, event)
    return json({ ok: true })
  }

  try {
    if (path === '/register' && req.method === 'POST') {
      const { label, child } = (await req.json()) as { label?: string; child?: boolean }
      const h = newHandle()
      sessions.set(h, { handle: h, label: label ?? h, child: !!child, lastActive: Date.now(), queue: [], waiter: null })
      process.stderr.write(`register ${h} (${label ?? '-'})\n`)
      return json({ handle: h })
    }

    if (path === '/deregister' && req.method === 'POST') {
      // `reconnecting`: the session is only swapping handles (daemon restart),
      // so drop the old one but leave the topic 🟢 — flipping it to 💤 here just
      // makes the name flicker, /ensure-thread flips it right back.
      const { handle: h, reconnecting } = (await req.json()) as { handle: string; reconnecting?: boolean }
      const label = sessions.get(h)?.label
      sessions.delete(h)
      if (label && !reconnecting) await markIdle(label) // history stays; nothing deleted
      return json({ ok: true })
    }

    if (path === '/rename-thread' && req.method === 'POST') {
      // Cosmetic: rename the topic's DISPLAY name; the threads.json key (= label)
      // stays fixed so routing by thread_id is unaffected.
      const { label, name } = (await req.json()) as { label: string; name: string }
      const rec = readThreads()[label]
      if (!rec) return json({ error: 'no thread for label' }, 404)
      const display = `🟢 ${name}`
      try {
        await bot.api.editForumTopic(loadAllowFrom()[0], rec.thread_id, { name: display })
      } catch (e) {
        return json({ error: String(e).slice(0, 120) }, 200)
      }
      const fresh = readThreads() // re-read after the await, then merge
      if (fresh[label]) { fresh[label].name = display; writeThreads(fresh) }
      return json({ ok: true })
    }

    if (path === '/ensure-thread' && req.method === 'POST') {
      // session-mcp calls this once on startup; the work lives in ensureThread so
      // the hooks' /notify can allocate the same topic without duplicating it.
      const { label, title } = (await req.json()) as { label: string; title?: string }
      const tid = await ensureThread(label, title)
      return tid === undefined ? json({ error: 'thread unavailable' }, 200) : json({ thread_id: tid })
    }

    if (path === '/notify' && req.method === 'POST') {
      // Handle-free send for the Python hooks (stop-notify / progress-notify).
      // They used to open their OWN connection to api.telegram.org, which is a
      // second transport with its own token, retries and thread lookup — and the
      // one that DPI actually blocks here, while the daemon's connection works.
      // Addressed by label, not handle: hooks live outside any session process.
      // create: {label, text} -> {ids: {chat: message_id}}
      // edit:   {label, text, ids}      delete: {ids, delete: true}
      // bar:   {bar: label, tool, hint} -> the tab's ONE live line (see liveBar)
      //        {bar: label, clear: true}  -> remove it
      const body = (await req.json()) as {
        label?: string; text?: string; ids?: Record<string, number>
        delete?: boolean; silent?: boolean; format?: Fmt
        bar?: string; clear?: boolean; tool?: string; hint?: string; title?: string
      }
      if (body.bar) return json(await liveBar(body))
      const threadId = body.label ? await ensureThread(body.label, body.title) : undefined
      if (body.delete) {
        for (const [chat, mid] of Object.entries(body.ids ?? {})) {
          await bot.api.deleteMessage(chat, mid).catch(() => {}) // already gone is fine
        }
        return json({ ok: true })
      }
      if (!body.text) return json({ error: 'text required' }, 400)
      if (body.ids && Object.keys(body.ids).length) {
        for (const [chat, mid] of Object.entries(body.ids)) {
          await editMessage(chat, mid, body.text, body.format ?? 'markdown', undefined)
        }
        return json({ ok: true })
      }
      const ids: Record<string, string> = {}
      for (const chat of loadAllowFrom()) {
        const sent = await deliverToChat(chat, body.text, body.format ?? 'markdown', undefined, undefined, threadId, body.silent)
        const last = sent[sent.length - 1] // rich = one message; classic = last chunk
        if (last) ids[chat] = last
      }
      // A hook's message carries the turn's answer, so it is the one the user
      // swipe-replies to. Unregistered, that reply matched no session and fell
      // through to "whichever tab spoke last" — the feedback landed elsewhere.
      const owner = body.label ? pickForLabel(body.label) : undefined
      if (owner) for (const id of Object.values(ids)) msgToHandle.set(id, owner)
      trim(msgToHandle)
      return json({ ids })
    }

    if (path === '/poll') {
      const h = url.searchParams.get('handle') ?? ''
      const s = sessions.get(h)
      if (!s) return json({ error: 'unknown handle' }, 404)
      s.lastActive = Date.now()
      const queued = s.queue.shift()
      if (queued) return json(queued)
      return await new Promise<Response>(resolve => {
        const to = setTimeout(() => { s.waiter = null; resolve(json({ type: 'idle' })) }, 25_000)
        s.waiter = ev => { clearTimeout(to); resolve(json(ev)) }
      })
    }

    if (path === '/send' && req.method === 'POST') {
      const body = (await req.json()) as {
        handle: string; text: string; buttons?: Button[]; reply_to?: string
        format?: 'text' | 'markdown' | 'markdownv2' | 'rich'; message_thread_id?: number
      }
      const s = sessions.get(body.handle)
      if (!s) return json({ error: 'unknown handle' }, 404)
      s.lastActive = Date.now()
      lastSendHandle = body.handle
      // Default to rich: forgetting format='markdown' is easy and shipped raw markdown
      // to the user twice. Rich falls back to MarkdownV2/plain on reject, so this is safe.
      // Explicit format='text' still sends plain.
      const fmt = body.format ?? 'markdown'
      const ids = await sendToUser(body.handle, body.text, body.buttons, body.reply_to, fmt, body.message_thread_id)
      return json({ message_ids: ids })
    }

    if (path === '/send-photo' && req.method === 'POST') {
      // Send a local image (e.g. a screenshot) to Telegram. `path` is a file on
      // THIS machine — daemon and session-mcp are co-located, so a path is enough,
      // no upload dance. Lands in the tab's thread when message_thread_id is given.
      const body = (await req.json()) as {
        handle: string; path: string; caption?: string; message_thread_id?: number
      }
      const s = sessions.get(body.handle)
      if (!s) return json({ error: 'unknown handle' }, 404)
      // Only image files: `path` comes from the model and could otherwise be steered
      // (prompt injection) to exfil a secret/token file into the chat. Loopback +
      // secret already scope this to the owner, but keep the surface an image.
      if (!/\.(png|jpe?g|webp|gif)$/i.test(body.path)) {
        return json({ error: 'send-photo: only image files (.png/.jpg/.jpeg/.webp/.gif)' }, 400)
      }
      s.lastActive = Date.now()
      const threadExtra = body.message_thread_id ? { message_thread_id: body.message_thread_id } : {}
      const ids: string[] = []
      for (const chatId of loadAllowFrom()) {
        const sent = await bot.api.sendPhoto(chatId, new InputFile(body.path), {
          ...(body.caption ? { caption: body.caption } : {}), ...threadExtra,
        })
        ids.push(String(sent.message_id))
        msgToHandle.set(String(sent.message_id), body.handle)
      }
      trim(msgToHandle)
      return json({ message_ids: ids })
    }

    if (path === '/send-album' && req.method === 'POST') {
      // A photo collage: 2..10 local images as one Telegram album (sendMediaGroup),
      // caption on the first. Same co-located-path model as /send-photo.
      const body = (await req.json()) as {
        handle: string; paths: string[]; caption?: string; message_thread_id?: number
      }
      const s = sessions.get(body.handle)
      if (!s) return json({ error: 'unknown handle' }, 404)
      const paths = (body.paths || []).filter(p => /\.(png|jpe?g|webp|gif)$/i.test(p))
      if (paths.length < 2 || paths.length > 10) {
        return json({ error: 'send-album: 2..10 image files required' }, 400)
      }
      s.lastActive = Date.now()
      const threadExtra = body.message_thread_id ? { message_thread_id: body.message_thread_id } : {}
      const media = paths.map((p, i) => ({
        type: 'photo' as const,
        media: new InputFile(p),
        ...(i === 0 && body.caption ? { caption: body.caption } : {}),
      }))
      const ids: string[] = []
      for (const chatId of loadAllowFrom()) {
        const sent = await bot.api.sendMediaGroup(chatId, media, threadExtra)
        for (const m of sent) { ids.push(String(m.message_id)); msgToHandle.set(String(m.message_id), body.handle) }
      }
      trim(msgToHandle)
      return json({ message_ids: ids })
    }

    if (path === '/edit' && req.method === 'POST') {
      const body = (await req.json()) as {
        handle: string; message_id: string; text: string; buttons?: Button[]
        format?: 'text' | 'markdown' | 'markdownv2' | 'rich'
      }
      const kb = body.buttons?.length ? buildKeyboard(body.handle, body.buttons) : undefined
      const fmt = body.format ?? 'markdown' // same rich-by-default as /send
      for (const chatId of loadAllowFrom()) {
        await editMessage(chatId, Number(body.message_id), body.text, fmt, kb)
      }
      if (body.buttons?.length) {
        buttonLabels.set(body.message_id, Object.fromEntries(body.buttons.map(b => [b.key, b.label])))
        trim(buttonLabels)
      }
      return json({ ok: true })
    }

    if (path === '/react' && req.method === 'POST') {
      const body = (await req.json()) as { handle: string; message_id: string; emoji: string }
      for (const chatId of loadAllowFrom()) {
        await bot.api.setMessageReaction(chatId, Number(body.message_id), [
          { type: 'emoji', emoji: body.emoji as ReactionTypeEmoji['emoji'] },
        ]).catch(() => {})
      }
      return json({ ok: true })
    }

    if (path === '/permission' && req.method === 'POST') {
      const body = (await req.json()) as {
        handle: string; request_id: string; tool_name: string; description: string; input_preview: string
      }
      const s = sessions.get(body.handle)
      if (!s) return json({ error: 'unknown handle' }, 404)
      s.lastActive = Date.now()
      const preview = body.input_preview.length > 300 ? body.input_preview.slice(0, 300) + '…' : body.input_preview
      const text = `🔐 [${s.label}] ${body.tool_name}\n${body.description}\n\n${preview}`
      const kb = new InlineKeyboard()
        .text('✅ Разрешить', `${body.handle}|perm:allow:${body.request_id}`)
        .text('❌ Отклонить', `${body.handle}|perm:deny:${body.request_id}`)
      // Into the tab's topic, like every other message. Without the thread id
      // the prompt lands in the forum's General topic — invisible to a user who
      // is watching the tab, so the request just looks like it never arrived.
      const threadId = readThreads()[s.label]?.thread_id
      const extra = { reply_markup: kb, ...(threadId ? { message_thread_id: threadId } : {}) }
      for (const chatId of loadAllowFrom()) {
        try {
          await bot.api.sendMessage(chatId, text, extra)
        } catch (err) {
          // A stale topic must not swallow a permission prompt: retry flat.
          logInbound({ kind: 'permission:thread-drop', error: String(err).slice(0, 140) })
          await bot.api.sendMessage(chatId, text, { reply_markup: kb }).catch(() => {})
        }
      }
      return json({ ok: true })
    }

    return json({ error: 'not found' }, 404)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return json({ error: msg }, 500)
  }
}

type Fmt = 'text' | 'markdown' | 'markdownv2' | 'rich'
const isRich = (f?: Fmt) => f === 'markdown' || f === 'rich'

// Send one chunk, degrading gracefully: a MarkdownV2 parse error (a stray entity
// left by chunking a long body) would 400 the whole send, so on failure we resend
// the same chunk as plain text — the user always gets the message, formatted when
// the markup is valid.
async function sendChunk(
  chatId: string, text: string, parse_mode: 'MarkdownV2' | undefined,
  extra: Record<string, unknown>,
): Promise<string> {
  try {
    const sent = await bot.api.sendMessage(chatId, text, { ...(parse_mode ? { parse_mode } : {}), ...extra })
    return String(sent.message_id)
  } catch (err) {
    if (parse_mode && err instanceof GrammyError && err.error_code === 400) {
      const sent = await bot.api.sendMessage(chatId, text, extra) // plain-text fallback
      return String(sent.message_id)
    }
    throw err
  }
}

// Classic (non-rich) send: chunk to Telegram's 4096 limit, reply on the first
// chunk, buttons on the last. Returns message ids in order.
async function deliverClassic(
  chatId: string, text: string, parse_mode: 'MarkdownV2' | undefined,
  kb: InlineKeyboard | undefined, replyExtra: Record<string, unknown>,
  threadExtra: Record<string, unknown> = {},
): Promise<string[]> {
  const chunks = chunk(text, CHUNK_LIMIT)
  const ids: string[] = []
  for (let i = 0; i < chunks.length; i++) {
    const isLast = i === chunks.length - 1
    ids.push(await sendChunk(chatId, chunks[i], parse_mode, {
      ...threadExtra, // every chunk must carry the thread id, not just the first
      ...(i === 0 ? replyExtra : {}),
      ...(isLast && kb ? { reply_markup: kb } : {}),
    }))
  }
  return ids
}

// One chat's delivery. Rich (`markdown`/`rich`) goes as a NATIVE rich message —
// real headings/tables/collapsible blocks that modern clients render, up to 32768
// chars in ONE call (no chunking). If the server rejects it, degrade to classic
// MarkdownV2 (still formatted) and finally plain — the message always lands.
async function deliverToChat(
  chatId: string, text: string, format: Fmt | undefined,
  kb: InlineKeyboard | undefined, reply_to?: string, threadId?: number,
  silent?: boolean,
): Promise<string[]> {
  const replyExtra = reply_to ? { reply_parameters: { message_id: Number(reply_to) } } : {}
  // `silent` rides along with the thread id: a progress line that buzzes the
  // phone on every tool call is worse than no progress line at all.
  const threadExtra = {
    ...(threadId ? { message_thread_id: threadId } : {}),
    ...(silent ? { disable_notification: true } : {}),
  }
  // Last resort: plain send with NO thread id. A deleted/stale topic makes every
  // threaded attempt 400 «message thread not found»; without this the whole send
  // would throw and the tab goes silently dead. Falling back to the flat chat
  // guarantees delivery instead of losing it.
  const flatFallback = () =>
    deliverClassic(chatId, text, undefined, kb, replyExtra, silent ? { disable_notification: true } : {})
  if (isRich(format)) {
    try {
      const sent = await bot.api.sendRichMessage(chatId, { markdown: text }, {
        ...replyExtra, ...threadExtra, ...(kb ? { reply_markup: kb } : {}),
      })
      return [String(sent.message_id)]
    } catch (err) {
      logInbound({ kind: 'rich:fallback', error: String(err).slice(0, 140) })
      try {
        return await deliverClassic(chatId, toMarkdownV2(text), 'MarkdownV2', kb, replyExtra, threadExtra)
      } catch (err2) {
        logInbound({ kind: 'thread:drop', error: String(err2).slice(0, 140) })
        return flatFallback()
      }
    }
  }
  const parse_mode = format === 'markdownv2' ? ('MarkdownV2' as const) : undefined
  try {
    return await deliverClassic(chatId, text, parse_mode, kb, replyExtra, threadExtra)
  } catch {
    return flatFallback()
  }
}

// Edit in place, mirroring send's rich-first-with-fallback. Used for streaming
// progress (send once, edit as work advances). A "not modified" 400 (identical
// text re-sent) is benign and swallowed.
async function editMessage(
  chatId: string, messageId: number, text: string, format: Fmt | undefined,
  kb: InlineKeyboard | undefined,
): Promise<void> {
  const extra = kb ? { reply_markup: kb } : {}
  const notModified = (e: unknown) => e instanceof GrammyError && e.description.includes('not modified')
  if (isRich(format)) {
    try {
      await bot.api.editMessageText(chatId, messageId, { markdown: text }, extra)
    } catch (err) {
      if (notModified(err)) return
      await bot.api.editMessageText(chatId, messageId, toMarkdownV2(text), { parse_mode: 'MarkdownV2', ...extra })
        .catch(() => bot.api.editMessageText(chatId, messageId, text, extra).catch(() => {}))
    }
    return
  }
  const parse_mode = format === 'markdownv2' ? ('MarkdownV2' as const) : undefined
  try {
    await bot.api.editMessageText(chatId, messageId, text, { ...(parse_mode ? { parse_mode } : {}), ...extra })
  } catch (err) {
    if (notModified(err)) return
    if (parse_mode && err instanceof GrammyError && err.error_code === 400) {
      await bot.api.editMessageText(chatId, messageId, text, extra).catch(() => {}) // plain fallback
    }
    // A transient edit failure must not crash the caller mid-stream.
  }
}

async function sendToUser(
  handle: string, text: string, buttons?: Button[], reply_to?: string,
  format?: Fmt, threadId?: number,
): Promise<string[]> {
  const kb = buttons?.length ? buildKeyboard(handle, buttons) : undefined
  const ids: string[] = []
  for (const chatId of loadAllowFrom()) {
    const chatIds = await deliverToChat(chatId, text, format, kb, reply_to, threadId)
    for (const id of chatIds) msgToHandle.set(id, handle)
    const last = chatIds[chatIds.length - 1]
    if (last && buttons?.length) {
      buttonLabels.set(last, Object.fromEntries(buttons.map(b => [b.key, b.label])))
    }
    ids.push(...chatIds)
  }
  trim(msgToHandle)
  trim(buttonLabels)
  return ids
}

// --- Telegram inbound -----------------------------------------------------

bot.on('callback_query:data', async ctx => {
  const data = ctx.callbackQuery.data
  const sep = data.indexOf('|')
  const h = sep >= 0 ? data.slice(0, sep) : ''
  const rest = sep >= 0 ? data.slice(sep + 1) : ''
  logInbound({ kind: 'callback:received', data, from: String(ctx.from.id) })

  if (!loadAllowFrom().includes(String(ctx.from.id))) {
    await ctx.answerCallbackQuery({ text: 'Не авторизовано.' }).catch(() => {})
    return
  }
  const s = sessions.get(h)
  if (!s) {
    logInbound({ kind: 'callback:no-session', handle: h, knownSessions: [...sessions.keys()] })
    await ctx.answerCallbackQuery({ text: 'Сессия закрыта.' }).catch(() => {})
    await ctx.editMessageReplyMarkup().catch(() => {}) // strip stale buttons
    return
  }
  logInbound({ kind: 'callback:routed', handle: h, rest })

  const msgId = ctx.callbackQuery.message?.message_id
  const permMatch = /^perm:(allow|deny):(.+)$/.exec(rest)
  if (permMatch) {
    push(s, { type: 'permission', request_id: permMatch[2], behavior: permMatch[1] as 'allow' | 'deny' })
    const label = permMatch[1] === 'allow' ? '✅ Разрешено' : '❌ Отклонено'
    await ctx.answerCallbackQuery({ text: label }).catch(() => {})
    await lockChoice(ctx, label)
    return
  }

  const label = (msgId != null && buttonLabels.get(String(msgId))?.[rest]) || rest
  push(s, {
    type: 'button',
    key: rest,
    label,
    message_id: String(msgId ?? ''),
    chat_id: String(ctx.callbackQuery.message?.chat.id ?? ctx.from.id),
    user: ctx.from.username ?? String(ctx.from.id),
    user_id: String(ctx.from.id),
    ts: new Date().toISOString(),
  })
  await ctx.answerCallbackQuery({ text: `→ ${label}` }).catch(() => {})
  await lockChoice(ctx, `→ ${label}`)
})

// Append the chosen outcome and remove the keyboard so a choice is final.
async function lockChoice(ctx: Context, outcome: string): Promise<void> {
  const msg = ctx.callbackQuery?.message
  if (msg && 'text' in msg && msg.text) {
    await ctx.editMessageText(`${msg.text}\n\n${outcome}`).catch(() => {})
  } else {
    await ctx.editMessageReplyMarkup().catch(() => {})
  }
}

bot.on('message:text', async ctx => routeText(ctx, ctx.message.text, undefined))

/** Pull a Telegram file into the inbox and return its local path. */
async function fetchToInbox(ctx: Context, fileId: string, uniqueId: string, fallbackExt: string) {
  const file = await ctx.api.getFile(fileId)
  if (!file.file_path) return undefined
  const res = await fetch(`https://api.telegram.org/file/bot${TOKEN}/${file.file_path}`)
  const buf = Buffer.from(await res.arrayBuffer())
  const ext = file.file_path.includes('.') ? file.file_path.split('.').pop()! : fallbackExt
  const path = join(INBOX_DIR, `${Date.now()}-${uniqueId}.${ext}`)
  mkdirSync(INBOX_DIR, { recursive: true })
  writeFileSync(path, buf)
  return path
}

bot.on('message:photo', async ctx => {
  const caption = ctx.message.caption ?? '(photo)'
  const best = ctx.message.photo[ctx.message.photo.length - 1]
  await routeText(ctx, caption, async () => {
    try { return await fetchToInbox(ctx, best.file_id, best.file_unique_id, 'jpg') }
    catch { return undefined }
  })
})

// Voice notes / audio: Claude reads text, not sound, so a voice message only
// becomes usable once transcribed. Without STT configured they used to be
// dropped ENTIRELY (no handler at all) — the user spoke and nothing arrived.
bot.on(['message:voice', 'message:audio', 'message:video_note'], async ctx => {
  const media = ctx.message.voice ?? ctx.message.audio ?? ctx.message.video_note
  if (!media) return
  const caption = ctx.message.caption?.trim()
  let text = '🎤 (голосовое)'
  try {
    if ((media.file_size ?? 0) > STT_MAX_BYTES) throw new Error('файл больше 25 МБ')
    const path = await fetchToInbox(ctx, media.file_id, media.file_unique_id, 'ogg')
    if (!path) throw new Error('не скачалось')
    const said = (await transcribe(path)).trim()
    text = said ? `🎤 ${said}` : '🎤 (голосовое: тишина)'
  } catch (err) {
    const why = String(err instanceof Error ? err.message : err).slice(0, 120)
    logInbound({ kind: 'voice:failed', error: why })
    text = `🎤 (голосовое, расшифровать не удалось: ${why})`
  }
  await routeText(ctx, caption ? `${text}\n\n${caption}` : text, undefined)
})

/** Transcribe via any OpenAI-compatible /audio/transcriptions endpoint.
 *  Configured in the same channels/.env that holds the bot token:
 *    STT_API_KEY=...   STT_BASE_URL=https://api.openai.com/v1   STT_MODEL=whisper-1 */
async function transcribe(path: string): Promise<string> {
  const key = loadEnvValue('STT_API_KEY')
  if (!key) throw new Error('STT_API_KEY не задан в channels/telegram/.env')
  const base = (loadEnvValue('STT_BASE_URL') ?? 'https://api.openai.com/v1').replace(/\/$/, '')
  const form = new FormData()
  // Force the .ogg name: Telegram serves voice notes as `.oga`, which some STT
  // backends reject on extension alone even though the bytes are plain Ogg/Opus.
  form.append('file', Bun.file(path), 'voice.ogg')
  form.append('model', loadEnvValue('STT_MODEL') ?? 'whisper-1')
  form.append('language', loadEnvValue('STT_LANGUAGE') ?? 'ru')
  const res = await fetch(`${base}/audio/transcriptions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${key}` },
    body: form,
    signal: AbortSignal.timeout(90_000),
  })
  if (!res.ok) throw new Error(`STT ${res.status}: ${(await res.text()).slice(0, 100)}`)
  return ((await res.json()) as { text?: string }).text ?? ''
}

async function routeText(
  ctx: Context, text: string, downloadImage: (() => Promise<string | undefined>) | undefined,
): Promise<void> {
  if (!ctx.from || ctx.chat?.type !== 'private') return
  logInbound({ kind: 'text:received', from: String(ctx.from.id), sessions: sessions.size })
  if (!loadAllowFrom().includes(String(ctx.from.id))) return
  if (sessions.size === 0) return

  let target: string | undefined
  let ambiguous = false
  // Thread-first: a message typed inside a tab's topic routes UNAMBIGUOUSLY to
  // that tab (message_thread_id -> label -> live session). This is more reliable
  // than swipe-reply and eliminates the ambiguous flag for threaded messages.
  const tid = (ctx.message as { message_thread_id?: number })?.message_thread_id
  if (tid != null) {
    const threads = readThreads()
    const label = Object.keys(threads).find(k => threads[k].thread_id === tid)
    if (label) target = pickForLabel(label)
  }
  // Fallback (General topic or no thread match): swipe-reply, else most-recent.
  if (!target) {
    const repliedId = ctx.message?.reply_to_message?.message_id
    if (repliedId != null) target = msgToHandle.get(String(repliedId))
    if (!target || !sessions.has(target)) {
      // Real tabs only: a subagent or background job registers its own session and
      // inherits the tab's label, and handing the user's message to one meant nobody
      // ever answered it. Sorted by recency, like pickForLabel.
      const tabs = [...sessions.values()].filter(s => !s.child).sort((a, b) => b.lastActive - a.lastActive)
      const lastSend = lastSendHandle ? sessions.get(lastSendHandle) : undefined
      target = (lastSend && !lastSend.child ? lastSend : tabs[0])?.handle
      // Only ambiguous when the guess could have been a DIFFERENT tab. With one tab
      // open there is nothing to confuse, and the flag just made every message look
      // risky enough to re-confirm before acting.
      ambiguous = tabs.length > 1
    }
  }
  const s = target ? sessions.get(target) : undefined
  if (!s) return
  logInbound({ kind: 'text:routed', handle: target, ambiguous })

  await bot.api.sendChatAction(String(ctx.chat.id), 'typing').catch(() => {})
  // «Принял» the moment it lands. The tab can take a minute to answer, and the
  // typing indicator dies well before that — a silent gap reads as a dead bridge.
  // Done here, not by the model: an acknowledgement that depends on remembering
  // to send it is the one that goes missing.
  if (ctx.message?.message_id) {
    await bot.api.setMessageReaction(String(ctx.chat.id), ctx.message.message_id, [
      { type: 'emoji', emoji: '👀' },
    ]).catch(() => {})
  }
  const imagePath = downloadImage ? await downloadImage() : undefined
  push(s, {
    type: 'message',
    text,
    message_id: String(ctx.message?.message_id ?? ''),
    chat_id: String(ctx.chat!.id),
    user: ctx.from.username ?? String(ctx.from.id),
    user_id: String(ctx.from.id),
    ts: new Date((ctx.message?.date ?? 0) * 1000).toISOString(),
    ...(ambiguous ? { ambiguous: true } : {}),
    ...(imagePath ? { image_path: imagePath } : {}),
  })
}

bot.catch(err => process.stderr.write(`claph daemon: handler error: ${err.error}\n`))

// --- lifecycle ------------------------------------------------------------

let server: ReturnType<typeof Bun.serve> | null = null
try {
  server = Bun.serve({ hostname: HOST, port: PORT, fetch: handle, idleTimeout: 60 })
} catch (err) {
  // Port already bound → another daemon is live. Nothing to do.
  process.stderr.write(`claph daemon: port ${PORT} busy (${err}) — assuming another daemon runs. Exiting.\n`)
  process.exit(0)
}
mkdirSync(join(DAEMON_PID, '..'), { recursive: true })
writeFileSync(DAEMON_PID, String(process.pid))
process.stderr.write(`claph daemon: http on ${HOST}:${PORT}, pid=${process.pid}\n`)

let shuttingDown = false
function shutdown(): void {
  if (shuttingDown) return
  shuttingDown = true
  try { rmSync(DAEMON_PID) } catch {}
  server?.stop(true)
  setTimeout(() => process.exit(0), 1500)
  void Promise.resolve(bot.stop()).finally(() => process.exit(0))
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)

// Poll Telegram with backoff. Only one consumer per token is allowed, so a
// lingering official-plugin poller will 409 us until it's disabled.
void (async () => {
  for (let attempt = 1; ; attempt++) {
    try {
      await bot.start({
        onStart: info => { attempt = 0; polling = true; lastPollError = ''; process.stderr.write(`claph daemon: polling as @${info.username}\n`) },
      })
      if (shuttingDown) return
      // bot.start() resolved WITHOUT a shutdown → the long-poll loop ended on
      // its own. Do NOT return (that leaves the daemon deaf: HTTP + send alive
      // but never receiving). Fall through to restart polling.
      polling = false
      lastPollError = 'poll loop ended unexpectedly — restarting'
      process.stderr.write('claph daemon: poll loop ended unexpectedly, restarting\n')
      await new Promise(r => setTimeout(r, 1000))
    } catch (err) {
      if (shuttingDown) return
      if (err instanceof Error && err.message === 'Aborted delay') return
      const is409 = err instanceof GrammyError && err.error_code === 409
      polling = false
      lastPollError = is409 ? '409 Conflict (another poller holds the token)' : String(err).slice(0, 200)
      const delay = Math.min(1000 * attempt, 15_000)
      process.stderr.write(
        `claph daemon: ${is409 ? '409 Conflict — another poller holds the token (disable the official telegram plugin)' : `polling error: ${err}`}, retry in ${delay / 1000}s\n`,
      )
      await new Promise(r => setTimeout(r, delay))
    }
  }
})()
