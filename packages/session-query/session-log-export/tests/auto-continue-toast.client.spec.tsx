// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useSyncExternalStore } from 'react'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { AutoContinueToast } from '../src/client/AutoContinueToast.tsx'
import { en } from '../src/client/locales.ts'

afterEach(cleanup)

describe('AutoContinueToast', () => {
  it('renders nothing without a notice and shows the failure text when one is pending', () => {
    const store = createSnapshotStore<{ seq: number } | null>(null)
    const dismiss = vi.fn()
    const useAutoContinueError = <T,>(select: (value: { seq: number } | null) => T): T => (
      useSyncExternalStore(listener => store.subscribe(listener), () => select(store.getSnapshot()))
    )
    const view = render(
      <AutoContinueToast
        useAutoContinueError={useAutoContinueError}
        dismissAutoContinueError={dismiss}
        t={key => en[key as keyof typeof en]}
      />,
    )
    expect(view.queryByText(en['toast.autoContinueFailed'])).toBeNull()
    store.set({ seq: 1 })
    view.rerender(
      <AutoContinueToast
        useAutoContinueError={useAutoContinueError}
        dismissAutoContinueError={dismiss}
        t={key => en[key as keyof typeof en]}
      />,
    )
    expect(view.getByText(en['toast.autoContinueFailed'])).toBeTruthy()
  })
})
