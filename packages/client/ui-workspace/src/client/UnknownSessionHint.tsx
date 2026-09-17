/** Overlay copy when `?session=` does not name a listed Session. */

import type { ReactNode } from 'react'
import type { HostObservable, InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from './locales.ts'
import css from './UnknownSessionHint.module.css'

/** Whether the current URL names a Session the Host list does not contain. */
export interface UnknownSessionHintInjected {
  readonly hooks: { readonly unknownSession: HostObservable<boolean> }
  /** Hide the hint for this document. */
  readonly dismiss: () => void
}

/**
 * Frame overlay: the `session` query is present but does not match a listed Session.
 * @param props - overlay runtime, locale, and unknown-link store.
 * @returns an alert, or null while the link is usable or dismissed.
 */
export function UnknownSessionHint({
  useUnknownSession, dismiss, t,
}: PropsRuntime<'shell.overlay'> & PropsLocale<'workspace'> & InjectFace<UnknownSessionHintInjected>): ReactNode {
  const unknown = useUnknownSession(value => value)
  if (!unknown) return null
  return <div className={css.notice} role="status">
    <span>{t('link.unknown')}</span>
    <button type="button" onClick={dismiss}>{t('link.dismiss')}</button>
  </div>
}
