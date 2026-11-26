// @vitest-environment jsdom
/** The thinking-cap auto-continue failure banner. */

import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { AutoContinueToast, type AutoContinueToastProps } from '../src/client/AutoContinueToast.tsx'
import { zh } from '../src/client/locales.ts'

const t = ((key: keyof typeof zh) => zh[key]) as never

describe('AutoContinueToast', () => {
  it('renders nothing until a write is refused, then names the failure', () => {
    const store = createSnapshotStore<{ seq: number } | null>(null)
    const dismiss = vi.fn()
    const props: AutoContinueToastProps = {
      useAutoContinueError: (select => select(store.getSnapshot())) as AutoContinueToastProps['useAutoContinueError'],
      dismissAutoContinueError: dismiss,
      t,
    }

    const { rerender } = render(<AutoContinueToast {...props} />)
    expect(screen.queryByText(zh['toast.autoContinueFailed'])).toBeNull()

    store.set({ seq: 1 })
    rerender(<AutoContinueToast {...props} />)
    expect(screen.getByText(zh['toast.autoContinueFailed'])).toBeTruthy()
  })
})
