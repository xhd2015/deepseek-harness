/**
 * The web app's command-line provider: it parses the `dsh --profile web` flag
 * family (`--host`, `--port`, `--trusted-host`, `--no-open`, `--browser`) and
 * the `open [dir]` subcommand, then provides the immutable values as
 * {@link WEB_STARTUP_SERVICE}. Ordinary rows inject that service before reading
 * it from lazy config.
 * @module @deepseek-ai/dsh-web-app/startup
 */

import { Command } from 'commander'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { parseCmdline } from '@deepseek-ai/dsh-cmdline'
import { isWebBrowserId, WEB_BROWSER_IDS, type WebBrowserId } from './browsers.ts'

/** Stable Cordis plugin name. */
export const name = 'web-startup'

/** Services required before the flags can be resolved. */
export const inject = ['cmdlineArgs']

/** Service provided by this ordinary plugin and injected by flag-configured rows. */
export const WEB_STARTUP_SERVICE = 'webStartup'

/** What the web rows read from {@link WEB_STARTUP_SERVICE}. */
export interface WebStartupValues {
  /** `serve` binds the GUI; `open` talks to a running GUI and exits. */
  mode: 'serve' | 'open'
  /** Whether this invocation opens a browser after success. */
  openBrowser: boolean
  /** `--browser` id, absent when the invocation did not name one. */
  browser?: WebBrowserId
  /** Absolute directory for `open`; absent in `serve` mode. */
  directory?: string
  /** Validated initial text and whether to submit it; absent without a prompt source. */
  initialPrompt?: { readonly text: string; readonly submit: boolean }
  /** `--host`, absent when the invocation did not name one. */
  host?: string
  /** `--port`, absent when the invocation did not name one. */
  port?: number
  /** Explicit `--trusted-host` authorities, in argument order. */
  trustedHosts: string[]
}

/** Serve-mode flags, as commander parsed them. */
interface ServeOptions {
  host?: string
  open: boolean
  port?: string
  trustedHost?: string[]
  browser?: string
}

/** `open` subcommand flags. */
interface OpenOptions {
  open: boolean
  browser?: string
  prompt?: string
  promptFile?: string
  submit: boolean
}

/**
 * Reject an unknown `--browser` spelling.
 * @param program - commander command that owns the flag.
 * @param value - raw flag value.
 * @returns the accepted id.
 */
function requireBrowser(program: Command, value: string | undefined): WebBrowserId | undefined {
  if (value === undefined) return undefined
  if (!isWebBrowserId(value)) {
    program.error(`error: --browser must be one of ${WEB_BROWSER_IDS.join(', ')}; got ${JSON.stringify(value)}`)
  }
  return value
}

/**
 * This app's command: its flags, its description, and its help text.
 * @returns a fresh program, so one process can parse more than once (tests).
 */
function webCommand(): Command {
  const program = new Command()
    .name('dsh --profile web')
    .description('Serve the DeepSeek Harness browser UI.')
    .enablePositionalOptions()
    .helpOption('-h, --help', 'show this help')
    .option('--host <host>', 'bind host')
    .option('--no-open', 'do not open a browser')
    .option('--port <port>', 'listen port; pass 0 to let the OS pick a free one')
    .option('--trusted-host <authority...>', 'extra authority the /api browser-trust fence accepts (host or host:port; repeatable)')
    .option('--browser <name>', `browser to open (${WEB_BROWSER_IDS.join(', ')})`)
    .addHelpText('after', `
Examples:
  dsh --profile web                          serve on the composed host and port
  dsh --profile web --no-open                serve without opening a browser
  dsh --profile web --browser brave          serve and open Brave
  dsh --profile web --port 8080              serve on another port
  dsh --profile web open                     new session for cwd in the running GUI
  dsh --profile web open ~/proj --browser brave
`)
  program.command('open')
    .description('Create a session for a directory and open it in the running Web UI.')
    .argument('[dir]', 'workspace directory (default: current working directory)')
    .option('--no-open', 'create the session without opening a browser')
    .option('-p, --prompt <text>', 'initial prompt to submit')
    .option('--prompt-file <file>', 'read the initial prompt from a UTF-8 file (relative to invoking cwd)')
    .option('--no-submit', 'save the initial prompt as an editable draft')
    .option('--browser <name>', `browser to open (${WEB_BROWSER_IDS.join(', ')})`)
    .helpOption('-h, --help', 'show this help')
  return program
}

function publishServe(ctx: Context, program: Command): void {
  const options = program.opts<ServeOptions>()
  if (options.host === '0.0.0.0') {
    program.error('error: --host 0.0.0.0 is intentionally not supported yet for safety: it would expose remote code execution to the network; use 127.0.0.1 instead')
  }
  if (options.port !== undefined && !/^\d+$/.test(options.port)) {
    program.error(`error: --port must be a number, got ${JSON.stringify(options.port)}`)
  }
  const browser = requireBrowser(program, options.browser)
  delete process.env.DSH_WEB_OPEN
  ctx.provide(WEB_STARTUP_SERVICE, {
    mode: 'serve',
    openBrowser: options.open,
    ...browser !== undefined && { browser },
    ...options.host !== undefined && { host: options.host },
    ...options.port !== undefined && { port: Number(options.port) },
    trustedHosts: options.trustedHost ?? [],
  } satisfies WebStartupValues)
}

function publishOpen(ctx: Context, program: Command, dir: string | undefined, options: OpenOptions): void {
  const parent = program.parent
  const inherited = parent?.opts<ServeOptions>().browser
  const browser = requireBrowser(program, options.browser ?? inherited)
  const initialPrompt = resolveInitialPrompt(program, options)
  process.env.DSH_WEB_OPEN = '1'
  ctx.provide(WEB_STARTUP_SERVICE, {
    mode: 'open',
    openBrowser: options.open,
    directory: resolve(dir ?? process.cwd()),
    ...initialPrompt !== undefined && { initialPrompt },
    ...browser !== undefined && { browser },
    trustedHosts: [],
  } satisfies WebStartupValues)
}

function resolveInitialPrompt(program: Command, options: OpenOptions): WebStartupValues['initialPrompt'] {
  if (options.prompt !== undefined && options.promptFile !== undefined) {
    program.error('dsh: --prompt and --prompt-file cannot be used together')
  }
  let text = options.prompt
  if (options.promptFile !== undefined) {
    try {
      text = readFileSync(resolve(options.promptFile), 'utf8')
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      program.error(`dsh: cannot read prompt file ${JSON.stringify(options.promptFile)}: ${message}`)
    }
  }
  if (text === undefined) {
    if (!options.submit) program.error('dsh: --no-submit requires --prompt or --prompt-file')
    return undefined
  }
  if (text.trim().length === 0) program.error('dsh: initial prompt must contain non-whitespace text')
  return { text, submit: options.submit }
}

/**
 * Parse and provide the Web invocation as an ordinary Cordis service. The
 * command's action publishes the flags this invocation named; `--host 0.0.0.0`
 * or a non-numeric `--port` is a usage error, so on rejection (and on `--help`)
 * nothing is provided.
 * @param ctx - plugin context carrying the command line.
 */
export function apply(ctx: Context): void {
  const program = webCommand()
  program.action(() => { publishServe(ctx, program) })
  const openCommand = program.commands.find(command => command.name() === 'open')
  if (openCommand === undefined) throw new Error('web-startup: open subcommand missing')
  openCommand.action((dir: string | undefined) => {
    publishOpen(ctx, openCommand, dir, openCommand.opts<OpenOptions>())
  })
  parseCmdline(ctx, program)
}
