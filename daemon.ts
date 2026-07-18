#!/usr/bin/env bun
/**
 * tg-bridge daemon — the single, shared process.
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
import { writeFileSync, rmSync, mkdirSync } from 'fs'
import { join } from 'path'
import { toMarkdownV2 } from './format.ts'
import {
  loadToken, loadAllowFrom, ensureSecret,
  chunk, CALLBACK_MAX, CHUNK_LIMIT,
  HOST, PORT, DAEMON_PID, INBOX_DIR,
  readThreads, writeThreads,
  type PollEvent, type Button,
} from './shared.ts'

const TOKEN = loadToken()
const SECRET = ensureSecret()
const bot = new Bot(TOKEN)

// --- session registry -----------------------------------------------------

type Session = {
  handle: string
  label: string
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

// Reap dead sessions so taps on their buttons report "session closed".
setInterval(() => {
  const now = Date.now()
  for (const [h, s] of sessions) {
    if (now - s.lastActive > SESSION_TTL) {
      if (s.waiter) { const w = s.waiter; s.waiter = null; w({ type: 'idle' }) }
      sessions.delete(h)
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
      handle: s.handle, label: s.label, queueLen: s.queue.length, waiting: !!s.waiter,
      ageMs: Date.now() - s.lastActive,
    })),
    recentInbound,
  })

  // Test-only: inject an event straight into a session's queue to verify
  // routing isolation without touching Telegram. Off unless TG_BRIDGE_TEST=1.
  if (process.env.TG_BRIDGE_TEST === '1' && path === '/test/push' && req.method === 'POST') {
    const { handle: h, event } = (await req.json()) as { handle: string; event: PollEvent }
    const s = sessions.get(h)
    if (!s) return json({ error: 'unknown handle' }, 404)
    push(s, event)
    return json({ ok: true })
  }

  try {
    if (path === '/register' && req.method === 'POST') {
      const { label } = (await req.json()) as { label?: string }
      const h = newHandle()
      sessions.set(h, { handle: h, label: label ?? h, lastActive: Date.now(), queue: [], waiter: null })
      process.stderr.write(`register ${h} (${label ?? '-'})\n`)
      return json({ handle: h })
    }

    if (path === '/deregister' && req.method === 'POST') {
      const { handle: h } = (await req.json()) as { handle: string }
      const label = sessions.get(h)?.label
      sessions.delete(h)
      // Flip the topic to 💤 only when the LAST tab of this label closes (another
      // tab with the same label keeps it active). History stays; nothing deleted.
      if (label && ![...sessions.values()].some(s => s.label === label)) {
        const rec0 = readThreads()[label]
        if (rec0) {
          const nm = `💤 ${label}`
          try { await bot.api.editForumTopic(loadAllowFrom()[0], rec0.thread_id, { name: nm }) } catch {}
          const fresh = readThreads() // re-read after the await, then merge
          if (fresh[label]) { fresh[label].status = 'idle'; fresh[label].name = nm; writeThreads(fresh) }
        }
      }
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
      // Create-or-reuse the forum topic for a tab label. Only the daemon owns
      // the Bot API and threads.json, so allocation happens here (session-mcp
      // calls this once on startup). On any Bot API failure (Threaded Mode off,
      // not a forum) we return no thread_id so the caller falls back to flat chat.
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
        // Re-read after the await: another /ensure-thread (different label) may have
        // written during it; merging into a stale snapshot would clobber that label.
        const fresh = readThreads()
        fresh[label] = { thread_id: topic.message_thread_id, name, status: 'active', ts: Date.now() }
        writeThreads(fresh)
        return json({ thread_id: topic.message_thread_id })
      } catch (err) {
        logInbound({ kind: 'ensure-thread:fail', label, error: String(err).slice(0, 140) })
        return json({ error: 'thread unavailable' }, 200)
      }
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
      for (const chatId of loadAllowFrom()) {
        await bot.api.sendMessage(chatId, text, { reply_markup: kb }).catch(() => {})
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
): Promise<string[]> {
  const replyExtra = reply_to ? { reply_parameters: { message_id: Number(reply_to) } } : {}
  const threadExtra = threadId ? { message_thread_id: threadId } : {}
  // Last resort: plain send with NO thread id. A deleted/stale topic makes every
  // threaded attempt 400 «message thread not found»; without this the whole send
  // would throw and the tab goes silently dead. Falling back to the flat chat
  // guarantees delivery instead of losing it.
  const flatFallback = () => deliverClassic(chatId, text, undefined, kb, replyExtra, {})
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

bot.on('message:photo', async ctx => {
  const caption = ctx.message.caption ?? '(photo)'
  await routeText(ctx, caption, async () => {
    const photos = ctx.message.photo
    const best = photos[photos.length - 1]
    try {
      const file = await ctx.api.getFile(best.file_id)
      if (!file.file_path) return undefined
      const res = await fetch(`https://api.telegram.org/file/bot${TOKEN}/${file.file_path}`)
      const buf = Buffer.from(await res.arrayBuffer())
      const ext = file.file_path.split('.').pop() ?? 'jpg'
      const path = join(INBOX_DIR, `${Date.now()}-${best.file_unique_id}.${ext}`)
      mkdirSync(INBOX_DIR, { recursive: true })
      writeFileSync(path, buf)
      return path
    } catch { return undefined }
  })
})

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
    if (label) for (const [h, s] of sessions) if (s.label === label) { target = h; break }
  }
  // Fallback (General topic or no thread match): swipe-reply, else most-recent, flagged.
  if (!target) {
    const repliedId = ctx.message?.reply_to_message?.message_id
    if (repliedId != null) target = msgToHandle.get(String(repliedId))
    if (!target || !sessions.has(target)) {
      target = lastSendHandle && sessions.has(lastSendHandle) ? lastSendHandle : sessions.keys().next().value
      ambiguous = true
    }
  }
  const s = target ? sessions.get(target) : undefined
  if (!s) return
  logInbound({ kind: 'text:routed', handle: target, ambiguous })

  await bot.api.sendChatAction(String(ctx.chat.id), 'typing').catch(() => {})
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

bot.catch(err => process.stderr.write(`tg-bridge daemon: handler error: ${err.error}\n`))

// --- lifecycle ------------------------------------------------------------

let server: ReturnType<typeof Bun.serve> | null = null
try {
  server = Bun.serve({ hostname: HOST, port: PORT, fetch: handle, idleTimeout: 60 })
} catch (err) {
  // Port already bound → another daemon is live. Nothing to do.
  process.stderr.write(`tg-bridge daemon: port ${PORT} busy (${err}) — assuming another daemon runs. Exiting.\n`)
  process.exit(0)
}
mkdirSync(join(DAEMON_PID, '..'), { recursive: true })
writeFileSync(DAEMON_PID, String(process.pid))
process.stderr.write(`tg-bridge daemon: http on ${HOST}:${PORT}, pid=${process.pid}\n`)

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
        onStart: info => { attempt = 0; polling = true; lastPollError = ''; process.stderr.write(`tg-bridge daemon: polling as @${info.username}\n`) },
      })
      if (shuttingDown) return
      // bot.start() resolved WITHOUT a shutdown → the long-poll loop ended on
      // its own. Do NOT return (that leaves the daemon deaf: HTTP + send alive
      // but never receiving). Fall through to restart polling.
      polling = false
      lastPollError = 'poll loop ended unexpectedly — restarting'
      process.stderr.write('tg-bridge daemon: poll loop ended unexpectedly, restarting\n')
      await new Promise(r => setTimeout(r, 1000))
    } catch (err) {
      if (shuttingDown) return
      if (err instanceof Error && err.message === 'Aborted delay') return
      const is409 = err instanceof GrammyError && err.error_code === 409
      polling = false
      lastPollError = is409 ? '409 Conflict (another poller holds the token)' : String(err).slice(0, 200)
      const delay = Math.min(1000 * attempt, 15_000)
      process.stderr.write(
        `tg-bridge daemon: ${is409 ? '409 Conflict — another poller holds the token (disable the official telegram plugin)' : `polling error: ${err}`}, retry in ${delay / 1000}s\n`,
      )
      await new Promise(r => setTimeout(r, delay))
    }
  }
})()
