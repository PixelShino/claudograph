/**
 * Shared config + protocol types for the claph daemon and session-mcp.
 *
 * Token and allowlist are REUSED from the official telegram plugin's state
 * (~/.claude/channels/telegram) so no re-pairing is needed — our bridge simply
 * replaces the plugin's poller.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from 'fs'
import { homedir } from 'os'
import { join, basename } from 'path'
import { randomBytes } from 'crypto'

export const HOME = homedir()

// Reused plugin state (source of truth for token + who may talk to us).
export const TG_STATE_DIR = process.env.TELEGRAM_STATE_DIR ?? join(HOME, '.claude', 'channels', 'telegram')
export const TG_ENV_FILE = join(TG_STATE_DIR, '.env')
export const TG_ACCESS_FILE = join(TG_STATE_DIR, 'access.json')

// Our own state. CLAPH_HOME redirects it (tests point it at a temp dir so
// they never touch the live threads.json of a running bridge).
export const BRIDGE_DIR = process.env.CLAPH_HOME ?? join(HOME, '.claude', 'claph')
export const STATE_DIR = join(BRIDGE_DIR, 'state')
export const SECRET_FILE = join(STATE_DIR, 'daemon.secret')
export const DAEMON_PID = join(STATE_DIR, 'daemon.pid')
export const INBOX_DIR = join(STATE_DIR, 'inbox')

export const HOST = '127.0.0.1'
export const PORT = Number(process.env.CLAPH_PORT ?? 8787)
export const BASE_URL = `http://${HOST}:${PORT}`

export const CALLBACK_MAX = 64 // Telegram hard limit on callback_data bytes.
export const CHUNK_LIMIT = 4096 // Telegram hard limit on message length.

// --- token + allowlist (read from the plugin's state) ---------------------

/** Read one key from the channels/.env FILE, which is the source of truth here.
 *  It must win over process.env: bun auto-loads the CWD's .env, and Claude Code
 *  runs us with CWD = the user's project, whose .env sets its OWN app-bot
 *  TELEGRAM_BOT_TOKEN. Trusting process.env would hijack us onto that bot. */
export function loadEnvValue(key: string): string | undefined {
  try {
    for (const line of readFileSync(TG_ENV_FILE, 'utf8').split('\n')) {
      const m = line.match(new RegExp(`^${key}=(.*)$`))
      if (m && m[1].trim()) return m[1].trim()
    }
  } catch {}
  return undefined
}

export function loadToken(): string {
  const fromFile = loadEnvValue('TELEGRAM_BOT_TOKEN')
  if (fromFile) return fromFile
  if (process.env.TELEGRAM_BOT_TOKEN) return process.env.TELEGRAM_BOT_TOKEN
  throw new Error(`no TELEGRAM_BOT_TOKEN in ${TG_ENV_FILE} or env`)
}

export function loadAllowFrom(): string[] {
  try {
    const parsed = JSON.parse(readFileSync(TG_ACCESS_FILE, 'utf8')) as { allowFrom?: string[] }
    return parsed.allowFrom ?? []
  } catch {
    return []
  }
}

// --- local IPC secret (guards the loopback HTTP API) ----------------------

/** Create the secret on first daemon boot; readers block until it exists. */
export function ensureSecret(): string {
  mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 })
  if (existsSync(SECRET_FILE)) return readFileSync(SECRET_FILE, 'utf8').trim()
  const secret = randomBytes(24).toString('hex')
  writeFileSync(SECRET_FILE, secret, { mode: 0o600 })
  return secret
}

export function readSecret(): string {
  return readFileSync(SECRET_FILE, 'utf8').trim()
}

// --- native-thread state (tab label -> Telegram forum topic) --------------
// Written ONLY by the daemon (atomic temp+rename); the Python hooks read it to
// learn which message_thread_id a tab's messages belong in. Keyed by the tab's
// label, which both session-mcp and the hooks compute identically (see labelKey).

export const THREADS_FILE = join(STATE_DIR, 'threads.json')

export type ThreadStatus = 'active' | 'idle'
export type ThreadRecord = { thread_id: number; name: string; status: ThreadStatus; ts: number }
export type ThreadsFile = Record<string, ThreadRecord>

// --- the harness's own session identity ----------------------------------
// Claude Code 2.1.2xx runs MANY named sessions out of ONE directory (`claude
// --name`, `--bg`, `claude agents`), so the cwd basename stopped identifying a
// tab: every session started from the same folder collapsed into a single
// Telegram topic and an inbound message reached whichever of them answered last.
// CLAUDE_JOB_DIR is inherited by every child of the session (MCP server, hooks),
// so all of them agree on it.

