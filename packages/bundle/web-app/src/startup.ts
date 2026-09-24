/**
 * The web app's command-line provider: it parses the `dsh --profile web` flag
 * family (`--host`, `--port`, `--trusted-host`, `--trusted-host-for-settings`,
 * `--no-open`, `--no-auth`, `--browser`) and the `open [dir]` subcommand, then
 * provides the immutable values as {@link WEB_STARTUP_SERVICE}. Ordinary rows
 * inject that service before reading it from lazy config.
 * @module @deepseek-ai/dsh-web-app/startup
 */

import { Command } from 'commander'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { assertTrustedAuthority } from '@deepseek-ai/dsh-client-connection'
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
  /**
   * Explicit `--trusted-host-for-settings` authorities, in argument order.
   * Each must also appear in {@link trustedHosts}: the settings grant rides the
   * same fence that admits the page's `/api` traffic.
   */
  trustedHostsForSettings: string[]
  /** When true, skip process-token and cookie checks (outer reverse-proxy auth). */
  disableAuth: boolean
}

/** Serve-mode flags, as commander parsed them. */
interface ServeOptions {
  host?: string
  open: boolean
  port?: string
  trustedHost?: string[]
  trustedHostForSettings?: string[]
  browser?: string
  auth: boolean
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
 * Validate `--trusted-host-for-settings` entries at parse time, before any
 * server binds. Each entry must be a bare authority in the canonical form the
 * fence compares against, and must also be a `--trusted-host`: a settings grant
 * for an authority the fence rejects could never load a page to use it, so the
 * combination is a misconfiguration rather than a narrower grant.
 * @param program - commander command that owns the flag.
 * @param entries - raw flag values, in argument order.
 * @param trustedHosts - the invocation's `--trusted-host` authorities.
 * @returns the accepted authorities, in argument order.
 */
function requireSettingsAuthorities(program: Command, entries: string[], trustedHosts: readonly string[]): string[] {
  for (const entry of entries) {
    try {
      assertTrustedAuthority(entry)
    } catch {
      program.error(`error: --trusted-host-for-settings expects a bare host or host:port, got ${JSON.stringify(entry)}`)
    }
    if (!trustedHosts.includes(entry)) {
      program.error(`error: --trusted-host-for-settings ${JSON.stringify(entry)} is not also a --trusted-host; add --trusted-host ${entry}`)
    }
  }
  return entries
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
    .option('--trusted-host-for-settings <authority...>', 'authority whose page may also read and write Host settings, including credentials (host or host:port; repeatable; each must also be a --trusted-host)')
    .option('--no-auth', 'disable process-token browser authentication (use when an outer reverse proxy already authenticates)')
    .option('--browser <name>', `browser to open (${WEB_BROWSER_IDS.join(', ')})`)
    .addHelpText('after', `
Examples:
  dsh --profile web                          serve on the composed host and port
  dsh --profile web --no-open                serve without opening a browser
  dsh --profile web --browser brave          serve and open Brave
  dsh --profile web --port 8080              serve on another port
  dsh --profile web --no-auth                serve behind an outer authenticating reverse proxy
  dsh --profile web --trusted-host app.internal \\
      --trusted-host-for-settings app.internal   let app.internal edit models and credentials
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
  const trustedHosts = options.trustedHost ?? []
  const trustedHostsForSettings = requireSettingsAuthorities(program, options.trustedHostForSettings ?? [], trustedHosts)
  delete process.env.DSH_WEB_OPEN
  ctx.provide(WEB_STARTUP_SERVICE, {
    mode: 'serve',
    openBrowser: options.open,
    ...browser !== undefined && { browser },
    ...options.host !== undefined && { host: options.host },
    ...options.port !== undefined && { port: Number(options.port) },
    trustedHosts,
    trustedHostsForSettings,
    disableAuth: options.auth === false,
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
    trustedHostsForSettings: [],
    disableAuth: false,
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
