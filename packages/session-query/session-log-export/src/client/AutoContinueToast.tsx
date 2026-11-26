/** Failure banner for thinking-cap auto-continue, hosted in `shell.overlay`. */
import type { ReactNode } from 'react'
import { IconWarningOutlineRegular, Toast } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { InjectFace, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { NS } from './locales.ts'

/** Notice store and dismissal for the auto-continue failure toast. */
export interface AutoContinueToastInjected {
  hooks: { autoContinueError: ObservableSnapshot<{ seq: number } | null> }
  dismissAutoContinueError: () => void
}

/** Overlay props for the auto-continue failure toast. */
export type AutoContinueToastProps =
  InjectFace<AutoContinueToastInjected> & PropsLocale<typeof NS>

/**
 * Show a thinking-cap auto-continue write failure even after the Header menu closes.
 * @param props - notice hook, dismissal, and locale seat.
 * @returns the failure toast, or null when no notice is pending.
 */
export function AutoContinueToast({
  useAutoContinueError, dismissAutoContinueError, t,
}: AutoContinueToastProps): ReactNode {
  const notice = useAutoContinueError(value => value)
  if (notice === null) return null
  return (
    <Toast
      key={notice.seq}
      text={t('toast.autoContinueFailed')}
      icon={<IconWarningOutlineRegular />}
      onDone={dismissAutoContinueError}
    />
  )
}
