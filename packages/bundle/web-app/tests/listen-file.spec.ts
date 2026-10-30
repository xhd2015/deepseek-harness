import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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
