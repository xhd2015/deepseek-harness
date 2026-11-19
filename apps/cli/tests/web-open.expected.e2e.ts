/** Assembled `dsh web open` output and RPC delivery against an isolated running-host fixture. */
import { createServer } from 'node:http'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execa } from 'execa'
import { resolveExampleLaunch } from '@deepseek-ai/dsh-loader-smoke'
import { describe, expect, it, type TestContext } from 'vitest'

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url))

interface RpcCall {
  method: string
  request: Record<string, unknown>
  authenticated: boolean
}

interface Fixture {
  root: string
  calls: RpcCall[]
  run: (args: string[]) => Promise<{ stdout: string; stderr: string; exitCode: number | undefined }>
}

async function withRunningHost(test: TestContext, inspect: (fixture: Fixture) => Promise<void>): Promise<void> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-web-open-expected-')))
  const home = join(root, '.dsh')
  const calls: RpcCall[] = []
  const server = createServer((request, response) => {
    let body = ''
    request.setEncoding('utf8')
    request.on('data', (chunk: string) => { body += chunk })
    request.on('end', () => {
      const envelope = JSON.parse(body) as {
        rpcId: string
        method: string
        payload: { args: { request: Record<string, unknown> } }
      }
      calls.push({ method: envelope.method, request: envelope.payload.args.request, authenticated: request.headers.authorization === 'Bearer fixture-token' })
      const value = envelope.method === 'workspace/create'
        ? { workspace: { workspaceId: 'fixture-workspace' } }
        : envelope.method === 'session/create'
          ? { sessionId: 'fixture-session' }
          : envelope.method === 'session/setDraft'
            ? { text: envelope.payload.args.request.text }
            : { accepted: true }
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ type: 'server-response', rpcId: envelope.rpcId, result: { ok: true, value } }))
    })
  })
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('host fixture did not bind TCP')
    await mkdir(home)
    await writeFile(join(home, 'web-listen.json'), JSON.stringify({ pid: process.pid, origin: `http://127.0.0.1:${address.port}`, token: 'fixture-token' }))
    await inspect({
      root,
      calls,
      async run(args) {
        const launch = resolveExampleLaunch({
          srcBin: join(repoRoot, 'apps/cli/src/bin.ts'),
          tsconfigPath: join(repoRoot, 'tsconfig.json'),
          configArgs: ['web', 'open', ...args],
          env: {
            DSH_HOME: home,
            DSH_AGENTS_HOME: join(root, '.agents'),
            DSH_TELEMETRY_DISABLED: '1',
            DEEPSEEK_API_KEY: 'keyless-web-open-no-model',
            NODE_NO_WARNINGS: '1',
          },
        })
        const result = await execa(launch.command, launch.args, {
          cwd: root,
          env: { ...process.env, ...launch.env },
          stdin: 'ignore',
          cancelSignal: test.signal,
          timeout: test.task.timeout,
          killSignal: 'SIGKILL',
          reject: false,
          stripFinalNewline: false,
        })
        expect(result.timedOut, result.stderr).toBe(false)
        expect(result.signal, result.stderr).toBeUndefined()
        return { stdout: result.stdout.split(join(root, 'workspace')).join('{{cwd}}/workspace').split(root).join('{{cwd}}'), stderr: result.stderr, exitCode: result.exitCode }
      },
    })
  } finally {
    try {
      if (server.listening) {
        server.closeAllConnections()
        await new Promise<void>((resolve, reject) => {
          server.close((error) => {
            if (error === undefined) resolve()
            else reject(error)
          })
        })
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }
}

describe('dsh web open assembled prompt delivery', () => {
  it('creates an empty session when no prompt source is supplied', async (test) => {
    await withRunningHost(test, async ({ calls, run }) => {
      const result = await run(['--no-open'])
      expect(calls.map(call => call.method)).toEqual(['workspace/create', 'session/create'])
      expect(result).toMatchInlineSnapshot(`
        {
          "exitCode": 0,
          "stderr": "",
          "stdout": "dsh web: created fixture-session in {{cwd}}
        ",
        }
      `)
    })
  })

  it('submits an inline initial prompt through the running host without launching a browser', async (test) => {
    await withRunningHost(test, async ({ root, calls, run }) => {
      const text = 'Implement the task.\n保留换行\n'
      const result = await run(['--no-open', '-p', text])
      expect(calls.map(call => call.method)).toEqual(['workspace/create', 'session/create', 'session/prompt'])
      expect(calls.every(call => call.authenticated)).toBe(true)
      expect(calls[0]?.request).toEqual({ path: root })
      expect(calls[1]?.request).toEqual({ workspaceId: 'fixture-workspace' })
      const request = calls[2]?.request
      expect(request?.requestId).toMatch(/^[0-9a-f-]{36}$/u)
      expect({ ...request, requestId: '{{request-id}}' }).toEqual({
        sessionId: 'fixture-session', requestId: '{{request-id}}', mode: 'queue', content: [{ type: 'text', text }],
      })
      expect(result).toMatchInlineSnapshot(`
        {
          "exitCode": 0,
          "stderr": "",
          "stdout": "dsh web: created fixture-session in {{cwd}}
        dsh web: submitted initial prompt
        ",
        }
      `)
    })
  })

  it('stages a large relative prompt file unchanged without admitting a prompt', async (test) => {
    await withRunningHost(test, async ({ root, calls, run }) => {
      const text = '实现任务\r\n'.repeat(100_000)
      await writeFile(join(root, 'task.txt'), text)
      await mkdir(join(root, 'workspace'))
      const result = await run(['workspace', '--no-open', '--no-submit', '--prompt-file', 'task.txt'])
      expect(calls.map(call => call.method)).toEqual(['workspace/create', 'session/create', 'session/setDraft'])
      expect(calls.every(call => call.authenticated)).toBe(true)
      expect(calls[0]?.request).toEqual({ path: join(root, 'workspace') })
      expect(calls[2]?.request).toEqual({ sessionId: 'fixture-session', text })
      expect(result).toMatchInlineSnapshot(`
        {
          "exitCode": 0,
          "stderr": "",
          "stdout": "dsh web: created fixture-session in {{cwd}}/workspace
        dsh web: saved initial draft
        ",
        }
      `)
    })
  })

  it('rejects an unreadable prompt file before contacting the running host', async (test) => {
    await withRunningHost(test, async ({ calls, run }) => {
      const result = await run(['--no-open', '--prompt-file', 'missing.txt'])
      expect(calls).toEqual([])
      expect(result.exitCode).toBe(1)
      expect(result.stdout).toBe('')
      expect(result.stderr).toContain('dsh: cannot read prompt file "missing.txt":')
    })
  })
})
