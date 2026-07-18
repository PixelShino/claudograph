import { test, expect } from 'bun:test'
import { rmSync, writeFileSync } from 'fs'
import { labelKey, readThreads, writeThreads, THREADS_FILE } from './shared.ts'

test('labelKey prefers env label, falls back to cwd basename', () => {
  expect(labelKey('/home/u/Admin-Pannel-for-SEO')).toBe('Admin-Pannel-for-SEO')
  expect(labelKey('/home/u/Admin-Pannel-for-SEO', 'чат')).toBe('чат')
  expect(labelKey('/home/u/x', '  ')).toBe('x') // blank env ignored
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
