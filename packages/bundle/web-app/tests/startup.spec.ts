/**
 * The Web command-line provider over a real Loader tree: its ordinary service
 * releases a consumer whose config reads `ctx.webStartup` directly.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { internals, provideCmdline } from '@deepseek-ai/dsh-cmdline'
import { afterEach, describe, expect, it } from 'vitest'
import { apply, WEB_STARTUP_SERVICE, type WebStartupValues } from '../src/startup.ts'

/** What one fixture boot observed. */
interface Observed {
  exits: number[]
  out: string
  readerConfig?: unknown
}

const disposers: (() => Promise<void>)[] = []

/** Fixture tree roots, removed after their booted tree has been disposed. */
const tempDirs: string[] = []

afterEach(async () => {
  for (const dispose of disposers.splice(0)) await dispose()
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  internals.stdout = process.stdout
  internals.stderr = process.stderr
})

/**
 * Mount the real provider and a consumer using injection-ordered config.
 * @param args - the invocation's inner arguments.
 * @returns the service value and observed consumer/process effects.
 */
async function bootProvider(args: string[]): Promise<{
  values: WebStartupValues | undefined
  observed: Observed
}> {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-web-startup-'))
  tempDirs.push(dir)
  const observed: Observed = { exits: [], out: '' }
  writeFileSync(join(dir, 'reader.mjs'), `
export function apply(_ctx, config) { globalThis.__webStartupObserved.readerConfig = config }
`)
  // Node imports the fixture row outside Vite's source resolver, so delegate
  // to the source-plane plugin already imported by this test.
  writeFileSync(join(dir, 'provider.mjs'), `
export const name = 'web-startup'
export const inject = ['cmdlineArgs']
export const apply = ctx => globalThis.__webStartupApply(ctx)
`)
  writeFileSync(join(dir, 'cordis.yml'), [
    '- id: reader',
    `  name: ${pathToFileURL(join(dir, 'reader.mjs')).href}`,
    `  inject: [${WEB_STARTUP_SERVICE}]`,
    '  config:',
    "    host: !!js ctx.webStartup.host ?? '127.0.0.1'",
    '    openBrowser: !!js ctx.webStartup.openBrowser',
    '    port: !!js ctx.webStartup.port ?? 3080',
    '    trustedHosts: !!js ctx.webStartup.trustedHosts',
    '    disableAuth: !!js ctx.webStartup.disableAuth === true',
    '- id: provider',
    `  name: ${pathToFileURL(join(dir, 'provider.mjs')).href}`,
    '',
  ].join('\n'))
  const observing = { write: (chunk: string) => { observed.out += chunk; return true } }
  internals.stdout = observing
  internals.stderr = observing
  const globals = globalThis as unknown as {
    __webStartupApply: typeof apply
    __webStartupObserved: Observed
  }
  globals.__webStartupApply = apply
  globals.__webStartupObserved = observed

  const ctx = new Context()
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  provideCmdline(ctx, { args, exit: code => void observed.exits.push(code) })
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(join(dir, 'cordis.yml')).href } })
  await ctx.loader.await()
  disposers.push(async () => { await ctx.fiber.dispose() })
  return {
    values: ctx.get(WEB_STARTUP_SERVICE) as WebStartupValues | undefined,
    observed,
  }
}

