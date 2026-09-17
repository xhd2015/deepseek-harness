/**
 * Named browsers `dsh web --browser` may hand a URL to.
 * @module @deepseek-ai/dsh-web-app/browsers
 */

/** Browser ids accepted by `--browser`. */
export const WEB_BROWSER_IDS = ['brave', 'chrome', 'firefox', 'edge', 'safari'] as const

/** One `--browser` id. */
export type WebBrowserId = (typeof WEB_BROWSER_IDS)[number]

/**
 * Whether a flag value is a {@link WebBrowserId}.
 * @param value - candidate `--browser` spelling.
 * @returns true when `value` is one of {@link WEB_BROWSER_IDS}.
 */
export function isWebBrowserId(value: string): value is WebBrowserId {
  return (WEB_BROWSER_IDS as readonly string[]).includes(value)
}
