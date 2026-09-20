/** Durable text-draft synchronization; editor changes take precedence over a pending load. */
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'

interface DraftState {
  readonly draft: string
}

/** Editor and Host operations owned by one Session input lifetime. */
export interface DraftPersistenceDeps {
  readonly state: ObservableSnapshot<DraftState>
  /** Browser-local text has not reached Host storage, including an unsaved clear. */
  readonly hasLocalChanges: boolean
  read(): Promise<string>
  write(text: string): Promise<void>
  adopt(text: string): void
  acknowledge(text: string): void
  failed(error: unknown): void
}

/** Serializes Host writes and coalesces edits while a write is in flight. */
export class DraftPersistence {
  private pending: string | undefined
  private readonly loaded: Promise<void>
  private loading = true
  private writing: Promise<void> | undefined
  private disposed = false
  private readonly unsubscribe: () => void
  private text: string
  private changed = false

  constructor(private readonly deps: DraftPersistenceDeps) {
    this.text = deps.state.getSnapshot().draft
    this.unsubscribe = deps.state.subscribe(() => {
      const text = deps.state.getSnapshot().draft
      if (text === this.text) return
      this.text = text
      this.changed = true
      this.pending = text
      this.flush()
    })
    this.loaded = this.load()
  }

  private async load(): Promise<void> {
    try {
      const text = await this.deps.read()
      if (this.disposed) return
      if (!this.changed && !this.deps.hasLocalChanges) {
        this.text = text
        this.deps.adopt(text)
        this.deps.acknowledge(text)
      } else if (this.text !== text) {
        this.pending = this.text
      } else {
        this.deps.acknowledge(text)
      }
    } catch (error) {
      if (!this.disposed) this.deps.failed(error)
    } finally {
      this.loading = false
      this.flush()
    }
  }

  private flush(): void {
    if (this.loading || this.writing !== undefined || this.pending === undefined) return
    this.writing = this.drain().finally(() => {
      this.writing = undefined
      if (this.pending !== undefined) this.flush()
    })
  }

  private async drain(): Promise<void> {
    while (this.pending !== undefined) {
      const text = this.pending
      this.pending = undefined
      try {
        await this.deps.write(text)
        if (!this.disposed) this.deps.acknowledge(text)
      } catch (error) {
        if (!this.disposed) this.deps.failed(error)
      }
    }
  }

  /** Stop observing the editor and await writes already accepted from it. */
  async dispose(): Promise<void> {
    this.disposed = true
    this.unsubscribe()
    await this.loaded
    this.flush()
    await this.writing
  }
}