describe('web command-line provider', () => {
  it('publishes each flag and releases direct service expressions', async () => {
    const { values, observed } = await bootProvider([
      '--host', '127.0.0.1',
      '--no-open',
      '--port', '8080',
      '--trusted-host', 'lab.internal', 'lab-2.internal',
      '--trusted-host', '10.0.0.9',
    ])
    expect(values).toEqual({
      mode: 'serve',
      host: '127.0.0.1',
      openBrowser: false,
      port: 8080,
      trustedHosts: ['lab.internal', 'lab-2.internal', '10.0.0.9'],
      disableAuth: false,
    })
    expect(observed.readerConfig).toEqual({
      host: '127.0.0.1',
      openBrowser: false,
      port: 8080,
      trustedHosts: ['lab.internal', 'lab-2.internal', '10.0.0.9'],
      disableAuth: false,
    })
    expect(observed.exits).toEqual([])
  })

  it('leaves deployment values to each consumer when flags omit them', async () => {
    const { values, observed } = await bootProvider([])
    expect(values).toEqual({ mode: 'serve', openBrowser: true, trustedHosts: [], disableAuth: false })
    expect(observed.readerConfig).toEqual({
      host: '127.0.0.1',
      openBrowser: true,
      port: 3080,
      trustedHosts: [],
      disableAuth: false,
    })
  })

  it('publishes disableAuth from --no-auth', async () => {
    const { values, observed } = await bootProvider(['--no-auth'])
    expect(values?.disableAuth).toBe(true)
    expect(observed.readerConfig).toEqual({
      host: '127.0.0.1',
      openBrowser: true,
      port: 3080,
      trustedHosts: [],
      disableAuth: true,
    })
  })

  it('publishes a named browser on serve', async () => {
    const { values } = await bootProvider(['--browser', 'brave'])
    expect(values).toMatchObject({ mode: 'serve', browser: 'brave', openBrowser: true })
  })

  it('rejects an unknown --browser spelling', async () => {
    const { values, observed } = await bootProvider(['--browser', 'lynx'])
    expect(observed.out).toContain('--browser must be one of')
    expect(values).toBeUndefined()
    expect(observed.exits).toEqual([1])
  })

  it('accepts --browser=brave on open', async () => {
    const { values } = await bootProvider(['open', '--browser=brave'])
    expect(values).toMatchObject({ mode: 'open', browser: 'brave', openBrowser: true })
  })

  it('publishes open mode for a directory', async () => {
    const { values } = await bootProvider(['open', '/tmp/proj', '--browser', 'brave'])
    expect(values).toMatchObject({
      mode: 'open',
      openBrowser: true,
      browser: 'brave',
    })
    expect(values?.directory).toContain('proj')
  })

  it.each(['-p', '--prompt'])('accepts %s without trimming the prompt', async (flag) => {
    const text = '  Implement task\n保留换行\n'
    const { values } = await bootProvider(['open', flag, text])
    expect(values?.initialPrompt).toEqual({ text, submit: true })
  })

  it('reads a long UTF-8 prompt file relative to invoking cwd, not the target directory', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-web-prompt-'))
    tempDirs.push(dir)
    const file = join(dir, 'task.txt')
    const text = '实现任务\r\n'.repeat(100_000)
    writeFileSync(file, text)
    const { values } = await bootProvider([
      'open', join(dir, 'workspace'), '--prompt-file', relative(process.cwd(), file), '--no-submit', '--no-open',
    ])
    expect(values?.initialPrompt).toEqual({ text, submit: false })
    expect(values?.openBrowser).toBe(false)
  })

  it.each([
    [['-p', 'Task', '--prompt-file', 'task.txt'], '--prompt and --prompt-file cannot be used together'],
    [['--no-submit'], '--no-submit requires --prompt or --prompt-file'],
    [['-p', ' \n\t'], 'initial prompt must contain non-whitespace text'],
    [['--prompt', ''], 'initial prompt must contain non-whitespace text'],
  ])('rejects invalid prompt arguments %j before publishing startup', async (args, message) => {
    const { values, observed } = await bootProvider(['open', ...args])
    expect(values).toBeUndefined()
    expect(observed.readerConfig).toBeUndefined()
    expect(observed.exits).toEqual([1])
    expect(observed.out).toContain(message)
  })

  it('rejects unreadable and blank prompt files before publishing startup', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-web-prompt-'))
    tempDirs.push(dir)
    const file = join(dir, 'task.txt')
    const missing = await bootProvider(['open', '--prompt-file', file])
    expect(missing.values).toBeUndefined()
    expect(missing.observed.out).toContain('cannot read prompt file')
    expect(missing.observed.exits).toEqual([1])
    writeFileSync(file, '\r\n \t')
    const blank = await bootProvider(['open', '--prompt-file', file])
    expect(blank.values).toBeUndefined()
    expect(blank.observed.out).toContain('initial prompt must contain non-whitespace text')
    expect(blank.observed.exits).toEqual([1])
  })

  it('documents prompt sources and draft mode in open help', async () => {
    const { values, observed } = await bootProvider(['open', '-h'])
    expect(values).toBeUndefined()
    expect(observed.exits).toEqual([0])
    expect(observed.out).toContain('-p, --prompt <text>')
    expect(observed.out).toContain('--prompt-file <file>')
    expect(observed.out).toContain('--no-submit')
  })

  it('prints its own help and leaves the consumer pending', async () => {
    const { values, observed } = await bootProvider(['--help'])
    expect(observed.out).toContain('dsh --profile web')
    expect(observed.out).toContain('--no-open')
    expect(observed.out).toContain('--trusted-host')
    expect(values).toBeUndefined()
    expect(observed.readerConfig).toBeUndefined()
    expect(observed.exits).toEqual([0])
  })

  it('rejects a non-numeric port before the consumer activates', async () => {
    const { values, observed } = await bootProvider(['--port', 'abc'])
    expect(observed.out).toContain('--port must be a number')
    expect(values).toBeUndefined()
    expect(observed.readerConfig).toBeUndefined()
    expect(observed.exits).toEqual([1])
  })

  it('rejects the intentionally unsupported all-interfaces host before the consumer activates', async () => {
    const { values, observed } = await bootProvider(['--host', '0.0.0.0'])
    expect(observed.out).toContain('--host 0.0.0.0 is intentionally not supported yet for safety: it would expose remote code execution to the network; use 127.0.0.1 instead')
    expect(values).toBeUndefined()
    expect(observed.readerConfig).toBeUndefined()
    expect(observed.exits).toEqual([1])
  })
})
