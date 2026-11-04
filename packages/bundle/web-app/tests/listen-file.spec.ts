import { chmodSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  clearWebListenFile,
  readWebListenFile,
  writeWebListenFile,
} from '../src/listen-file.ts'

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('web listen file', () => {
  it('atomically replaces legacy records with versioned multi-listener metadata at mode 0600', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-web-listen-'))
    dirs.push(dir)
    const path = join(dir, 'web-listen.json')
    writeWebListenFile({ pid: process.pid, origin: 'http://127.0.0.1:3080' }, path)
    chmodSync(path, 0o644)
    const record = { version: 2 as const, pid: process.pid, origin: 'http://127.0.0.1:3080', listeners: [{ host: '127.0.0.1', port: 3080 }, { host: '::1', port: 3080 }] }
    writeWebListenFile(record, path)
    expect(readWebListenFile(path)).toEqual(record)
    if (process.platform !== 'win32') expect(statSync(path).mode & 0o777).toBe(0o600)
    expect(readdirSync(dir)).toEqual(['web-listen.json'])
  })

  it('preserves scoped-only discovery and refuses malformed or future-version metadata', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-web-listen-'))
    dirs.push(dir)
    const path = join(dir, 'web-listen.json')
    const record = { version: 2 as const, pid: process.pid, listeners: [{ host: 'fe80::1%en7', port: 3080 }] }
    writeWebListenFile(record, path)
    expect(readWebListenFile(path)).toEqual(record)
    for (const invalid of [{ ...record, version: 3 }, { ...record, listeners: [] }, { ...record, listeners: [{ host: 'localhost', port: 3080 }] }, { ...record, listeners: [{ host: '::1', port: 0 }] }]) {
      writeFileSync(path, JSON.stringify(invalid))
      expect(readWebListenFile(path)).toBeUndefined()
    }
    writeWebListenFile(record, path)
    clearWebListenFile(process.pid, path)
    expect(readWebListenFile(path)).toBeUndefined()
  })

  it('round-trips a live pid and ignores a dead one', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-web-listen-'))
    dirs.push(dir)
    const path = join(dir, 'web-listen.json')
    writeWebListenFile({ pid: process.pid, origin: 'http://127.0.0.1:3080', token: 'tok' }, path)
    expect(readWebListenFile(path)).toEqual({
      pid: process.pid,
      origin: 'http://127.0.0.1:3080',
      token: 'tok',
    })
    writeWebListenFile({ pid: 2 ** 22, origin: 'http://127.0.0.1:3080', token: 'tok' }, path)
    expect(readWebListenFile(path)).toBeUndefined()
  })

  it('round-trips a record without a launch token and rejects a malformed one', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-web-listen-'))
    dirs.push(dir)
    const path = join(dir, 'web-listen.json')
    writeWebListenFile({ pid: process.pid, origin: 'http://127.0.0.1:3080' }, path)
    expect(readWebListenFile(path)).toEqual({
      pid: process.pid,
      origin: 'http://127.0.0.1:3080',
    })
    writeFileSync(path, JSON.stringify({ pid: process.pid, origin: 'http://127.0.0.1:3080', token: '' }))
    expect(readWebListenFile(path)).toBeUndefined()
    writeFileSync(path, JSON.stringify({ pid: process.pid, origin: 'http://127.0.0.1:3080', token: 7 }))
    expect(readWebListenFile(path)).toBeUndefined()
  })

  it('clears only the file this pid wrote', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-web-listen-'))
    dirs.push(dir)
    const path = join(dir, 'web-listen.json')
    writeWebListenFile({ pid: process.pid, origin: 'http://127.0.0.1:3080', token: 'tok' }, path)
    clearWebListenFile(process.pid, path)
    expect(readWebListenFile(path)).toBeUndefined()
  })
})
