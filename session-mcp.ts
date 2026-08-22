#!/usr/bin/env bun
/**
 * claph session-mcp — one per Claude Code session (tab).
 *
 * Spawned by Claude Code as a stdio MCP server. On startup it ensures the
 * shared daemon is running, registers to get a short `handle`, then long-polls
 * the daemon for this session's inbound events and surfaces them to Claude.
 *
 * Outbound tools (send/edit/react) forward to the daemon — the session never
 * touches Telegram directly, so all sessions coexist behind one bot token.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { appendFileSync } from 'node:fs'
import { join } from 'path'
import { BASE_URL, STATE_DIR, readSecret, labelKey, jobTitle, readJobState, type PollEvent } from './shared.ts'

// Audit trail: every channel notification we emit is appended here, so we can
// tell "session-mcp emitted but the harness didn't wake me" from a delivery
// failure — the emit path is otherwise invisible (stderr goes to Claude Code).
const EMIT_LOG = join(STATE_DIR, 'session-emit.log')
function emitChannel(method: string, params: Record<string, unknown>): void {
  try {
    appendFileSync(EMIT_LOG, JSON.stringify({
      ts: new Date().toISOString(), handle, method,
      content: String((params as { content?: string }).content ?? '').slice(0, 80),
    }) + '\n')
  } catch {}
  try {
    mcp.notification({ method, params })
  } catch (err) {
    try { appendFileSync(EMIT_LOG, `EMIT-ERROR ${method}: ${err}\n`) } catch {}
  }
}

const DAEMON_PATH = fileURLToPath(new URL('./daemon.ts', import.meta.url))
// TG_BRIDGE_LABEL is the pre-rename name: launchers already export it, and a tab
// that suddenly loses its label falls back to the cwd basename and creates a
// SECOND Telegram topic. Keep reading it until the launchers are updated.
// labelKey adds the harness's own session name in between, so the many named
// sessions Claude Code now runs out of ONE directory get one topic each.
const LABEL = labelKey(process.cwd(), process.env.CLAPH_LABEL || process.env.TG_BRIDGE_LABEL)

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

async function healthy(): Promise<boolean> {
  try {
    const r = await fetch(`${BASE_URL}/health`, { signal: AbortSignal.timeout(1500) })
    return r.ok
  } catch { return false }
}

// First session to start brings the daemon up; the rest just connect. The
// daemon's port bind is the single-instance lock, so racing spawns are safe.
async function ensureDaemon(): Promise<void> {
  if (await healthy()) return
  // `process.execPath` — the bun.exe already running us — NOT the `bun` name.
  // On Windows `bun` on PATH is a .cmd shim: spawning it runs cmd.exe, which
  // opens a real console window that `windowsHide` cannot suppress. Measured:
  // shim → window either way; bun.exe + detached → no window.
  const child = spawn(process.execPath, [DAEMON_PATH], { detached: true, stdio: 'ignore', windowsHide: true })
  child.unref()
  for (let i = 0; i < 40; i++) {
    if (await healthy()) return
    await sleep(250)
  }
  throw new Error('daemon did not come up within 10s')
}

let SECRET = ''
let handle = ''
let threadId: number | undefined // this tab's Telegram topic; undefined = flat chat

async function api(path: string, body: unknown): Promise<any> {
  const r = await fetch(`${BASE_URL}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-bridge-secret': SECRET },
    body: JSON.stringify(body),
  })
  const data = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(data?.error ?? `HTTP ${r.status}`)
  return data
}

// --- MCP server -----------------------------------------------------------

const mcp = new Server(
  { name: 'claph', version: '0.1.0' },
  {
    capabilities: {
      tools: {},
      experimental: { 'claude/channel': {}, 'claude/channel/permission': {} },
    },
    instructions: [
      'This is a multi-session Telegram bridge. Messages from the user arrive as <channel source="telegram" ...> blocks and reach ONLY this session — routing is handled for you.',
      '',
      'To reply, use the `send` tool (no chat_id needed — the bridge knows the user). To offer tappable choices, pass buttons: send({ text, buttons: [{ key: "deploy", label: "🚀 Деплой" }, { key: "later", label: "⏸ Позже" }] }). When the user taps, you receive a channel message like "[Кнопка] 🚀 Деплой (key=deploy)". Keys must be short and contain no "|".',
      '',
      'A message meta with ambiguous=true means the user typed a reply without swipe-replying to a specific tab, so it may have been meant for another session — confirm before acting on anything destructive. image_path means read that file (a photo).',
      '',
      'Use edit to update a sent message (e.g. progress), react for emoji. Include a short tab label in your button prompts so the user can tell which tab is asking.',
    ].join('\n'),
  },
)

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'send',
      description: 'Send a Telegram message to the user. Optionally attach tappable inline buttons; taps return to THIS session as a channel message.',
      inputSchema: {
        type: 'object',
        properties: {
          text: { type: 'string' },
          buttons: {
            type: 'array',
            description: 'Inline buttons. Each: {key, label}. key is short, no "|", returned on tap.',
            items: {
              type: 'object',
              properties: { key: { type: 'string' }, label: { type: 'string' } },
              required: ['key', 'label'],
            },
          },
          reply_to: { type: 'string', description: 'message_id to quote-reply under.' },
          format: {
            type: 'string',
            enum: ['text', 'markdown', 'markdownv2'],
            description:
              "'markdown' (recommended): write normal GFM and it is sent as a NATIVE Telegram Rich Message (Bot API) — REAL headings, bordered tables, ordered/task lists, collapsible <details> blocks, blockquotes, ==marked==, ||spoiler||, and $LaTeX$, all rendered structurally on modern clients (up to 32768 chars, one message). Falls back to classic MarkdownV2 if the server rejects it. 'markdownv2' = you pre-escaped raw MarkdownV2. 'text' = plain. See RICH_FORMATTING.md for the full dialect.",
          },
        },
        required: ['text'],
      },
    },
    {
      name: 'edit',
      description:
        'Edit a message this session previously sent. Use for streaming/progress: send a placeholder, then edit it as work advances (throttle to ~1 edit/sec) so the user sees the process moving. Optionally replace its buttons.',
      inputSchema: {
        type: 'object',
        properties: {
          message_id: { type: 'string' },
          text: { type: 'string' },
          format: {
            type: 'string',
            enum: ['text', 'markdown', 'markdownv2'],
            description: "Same as send: 'markdown' converts GFM to Telegram MarkdownV2.",
          },
          buttons: {
            type: 'array',
            items: {
              type: 'object',
              properties: { key: { type: 'string' }, label: { type: 'string' } },
              required: ['key', 'label'],
            },
          },
        },
        required: ['message_id', 'text'],
      },
    },
    {
      name: 'react',
      description: 'React to a user message with a whitelisted emoji (👍 👎 ❤ 🔥 👀 🎉 …).',
      inputSchema: {
        type: 'object',
        properties: { message_id: { type: 'string' }, emoji: { type: 'string' } },
        required: ['message_id', 'emoji'],
      },
    },
    {
      name: 'rename_thread',
      description:
        "Rename THIS tab's Telegram topic (thread). Use when the user asks to name/label this tab, e.g. rename_thread({ name: 'чат' }). No-op if Threaded Mode is off.",
      inputSchema: {
        type: 'object',
        properties: { name: { type: 'string' } },
        required: ['name'],
      },
    },
    {
      name: 'send_photo',
      description:
        'Send an image (e.g. a screenshot you just captured) to the user in Telegram. `path` is a local file path on this machine; optional `caption`. Lands in this tab\'s topic.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Local file path to the image.' },
          caption: { type: 'string', description: 'Optional caption under the image.' },
        },
        required: ['path'],
      },
    },
    {
      name: 'send_album',
      description:
        'Send a photo collage: 2–10 local images as one Telegram album. `paths` is an array of local file paths; optional `caption` on the first. Lands in this tab\'s topic.',
      inputSchema: {
        type: 'object',
        properties: {
          paths: { type: 'array', items: { type: 'string' }, description: '2–10 local image paths.' },
          caption: { type: 'string', description: 'Optional caption on the first image.' },
        },
        required: ['paths'],
      },
    },
  ],
}))

mcp.setRequestHandler(CallToolRequestSchema, async req => {
  const args = (req.params.arguments ?? {}) as Record<string, unknown>
  try {
    switch (req.params.name) {
      case 'send': {
        const res = await api('/send', { handle, ...args, ...(threadId ? { message_thread_id: threadId } : {}) })
        const ids: string[] = res.message_ids ?? []
        return { content: [{ type: 'text', text: `sent (ids: ${ids.join(', ')})` }] }
      }
      case 'edit':
        await api('/edit', { handle, ...args, ...(threadId ? { message_thread_id: threadId } : {}) })
        return { content: [{ type: 'text', text: 'edited' }] }
      case 'react':
        await api('/react', { handle, ...args })
        return { content: [{ type: 'text', text: 'reacted' }] }
      case 'rename_thread':
        await api('/rename-thread', { label: LABEL, name: String(args.name ?? '') })
        return { content: [{ type: 'text', text: `topic renamed to ${args.name}` }] }
      case 'send_photo': {
        const res = await api('/send-photo', { handle, ...args, ...(threadId ? { message_thread_id: threadId } : {}) })
        const ids: string[] = res.message_ids ?? []
        return { content: [{ type: 'text', text: `photo sent (ids: ${ids.join(', ')})` }] }
      }
      case 'send_album': {
        const res = await api('/send-album', { handle, ...args, ...(threadId ? { message_thread_id: threadId } : {}) })
        const ids: string[] = res.message_ids ?? []
        return { content: [{ type: 'text', text: `album sent (${ids.length} photos)` }] }
      }
      default:
        return { content: [{ type: 'text', text: `unknown tool: ${req.params.name}` }], isError: true }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { content: [{ type: 'text', text: `${req.params.name} failed: ${msg}` }], isError: true }
  }
})

// Forward CC permission requests to the daemon, which renders Allow/Deny
// buttons in Telegram. The tap comes back via /poll as a 'permission' event.
mcp.setNotificationHandler(
  z.object({
    method: z.literal('notifications/claude/channel/permission_request'),
    params: z.object({
      request_id: z.string(),
      tool_name: z.string(),
      description: z.string(),
      input_preview: z.string(),
    }),
  }),
  async ({ params }) => { await api('/permission', { handle, ...params }).catch(() => {}) },
)

// --- inbound poll loop ----------------------------------------------------

let stopping = false

// Re-establish after the daemon died/restarted: respawn it if down, then get a
// fresh handle. Makes the session self-heal when the daemon is killed (e.g. to
// pick up new code) without needing a session restart.
async function reconnect(): Promise<void> {
  if (stopping) return
  // Drop the old handle first: without this every reconnect leaks a ghost
  // session that lingers until the daemon's 70s reaper, so one tab shows up
  // as many. Best-effort — the daemon is usually the thing that just died.
  if (handle) await api('/deregister', { handle, reconnecting: true }).catch(() => {})
  try { await connect() } catch { await sleep(1500) }
}

async function pollLoop(): Promise<void> {
  while (!stopping) {
    let ev: PollEvent
    try {
      const r = await fetch(`${BASE_URL}/poll?handle=${handle}`, {
        headers: { 'x-bridge-secret': SECRET },
      })
      if (r.status === 404) { await reconnect(); continue } // handle reaped/daemon restarted
      ev = (await r.json()) as PollEvent
    } catch { await reconnect(); continue } // daemon down → respawn + re-register

    if (ev.type === 'idle') continue

    if (ev.type === 'message') {
      emitChannel('notifications/claude/channel', {
        content: ev.text,
        meta: {
          chat_id: ev.chat_id, message_id: ev.message_id, user: ev.user, user_id: ev.user_id, ts: ev.ts,
          ...(ev.ambiguous ? { ambiguous: 'true' } : {}),
          ...(ev.image_path ? { image_path: ev.image_path } : {}),
        },
      })
    } else if (ev.type === 'button') {
      emitChannel('notifications/claude/channel', {
        content: `[Кнопка] ${ev.label} (key=${ev.key})`,
        meta: {
          chat_id: ev.chat_id, button_key: ev.key, message_id: ev.message_id,
          user: ev.user, user_id: ev.user_id, ts: ev.ts,
        },
      })
    } else if (ev.type === 'permission') {
      emitChannel('notifications/claude/channel/permission', { request_id: ev.request_id, behavior: ev.behavior })
    }
  }
}

// --- startup / shutdown ---------------------------------------------------

/** A subagent spawned by a tab, rather than the tab the user is typing in.
 *  Both are full sessions with their own MCP server and they inherit the tab's
 *  label, so a busy tab registers several — and handing the user's message to a
 *  subagent means nobody ever answers it.
 *
 *  Not CLAUDE_CODE_CHILD_SESSION: Claude Code strips that variable before it
 *  reaches an MCP server (verified by dumping a probe server's env with it set
 *  explicitly in the parent), so it read false for every session, subagents
 *  included. The job state names the tab's OWN session id instead; a session id
 *  that is not it, under the same job directory, is something the tab spawned.
 *  A plain tab has no job state and is assumed to be a tab, as before. */
