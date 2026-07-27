#!/usr/bin/env bun
/**
 * Routing isolation test — no real Telegram involved.
 *
 * Boots the daemon on a throwaway port with a dummy token + empty allowlist,
 * registers two sessions, injects one event per session via /test/push, and
 * asserts each session's /poll returns ONLY its own event. Proves a tap for
 * tab A can never surface in tab B.
 */

import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Redirect the spawned daemon's state dir BEFORE importing shared.ts, so
// readSecret() below reads the test daemon's secret and not the live one. The
// test daemon writes state/daemon.pid on boot: pointed at the live dir it
// overwrote the RUNNING daemon's pid file, and whoever read it next killed the
// wrong process (or nothing at all).
process.env.CLAPH_HOME = mkdtempSync(join(tmpdir(), 'tgb-routing-'))
const { readSecret } = await import('./shared.ts')

const PORT = 8799
const BASE = `http://127.0.0.1:${PORT}`
const DAEMON = fileURLToPath(new URL('./daemon.ts', import.meta.url))
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

const child = spawn('bun', [DAEMON], {
  stdio: 'ignore',
  windowsHide: true,
  env: {
    ...process.env,
    CLAPH_TEST: '1',
    CLAPH_PORT: String(PORT),
    CLAPH_HOME: process.env.CLAPH_HOME,
    TELEGRAM_BOT_TOKEN: '111111:AAdummydummydummydummydummydummydum',
    TELEGRAM_STATE_DIR: process.env.TMPDIR ?? process.env.TEMP ?? '.', // empty allowlist (no access.json here)
  },
})

let failed = false
const check = (ok: boolean, msg: string) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${msg}`); if (!ok) failed = true }

try {
  // wait for health
  let up = false
  for (let i = 0; i < 40; i++) {
    try { if ((await fetch(`${BASE}/health`)).ok) { up = true; break } } catch {}
    await sleep(250)
  }
  if (!up) throw new Error('daemon did not come up')

  const SECRET = readSecret()
  const H = { 'content-type': 'application/json', 'x-bridge-secret': SECRET }
  const post = (p: string, b: unknown) => fetch(`${BASE}${p}`, { method: 'POST', headers: H, body: JSON.stringify(b) }).then(r => r.json())
  const poll = (h: string) => fetch(`${BASE}/poll?handle=${h}`, { headers: { 'x-bridge-secret': SECRET } }).then(r => r.json())

  const a = (await post('/register', { label: 'A' })).handle
  const b = (await post('/register', { label: 'B' })).handle
  check(!!a && !!b && a !== b, `two distinct handles: ${a}, ${b}`)

  const mk = (key: string) => ({ type: 'button', key, label: key, message_id: '1', user: 'u', user_id: '1', ts: '2026-07-02T00:00:00Z' })
  await post('/test/push', { handle: a, event: mk('deploy') })
  await post('/test/push', { handle: b, event: mk('merge') })

  const ea = await poll(a)
  const eb = await poll(b)
  check(ea.type === 'button' && ea.key === 'deploy', `A received its own event (got key=${ea.key})`)
  check(eb.type === 'button' && eb.key === 'merge', `B received its own event (got key=${eb.key})`)
  check(ea.key !== 'merge' && eb.key !== 'deploy', 'no cross-delivery between A and B')

  const unknown = await fetch(`${BASE}/poll?handle=zzz`, { headers: { 'x-bridge-secret': SECRET } })
  check(unknown.status === 404, `poll on unknown handle → 404 (got ${unknown.status})`)

  const noauth = await fetch(`${BASE}/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
  check(noauth.status === 401, `request without secret → 401 (got ${noauth.status})`)
} catch (err) {
  check(false, `threw: ${err}`)
} finally {
  // On Windows child.kill() doesn't reliably reap bun; force via taskkill.
  if (process.platform === 'win32' && child.pid) {
    spawn('taskkill', ['/F', '/T', '/PID', String(child.pid)], { stdio: 'ignore' })
  } else {
    child.kill('SIGKILL')
  }
  await sleep(300)
  console.log(failed ? '\nRESULT: FAIL' : '\nRESULT: PASS')
  process.exit(failed ? 1 : 0)
}
