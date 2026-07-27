import { test, expect } from 'bun:test'
import { rmSync, writeFileSync, mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// These tests delete and corrupt threads.json. Against the LIVE state dir that
// wiped the running bridge's label -> topic map: every tab then created a fresh
// forum topic (duplicates) and the orphaned old ones could never be flipped to
// 💤. Redirect the state dir BEFORE importing shared.ts (dynamic import: static
// ones are hoisted above this assignment).
process.env.CLAPH_HOME = mkdtempSync(join(tmpdir(), 'tgb-test-'))
const { labelKey, baseName, readThreads, writeThreads, THREADS_FILE } = await import('./shared.ts')

test('state dir is the temp one, never the live bridge state', () => {
  expect(THREADS_FILE.startsWith(process.env.CLAPH_HOME!)).toBe(true)
})

test('labelKey prefers env label, falls back to cwd basename', () => {
  expect(labelKey('/home/u/Admin-Pannel-for-SEO')).toBe('Admin-Pannel-for-SEO')
  expect(labelKey('/home/u/Admin-Pannel-for-SEO', 'чат')).toBe('чат')
  expect(labelKey('/home/u/x', '  ')).toBe('x') // blank env ignored
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
