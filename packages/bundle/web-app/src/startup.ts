/**
 * The web app's command-line provider: it parses the `dsh --profile web` flag
 * family (`--host`, `--port`, `--public-url`, `--trusted-host`, `--no-open`,
 * `--browser`, TLS) and the `open [dir]` subcommand, then provides the
 * immutable values as {@link WEB_STARTUP_SERVICE}. Ordinary rows inject that
 * service before reading it from lazy config.
 * @module @deepseek-ai/dsh-web-app/startup
 */

import { Command } from 'commander'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { API_PATH, assertApiPrefix } from '@deepseek-ai/dsh-client-connection'
import { parseCmdline } from '@deepseek-ai/dsh-cmdline'
import { isWildcardHost, type TlsConfig } from '@deepseek-ai/dsh-host-webserver'
import { isWebBrowserId, WEB_BROWSER_IDS, type WebBrowserId } from './browsers.ts'
import { parsePublicUrl } from './public-url.ts'

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
  /** `--host` addresses in argument order, absent when the invocation named none. */
  hosts?: string[]
  /** `--port`, absent when the invocation did not name one. */
  port?: number
  /**
   * `--public-url`, absent when not specified: the advertised HTTP(S) root.
   * See [public deployments](../README.md#public-deployments).
   */
  publicUrl?: string
  /**
   * `--no-auth`: skip process-token and cookie checks. Host/Origin trust still
   * applies, so it fits a deployment behind an authenticating outer proxy.
   */
  disableAuth?: boolean
  /**
   * `--trusted-host-for-settings` authorities: pages served there may read and
   * write the Host settings document. Every entry is also a `trustedHosts` one.
   */
  trustedHostsForSettings?: string[]
  /** Explicit `--trusted-host` authorities, in argument order. */
  trustedHosts: string[]
  /**
   * `--api-prefix`: absolute HTTP prefix of the shared API channel. Defaults to
   * `/api`; a nested value such as `/api/dsh` nests the channel under a host
   * that already owns `/api`.
   */
  apiPrefix: string
  /** Server certificate chain and unencrypted private key supplied together. */
  tls?: TlsConfig
}

/** Collect repeated `--host` values in argument order. */
function collectHost(value: string, previous: string[] | undefined): string[] {
  return [...previous ?? [], value]
}