export type JobState = { name?: string; sessionId?: string; resumeSessionId?: string }

export function readJobState(): JobState | undefined {
  const dir = process.env.CLAUDE_JOB_DIR
  if (!dir) return undefined
  try {
    return JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8')) as JobState
  } catch {
    return undefined // unreadable or mid-write; never worth throwing over
  }
}

/** The session's IMMUTABLE id — its job directory's name.
 *  Deliberately not the session's `name`: the harness rewrites that (no name ->
 *  an auto-generated one -> the user's own), and one job was observed under four
 *  different names within minutes. A routing key that moves forks a topic every
 *  time it moves, which is the bug this replaces. */
export function jobId(): string | undefined {
  const dir = process.env.CLAUDE_JOB_DIR
  return dir ? basename(dir) || undefined : undefined
}

/** The session's display name (`claude --name`, what the session list shows).
 *  Cosmetic only — it names the topic, it never routes. */
export function jobTitle(): string | undefined {
  return (readJobState()?.name ?? '').trim() || undefined
}

/** A tab's stable key: explicit CLAPH_LABEL, else the session's id, else the
 *  cwd's basename (a plain tab, which has no job directory).
 *  session-mcp and the hooks MUST derive this the same way to agree on a thread. */
export function labelKey(cwd: string, envLabel?: string): string {
  const e = (envLabel ?? '').trim()
  return e || jobId() || basename(cwd)
}

/** The topic's display name without its status emoji — a name set via
 *  /rename-thread must survive the 🟢 <-> 💤 flips. */
export function baseName(display: string, label: string): string {
  return display.replace(/^[🟢💤]\s*/u, '').trim() || label
}

export function readThreads(): ThreadsFile {
  try {
    return JSON.parse(readFileSync(THREADS_FILE, 'utf8')) as ThreadsFile
  } catch {
    return {} // missing or corrupt -> empty; a bad file must never crash a send
  }
}

export function writeThreads(t: ThreadsFile): void {
  mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 })
  const tmp = THREADS_FILE + '.tmp'
  writeFileSync(tmp, JSON.stringify(t, null, 2), { mode: 0o600 })
  renameSync(tmp, THREADS_FILE)
}

// --- text chunking (paragraph-aware, mirrors the plugin) ------------------

export function chunk(text: string, limit = CHUNK_LIMIT): string[] {
  if (text.length <= limit) return [text]
  const out: string[] = []
  let rest = text
  while (rest.length > limit) {
    const para = rest.lastIndexOf('\n\n', limit)
    const line = rest.lastIndexOf('\n', limit)
    const space = rest.lastIndexOf(' ', limit)
    const cut = para > limit / 2 ? para : line > limit / 2 ? line : space > 0 ? space : limit
    out.push(rest.slice(0, cut))
    rest = rest.slice(cut).replace(/^\n+/, '')
  }
  if (rest) out.push(rest)
  return out
}

// --- protocol types (daemon <-> session-mcp over loopback HTTP) -----------

export type Button = { key: string; label: string }

/** Events the daemon delivers to a session via GET /poll. */
export type PollEvent =
  | { type: 'idle' }
  | {
      type: 'message'
      text: string
      message_id: string
      chat_id: string
      user: string
      user_id: string
      ts: string
      /** True when routing was best-effort (no swipe-reply matched a session). */
      ambiguous?: boolean
      image_path?: string
    }
  | {
      type: 'button'
      /** The button key the session originally supplied. */
      key: string
      label: string
      /** The message the button was attached to. */
      message_id: string
      chat_id: string
      user: string
      user_id: string
      ts: string
    }
  | { type: 'permission'; request_id: string; behavior: 'allow' | 'deny' }

export type RegisterReq = { label: string }
export type RegisterRes = { handle: string }

export type SendReq = {
  handle: string
  text: string
  buttons?: Button[]
  reply_to?: string
  format?: 'text' | 'markdownv2'
}
export type SendRes = { message_ids: string[] }

export type EditReq = { handle: string; message_id: string; text: string; buttons?: Button[] }
export type ReactReq = { handle: string; message_id: string; emoji: string }
export type PermissionReq = {
  handle: string
  request_id: string
  tool_name: string
  description: string
  input_preview: string
}
