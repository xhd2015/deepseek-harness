/**
 * Spawn the maintained `open` package without forwarding Harness credentials.
 * @module @deepseek-ai/dsh-web-app/opener
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { scrubbedParentEnv } from '@deepseek-ai/dsh-subprocess'

const BROWSER_OPENER_MODULE = import.meta.resolve('open')

const BROWSER_OPENER_PROGRAM = `
try {
  const { default: open, apps } = await import(${JSON.stringify(BROWSER_OPENER_MODULE)})
  const url = process.argv[1]
  const browser = process.argv[2]
  const chromium = browser === 'brave' || browser === 'chrome' || browser === 'edge'
  const options = browser === undefined || browser === ''
    ? { newInstance: process.platform === 'darwin' }
    : {
        newInstance: browser === 'safari',
        app: {
          name: browser === 'safari' ? 'Safari' : (apps[browser] ?? browser),
          ...chromium ? { arguments: ['--new-window'] } : {},
          ...browser === 'firefox' ? { arguments: ['-new-window'] } : {},
        },
      }
  const launcher = await open(url, options)
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

function spawnBrowserLauncher(url: string, browser?: string): ChildProcess {
  return spawn(process.execPath, [
    '--input-type=module',
    '--eval', BROWSER_OPENER_PROGRAM,
    '--', url,
    ...browser === undefined ? [] : [browser],
  ], {
    env: scrubbedParentEnv(),
    stdio: ['ignore', 'inherit', 'pipe'],
  })
}

/**
 * Hand one URL to a named browser, or the operating system's default.
 * @param url - authenticated application URL.
 * @param browser - `--browser` id, or omitted for the OS default.
 */
export async function openBrowser(url: string, browser?: string): Promise<void> {
  const launcher = spawnBrowserLauncher(url, browser)
  let launcherStderr = ''
  launcher.stderr?.setEncoding('utf8')
  launcher.stderr?.on('data', (chunk: string) => { launcherStderr += chunk })
  await new Promise<void>((resolve, reject) => {
    function onError(error: Error): void {
      launcher.off('close', onClose)
      reject(error)
    }
    function onClose(code: number | null): void {
      launcher.off('error', onError)
      if (code !== 0) {
        const firstLine = launcherStderr.trim().split(/\r?\n/u)[0]
        const reason = firstLine === undefined || firstLine === ''
          ? `browser launcher exited with code ${String(code)}`
          : firstLine.replace(/^(?:[A-Za-z]*Error):\s*/u, '')
        reject(new Error(reason))
        return
      }
      if (launcherStderr !== '') process.stderr.write(launcherStderr)
      resolve()
    }
    launcher.once('error', onError)
    launcher.once('close', onClose)
  })
}

/** Test hook for native browser handoff; production never mutates it. */
export const openerInternals: {
  openBrowser: (url: string, browser?: string) => Promise<void>
} = { openBrowser }