function isChild(): boolean {
  const sid = process.env.CLAUDE_CODE_SESSION_ID
  const st = readJobState()
  if (!sid || !st) return false
  return sid !== st.sessionId && sid !== st.resumeSessionId
}

async function connect(): Promise<void> {
  await ensureDaemon()
  SECRET = readSecret()
  handle = (await api('/register', { label: LABEL, child: isChild() })).handle
  process.stderr.write(`claph session: registered as ${handle} (${LABEL})\n`)
  // Ensure this tab has a native thread; the daemon creates-or-reuses it by label.
  // On failure (Threaded Mode off) threadId stays undefined -> flat-chat fallback.
  try {
    const r = await api('/ensure-thread', { label: LABEL, title: jobTitle() })
    threadId = typeof r.thread_id === 'number' ? r.thread_id : undefined
  } catch { threadId = undefined }
}

async function main(): Promise<void> {
  await connect()
  await mcp.connect(new StdioServerTransport())
  void pollLoop()
}

function shutdown(): void {
  if (stopping) return
  stopping = true
  if (handle) void api('/deregister', { handle }).catch(() => {})
  setTimeout(() => process.exit(0), 500)
}
process.stdin.on('end', shutdown)
process.stdin.on('close', shutdown)
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)

main().catch(err => {
  process.stderr.write(`claph session: fatal ${err}\n`)
  process.exit(1)
})
