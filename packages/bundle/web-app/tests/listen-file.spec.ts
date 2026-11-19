import { mkdtempSync, rmSync } from 'node:fs'
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

  it('accepts a record without a token from a --no-auth process', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-web-listen-'))
    dirs.push(dir)
    const path = join(dir, 'web-listen.json')
    writeWebListenFile({ pid: process.pid, origin: 'http://127.0.0.1:3080' }, path)
    expect(readWebListenFile(path)).toEqual({
      pid: process.pid,
      origin: 'http://127.0.0.1:3080',
    })
    // An explicitly empty token is malformed rather than an absent credential.
    writeWebListenFile({ pid: process.pid, origin: 'http://127.0.0.1:3080', token: '' }, path)
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
