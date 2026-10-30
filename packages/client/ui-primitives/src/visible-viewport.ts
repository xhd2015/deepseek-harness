/** The viewport band anchored overlays clamp against, so keyboard pans keep them visible. */

/**
 * The visible band in layout-viewport coordinates.
 *
 * iOS keeps the layout viewport unchanged when the keyboard opens and pans and
 * shrinks the visual viewport instead, so `window.innerWidth`/`innerHeight`
 * overstate what the user can see and fixed-position overlays drift under the
 * keyboard. `visualViewport` reports the visible band in layout coordinates;
 * anchored placement clamps against this rather than the raw window size.
 */
export interface VisibleViewportRect {
  /** Distance from the layout viewport's left edge to the visible band's left edge. */
  left: number
  /** Distance from the layout viewport's top edge to the visible band's top edge. */
  top: number
  /** Visible width in layout CSS pixels. */
  width: number
  /** Visible height in layout CSS pixels. */
  height: number
}

/**
 * Read the visible band, falling back to the layout viewport where
 * `visualViewport` is missing (jsdom, older browsers).
 * @returns the band rectangle in layout-viewport CSS pixels.
 */
export function visibleViewportRect(): VisibleViewportRect {
  const viewport = window.visualViewport
  if (viewport == null) return { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight }
  return { left: viewport.offsetLeft, top: viewport.offsetTop, width: viewport.width, height: viewport.height }
}

/**
 * Subscribe to the events that move or resize the visible band: window
 * scrolling and resizing, and — the ones iOS keyboards fire — the visual
 * viewport's own `resize` and `scroll`.
 * @param handler - called with no arguments whenever the band may have moved.
 * @returns a disposer that removes every listener again.
 */
export function observeVisibleViewport(handler: () => void): () => void {
  window.addEventListener('scroll', handler, true)
  window.addEventListener('resize', handler)
  const viewport = window.visualViewport
  viewport?.addEventListener('resize', handler)
  viewport?.addEventListener('scroll', handler)
  return () => {
    window.removeEventListener('scroll', handler, true)
    window.removeEventListener('resize', handler)
    viewport?.removeEventListener('resize', handler)
    viewport?.removeEventListener('scroll', handler)
  }
}
