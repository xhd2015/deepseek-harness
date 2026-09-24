/** Draft synchronization races use explicit deferred Host operations. */
import { describe, expect, it, vi } from 'vitest'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { DraftPersistence } from '../src/client/input/draft-persistence.ts'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function fixture(text = '') {
  const state = createSnapshotStore({ draft: text })
  const read = deferred<string>()
  const adopt = vi.fn((draft: string) => { state.set({ draft }) })
  const write = vi.fn(async (_text: string) => {})
  const failed = vi.fn()
  return { state, read, adopt, write, failed, acknowledge: vi.fn(), hasLocalChanges: text !== '' }
}

function start(f: ReturnType<typeof fixture>) {
  return new DraftPersistence({ ...f, read: () => f.read.promise })
}

describe('durable composer draft synchronization', () => {
  it('adopts a Host draft without rewriting it or submitting a message', async () => {
    const f = fixture()
    const sync = start(f)
    f.read.resolve('task\nwith Unicode 世界\n')
    await f.read.promise
    expect(f.adopt).toHaveBeenCalledWith('task\nwith Unicode 世界\n')
    expect(f.write).not.toHaveBeenCalled()
    await sync.dispose()
  })

  it('keeps browser-local recovery text ahead of an older Host value', async () => {
    const f = fixture('local edit')
    const sync = start(f)
    f.read.resolve('old seed')
    await f.read.promise
    await sync.dispose()
    expect(f.adopt).not.toHaveBeenCalled()
    expect(f.write).toHaveBeenCalledWith('local edit')
  })

  it.each(['', 'new Host text'])('does not resurrect a clean browser mirror over Host value %j', async (host) => {
    const f = fixture('previously acknowledged text')
    f.hasLocalChanges = false
    const sync = start(f)
    f.read.resolve(host)
    await f.read.promise
    expect(f.adopt).toHaveBeenCalledWith(host)
    expect(f.acknowledge).toHaveBeenCalledWith(host)
    expect(f.write).not.toHaveBeenCalled()
    await sync.dispose()
  })

  it('preserves a browser-local clear when the Host still has an old seed', async () => {
    const f = fixture()
    f.hasLocalChanges = true
    const sync = start(f)
    f.read.resolve('old seed')
    await f.read.promise
    await sync.dispose()
    expect(f.adopt).not.toHaveBeenCalled()
    expect(f.write).toHaveBeenCalledExactlyOnceWith('')
  })

  it('does not overwrite typing or a discard while loading', async () => {
    const f = fixture()
    const sync = start(f)
    f.state.set({ draft: 'typed' })
    f.state.set({ draft: '' })
    f.read.resolve('initial task')
    await f.read.promise
    await sync.dispose()
    expect(f.adopt).not.toHaveBeenCalled()
    expect(f.write).toHaveBeenCalledExactlyOnceWith('')
  })

  it('serializes writes and coalesces intervening edits including a clear', async () => {
    const f = fixture()
    const first = deferred<undefined>()
    f.write.mockImplementationOnce(() => first.promise)
    const sync = start(f)
    f.read.resolve('')
    await f.read.promise
    f.state.set({ draft: 'one' })
    f.state.set({ draft: 'two' })
    f.state.set({ draft: '' })
    expect(f.write.mock.calls).toEqual([['one']])
    first.resolve(undefined)
    await sync.dispose()
    expect(f.write.mock.calls).toEqual([['one'], ['']])
  })

  it('surfaces load failure without clearing local text and still saves later edits', async () => {
    const f = fixture('local')
    const sync = start(f)
    f.read.reject(new Error('offline'))
    await f.read.promise.catch(() => {})
    expect(f.failed).toHaveBeenCalledOnce()
    expect(f.adopt).not.toHaveBeenCalled()
    f.state.set({ draft: 'next' })
    await sync.dispose()
    expect(f.write).toHaveBeenCalledWith('next')
  })

  it('contains a failed write and allows the next edit', async () => {
    const f = fixture()
    f.write.mockRejectedValueOnce(new Error('offline'))
    const sync = start(f)
    f.read.resolve('')
    await f.read.promise
    f.state.set({ draft: 'one' })
    f.state.set({ draft: 'two' })
    await sync.dispose()
    expect(f.write.mock.calls).toEqual([['one'], ['two']])
    expect(f.state.getSnapshot().draft).toBe('two')
  })

  it('disposal waits for loading, suppresses late adoption and stops observations', async () => {
    const f = fixture()
    const sync = start(f)
    const done = vi.fn()
    const disposing = sync.dispose().then(done)
    expect(done).not.toHaveBeenCalled()
    f.read.resolve('late')
    await disposing
    f.state.set({ draft: 'after disposal' })
    expect(f.adopt).not.toHaveBeenCalled()
    expect(f.write).not.toHaveBeenCalled()
  })
})
