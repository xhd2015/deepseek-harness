/**
 * Open a URL in a new browser window without forwarding Harness credentials.
 *
 * On macOS, `open -a App URL` reuses a tab, and `open -a App --args --new-window`
 * is a no-op while the app is already running. Chromium browsers must be
 * spawned as their real binary with `--new-window` (same as browser-agent).
 * @module @deepseek-ai/dsh-web-app/opener
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { scrubbedParentEnv } from '@deepseek-ai/dsh-subprocess'

const BROWSER_OPENER_MODULE = import.meta.resolve('open')

const BROWSER_OPENER_PROGRAM = `
try {
  const { default: open } = await import(${JSON.stringify(BROWSER_OPENER_MODULE)})
  const launcher = await open(process.argv[1], { newInstance: process.platform === 'darwin' })
  if (process.platform === 'win32') {
    const code = launcher.exitCode ?? await new Promise((resolve, reject) => {
      function onError(error) {
        launcher.off('close', onClose)
        reject(error)
      }
      function onClose(code) {
        launcher.off('error', onError)
        resolve(code)
      }
      launcher.ref()
      launcher.once('error', onError)
      launcher.once('close', onClose)
    })
    if (code !== 0) throw new Error('browser operating-system launcher exited with code ' + String(code))
  }
  process.exitCode = 0
} catch (error) {
  console.error(error)
  process.exitCode = 1
}
`

/** macOS app-bundle relative path to the browser executable. */
const DARWIN_BINARIES: Record<string, string> = {
  brave: 'Brave Browser.app/Contents/MacOS/Brave Browser',
  chrome: 'Google Chrome.app/Contents/MacOS/Google Chrome',
  edge: 'Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  firefox: 'Firefox.app/Contents/MacOS/firefox',
  safari: 'Safari.app/Contents/MacOS/Safari',
}

/**
 * Resolve a named browser to an argv that opens `url` in a new window.
 * @param browser - `--browser` id.
 * @param url - authenticated application URL.
 * @returns command and args, or `undefined` when this host has no known binary.
 */
const DARWIN_APPLESCRIPT_APPS: Record<string, string> = {
  brave: 'Brave Browser',
  chrome: 'Google Chrome',
  edge: 'Microsoft Edge',
  safari: 'Safari',
}

/**
 * Resolve the command that opens `url` in a new window for a named browser.
 * @param browser - `--browser` id.
 * @param url - authenticated application URL.
 * @returns command and args, or `undefined` when this host has no known binary.
 */
export function newWindowLaunch(browser: string, url: string): { command: string; args: string[] } | undefined {
  if (process.platform === 'darwin') {
    const app = DARWIN_APPLESCRIPT_APPS[browser]
    if (app !== undefined) {
      // Chromium `--new-window` argv opens a window but the navigation to a
      // loopback token URL stays pending. AppleScript is an in-app load.
      const href = JSON.stringify(url)
      const script = app === 'Safari'
        ? `tell application ${JSON.stringify(app)} to make new document with properties {URL:${href}}`
        : [
          `tell application ${JSON.stringify(app)}`,
          '  activate',
          '  make new window',
          `  set URL of active tab of front window to ${href}`,
          'end tell',
        ].join('\n')
      return { command: 'osascript', args: ['-e', script] }
    }
    const rel = DARWIN_BINARIES[browser]
    if (rel === undefined) return undefined
    const candidates = [join(homedir(), 'Applications', rel), join('/Applications', rel)]
    const binary = candidates.find(path => existsSync(path))
    if (binary === undefined) return undefined
    const flag = browser === 'firefox' ? '-new-window' : '--new-window'
    return { command: binary, args: [flag, url] }
  }
  return undefined
}

function spawnBrowserBinary(command: string, args: string[]): ChildProcess {
  // Detached so `dsh web open` can exit; Chromium still hands `--new-window`
  // to the existing session. Inherit stderr for "Opening in existing browser
  // session." Do not use `open -a` (tab) or `open -a --args` (no-op).
  return spawn(command, args, {
    env: scrubbedParentEnv(),
    stdio: ['ignore', 'ignore', 'inherit'],
    detached: true,
  })
}

function spawnOpenPackage(url: string): ChildProcess {
  return spawn(process.execPath, [
    '--input-type=module',
    '--eval', BROWSER_OPENER_PROGRAM,
    '--', url,
  ], {
    env: scrubbedParentEnv(),
    stdio: ['ignore', 'inherit', 'pipe'],
  })
}

/**
 * Hand one URL to a named browser in a new window, or the OS default handler.
 * @param url - authenticated application URL.
 * @param browser - `--browser` id, or omitted for the OS default.
 */
export async function openBrowser(url: string, browser?: string): Promise<void> {
  const launch = browser === undefined ? undefined : newWindowLaunch(browser, url)
  const applescript = launch?.command === 'osascript'
  const child = launch === undefined
    ? spawnOpenPackage(url)
    : applescript
      ? spawn(launch.command, launch.args, { env: scrubbedParentEnv(), stdio: 'inherit' })
      : spawnBrowserBinary(launch.command, launch.args)
  if (applescript) {
    await new Promise<void>((resolve, reject) => {
      child.once('error', reject)
      child.once('close', (code) => {
        if (code === 0) resolve()
        else reject(new Error(`osascript exited with code ${String(code)}`))
      })
    })
    return
  }
  await new Promise<void>((resolve, reject) => {
    function onError(error: Error): void {
      child.off('spawn', onSpawn)
      reject(error)
    }
    function onSpawn(): void {
      child.off('error', onError)
      resolve()
    }
    child.once('error', onError)
    child.once('spawn', onSpawn)
  })
  if (launch !== undefined) {
    await new Promise(resolve => setTimeout(resolve, 400))
  }
  child.unref()
}

/** Test hook for native browser handoff; production never mutates it. */
export const openerInternals: {
  openBrowser: (url: string, browser?: string) => Promise<void>
} = { openBrowser }