/** Serve-mode flags, as commander parsed them. */
interface ServeOptions {
  host?: string[]
  open: boolean
  /** `--no-auth` sets commander's negated `auth` flag to false. */
  auth?: boolean
  port?: string
  publicUrl?: string
  trustedHost?: string[]
  trustedHostForSettings?: string[]
  tlsCert?: string
  tlsKey?: string
  browser?: string
  apiPrefix?: string
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
 * Resolve `--api-prefix`, rejecting a value the transport cannot address.
 * @param program - commander program carrying this invocation.
 * @param value - raw flag value, absent when not specified.
 * @returns the validated prefix, or `/api` when absent.
 */
function requireApiPrefix(program: Command, value: string | undefined): string {
  if (value === undefined) return API_PATH
  try {
    return assertApiPrefix(value)
  } catch (error) {
    program.error(`error: ${(error as Error).message}`)
  }
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
    .option('--host <host>', 'bind address: one concrete IPv4 or IPv6 literal of a local interface; repeat for several addresses sharing --port; wildcard addresses are rejected', collectHost)
    .option('--no-open', 'do not open the Web UI in a browser')
    .option('--port <port>', 'listen port; pass 0 to let the OS pick a free one')
    .option('--public-url <url>', 'advertise this HTTP(S) root in the printed, opened, runtime-context, and DSH_WEB_URL forms; grants no trust')
    .option('--trusted-host <authority...>', 'extra authority the /api browser-trust fence accepts (host or host:port; repeatable)')
    .option('--trusted-host-for-settings <authority...>', 'authority whose page may also read and write Host settings, including credentials (host or host:port; repeatable; each must also be a --trusted-host)')
    .option('--api-prefix <path>', 'absolute HTTP prefix of the shared API channel (default /api; use /api/dsh when an outer host already owns /api)')
    .option('--tls-cert <file>', 'PEM server certificate chain; requires --tls-key')
    .option('--tls-key <file>', 'unencrypted PEM private key; requires --tls-cert')
    .option('--browser <name>', `browser to open (${WEB_BROWSER_IDS.join(', ')})`)
    .option('--no-auth', 'skip process-token and cookie checks; Host/Origin trust still applies (use behind an authenticating outer proxy)')
    .addHelpText('after', `
Examples:
  dsh --profile web                          serve on the composed host and port
  dsh --profile web --no-open                serve without opening a browser
  dsh --profile web --browser brave          serve and open Brave
  dsh --profile web --port 8080              serve on another port
  dsh --profile web --host 10.0.0.7          bind one local interface address
  dsh --profile web --host 127.0.0.1 --host ::1
                                             serve loopback over IPv4 and IPv6 on one port
  dsh --profile web --trusted-host app.example --trusted-host-for-settings app.example
                                             also let that authority edit Host settings
  dsh --profile web --no-auth --trusted-host app.example
                                             serve behind a proxy that already authenticates
  dsh --profile web --public-url https://app.example/ui/ --trusted-host app.example
                                             advertise a prefix-stripping HTTPS proxy entry and admit its authority
  dsh --profile web --tls-cert ./server-chain.pem --tls-key ./server-key.pem
                                             serve HTTPS with an existing certificate and key
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

/**
 * Publish serve-mode flags. A wildcard host, a non-numeric port, an unpaired
 * TLS file, or a malformed public URL is a usage error.
 * @param ctx - plugin context that receives the service.
 * @param program - the root web command.
 */
function publishServe(ctx: Context, program: Command): void {
  const options = program.opts<ServeOptions>()
  for (const host of options.host ?? []) {
    if (isWildcardHost(host)) {
      program.error(`error: --host ${host} is an unspecified (wildcard) address, which is not supported: binding every interface would expose remote code execution to the network; bind one concrete IPv4 or IPv6 address instead`)
    }
  }
  if (options.port !== undefined && !/^\d+$/.test(options.port)) {
    program.error(`error: --port must be a number, got ${JSON.stringify(options.port)}`)
  }
  let tls: TlsConfig | undefined
  if (options.tlsCert !== undefined && options.tlsKey !== undefined) {
    tls = { certFile: options.tlsCert, keyFile: options.tlsKey }
  } else if (options.tlsCert !== undefined || options.tlsKey !== undefined) {
    program.error('error: --tls-cert and --tls-key must be supplied together')
  }
  if (options.publicUrl !== undefined) {
    try {
      parsePublicUrl(options.publicUrl, '--public-url')
    } catch (error) {
      program.error(`error: ${(error as Error).message}`)
    }
  }
  const trustedHosts = options.trustedHost ?? []
  for (const authority of options.trustedHostForSettings ?? []) {
    // A settings grant is strictly narrower than the fence: an authority the
    // fence rejects can never load the page that would use the grant.
    if (!trustedHosts.includes(authority)) {
      program.error(`error: --trusted-host-for-settings ${authority} is not also a --trusted-host authority`)
    }
  }
  const browser = requireBrowser(program, options.browser)
  delete process.env.DSH_WEB_OPEN
  ctx.provide(WEB_STARTUP_SERVICE, {
    mode: 'serve',
    openBrowser: options.open,
    ...browser !== undefined && { browser },
    ...options.host !== undefined && { hosts: options.host },
    ...options.port !== undefined && { port: Number(options.port) },
    ...options.publicUrl !== undefined && { publicUrl: options.publicUrl },
    ...tls !== undefined && { tls },
    ...options.auth === false && { disableAuth: true },
    ...options.trustedHostForSettings !== undefined && { trustedHostsForSettings: options.trustedHostForSettings },
    trustedHosts,
    apiPrefix: requireApiPrefix(program, options.apiPrefix),
  } satisfies WebStartupValues)
}

/**
 * Publish `open` mode and mark this process so the patch does not bind a second GUI.
 * @param ctx - plugin context that receives the service.
 * @param program - the `open` subcommand.
 * @param dir - positional directory, or the invoking cwd when omitted.
 * @param options - subcommand flags.
 */
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
    // `open` addresses an already-running server, so its prefix is the default.
    apiPrefix: API_PATH,
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
 * command's action publishes the flags this invocation named. Invalid flags,
 * including an unpaired TLS certificate or key, are usage errors; rejection
 * and `--help` provide no service.
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
