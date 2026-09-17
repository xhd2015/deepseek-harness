/**
 * Process-local listen record so `dsh web open` can reach a running Web GUI.
 * @module @deepseek-ai/dsh-web-app/listen-file
 */

import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'

/** File name under `$DSH_HOME` for the active Web listen record. */
export const WEB_LISTEN_FILE_NAME = 'web-listen.json'

/** Facts a second `dsh web open` process needs to call the running GUI. */
export interface WebListenRecord {
  /** Process id of the serving `dsh web` invocation. */
  readonly pid: number
  /** Canonical loopback origin, for example `http://127.0.0.1:3080`. */
  readonly origin: string
  /** Process launch token accepted as `Authorization: Bearer`. */
  readonly token: string
}

/**
 * Absolute path of the listen record.
 * @param home - harness home; defaults to {@link resolveDshHome}.
 */
export function webListenFilePath(home: string = resolveDshHome()): string {
  return join(home, WEB_LISTEN_FILE_NAME)
}

/**
 * Write the serving process's origin and launch token.
 * @param record - listen facts for this process.
 * @param path - file to replace.
 */
export function writeWebListenFile(record: WebListenRecord, path: string = webListenFilePath()): void {
  writeFileSync(path, `${JSON.stringify(record)}\n`, { encoding: 'utf8', mode: 0o600 })
}

/**
 * Remove the listen record when this process still owns it.
 * @param pid - serving process id that wrote the file.
 * @param path - file to unlink when it still names `pid`.
 */
export function clearWebListenFile(pid: number, path: string = webListenFilePath()): void {
  const record = readWebListenFile(path)
  if (record === undefined || record.pid !== pid) return
  try {
    unlinkSync(path)
  } catch (error) {
    if (!isEnoent(error)) throw error
  }
}

/**
 * Read a listen record whose process is still alive.
 * @param path - file to read.
 * @returns the record, or `undefined` when missing, malformed, or stale.
 */
export function readWebListenFile(path: string = webListenFilePath()): WebListenRecord | undefined {
  if (!existsSync(path)) return undefined
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch (error) {
    if (isEnoent(error)) return undefined
    throw error
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return undefined
  }
  if (!isListenRecord(parsed)) return undefined
  if (!processAlive(parsed.pid)) return undefined
  return parsed
}

function isListenRecord(value: unknown): value is WebListenRecord {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return typeof record.pid === 'number' && Number.isInteger(record.pid) && record.pid > 0
    && typeof record.origin === 'string' && /^https?:\/\//u.test(record.origin)
    && typeof record.token === 'string' && record.token.length > 0
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function isEnoent(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
}
