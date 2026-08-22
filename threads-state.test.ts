import { test, expect } from 'bun:test'
import { rmSync, writeFileSync, mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { basename, join } from 'path'

// These tests delete and corrupt threads.json. Against the LIVE state dir that
// wiped the running bridge's label -> topic map: every tab then created a fresh
// forum topic (duplicates) and the orphaned old ones could never be flipped to
// 💤. Redirect the state dir BEFORE importing shared.ts (dynamic import: static
// ones are hoisted above this assignment).
process.env.CLAPH_HOME = mkdtempSync(join(tmpdir(), 'tgb-test-'))
// The test process is itself a child of a Claude Code session, so it inherits
// that session's CLAUDE_JOB_DIR — leaving it set would make labelKey report the
// RUNNING session's name instead of exercising the fallbacks.
delete process.env.CLAUDE_JOB_DIR
const { labelKey, jobTitle, baseName, readThreads, writeThreads, THREADS_FILE } = await import('./shared.ts')

test('state dir is the temp one, never the live bridge state', () => {
  expect(THREADS_FILE.startsWith(process.env.CLAPH_HOME!)).toBe(true)
})

test('labelKey prefers env label, falls back to cwd basename', () => {
  expect(labelKey('/home/u/Admin-Pannel-for-SEO')).toBe('Admin-Pannel-for-SEO')
  expect(labelKey('/home/u/Admin-Pannel-for-SEO', 'чат')).toBe('чат')
  expect(labelKey('/home/u/x', '  ')).toBe('x') // blank env ignored
})

test('labelKey is the session id, and a rename never moves it', () => {
  // Claude Code runs many named sessions out of ONE directory, so the cwd
  // basename collapsed them all onto a single Telegram topic. The session's
  // NAME cannot be the key either: the harness rewrites it (none -> an
  // auto-generated one -> the user's own), and one job was seen under four
  // names in minutes — each one forking another topic. The job directory's
  // name is the one thing that never moves.
  const job = mkdtempSync(join(tmpdir(), 'tgb-job-'))
  const id = basename(job)
  process.env.CLAUDE_JOB_DIR = job
  try {
    writeFileSync(join(job, 'state.json'), JSON.stringify({ name: 'audio transcription' }))
    expect(labelKey('/home/u/Projects')).toBe(id)
    expect(jobTitle()).toBe('audio transcription')

    writeFileSync(join(job, 'state.json'), JSON.stringify({ name: 'РЕЧЬ' }))
    expect(labelKey('/home/u/Projects')).toBe(id) // renamed session, SAME topic
    expect(jobTitle()).toBe('РЕЧЬ') // only the display name follows

    writeFileSync(join(job, 'state.json'), JSON.stringify({})) // mid-write: no name yet
    expect(labelKey('/home/u/Projects')).toBe(id)
    expect(jobTitle()).toBeUndefined() // topic keeps whatever it was called

    writeFileSync(join(job, 'state.json'), '{ not json')
    expect(labelKey('/home/u/Projects')).toBe(id)
    expect(jobTitle()).toBeUndefined()

    expect(labelKey('/home/u/Projects', 'explicit')).toBe('explicit') // CLAPH_LABEL still wins
  } finally {
    delete process.env.CLAUDE_JOB_DIR
  }
  expect(labelKey('/home/u/Projects')).toBe('Projects') // a plain tab: cwd, as before
})

test('baseName strips the status emoji, keeps a renamed topic name', () => {
  expect(baseName('🟢 proj', 'proj')).toBe('proj')
  expect(baseName('💤 чат', 'proj')).toBe('чат') // /rename-thread name survives the flip
  expect(baseName('💤', 'proj')).toBe('proj') // emoji-only -> fall back to the label
})

test('write then read round-trips; missing file reads as {}', () => {
  rmSync(THREADS_FILE, { force: true })
  expect(readThreads()).toEqual({})
  const t = { proj: { thread_id: 348083, name: '🟢 proj', status: 'active' as const, ts: 111 } }
  writeThreads(t)
  expect(readThreads()).toEqual(t)
})

test('corrupt file reads as {} not throw', () => {
  writeThreads({})
  writeFileSync(THREADS_FILE, '{ not json')
  expect(readThreads()).toEqual({})
})
