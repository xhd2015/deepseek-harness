// @vitest-environment jsdom
/**
 * `visibleViewportRect` / `observeVisibleViewport`: the visible band anchored
 * overlays clamp against, and the events that move it.
 *
 * jsdom has no `visualViewport`, so the fallback path is asserted with the
 * global explicitly removed and the band path installs a stub.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { observeVisibleViewport, visibleViewportRect } from '../src/visible-viewport.ts'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

/** An installable `visualViewport` double carrying the given band. */
function stubViewport(band: { offsetLeft?: number; offsetTop?: number; width?: number; height?: number }): VisualViewport {
  return Object.assign(new EventTarget(), band) as VisualViewport
}

describe('visibleViewportRect', () => {
  it('falls back to the layout viewport when visualViewport is missing', () => {
    vi.stubGlobal('visualViewport', undefined)
    vi.stubGlobal('innerWidth', 1000)
    vi.stubGlobal('innerHeight', 800)
    expect(visibleViewportRect()).toEqual({ left: 0, top: 0, width: 1000, height: 800 })
  })

  it('reports the visual viewport band in layout coordinates', () => {
    vi.stubGlobal('visualViewport', stubViewport({ offsetLeft: 5, offsetTop: 300, width: 500, height: 400 }))
    expect(visibleViewportRect()).toEqual({ left: 5, top: 300, width: 500, height: 400 })
  })
})

describe('observeVisibleViewport', () => {
  it('wires window and visual viewport events and unwires them again', () => {
    const viewport = stubViewport({})
    vi.stubGlobal('visualViewport', viewport)
    const windowAdd = vi.spyOn(window, 'addEventListener')
    const windowRemove = vi.spyOn(window, 'removeEventListener')
    const viewportAdd = vi.spyOn(viewport, 'addEventListener')
    const viewportRemove = vi.spyOn(viewport, 'removeEventListener')
    const handler = (): void => {}

    const dispose = observeVisibleViewport(handler)

    expect(windowAdd.mock.calls.filter(([type]) => type === 'scroll' || type === 'resize').map(([type]) => type)).toEqual(['scroll', 'resize'])
    expect(viewportAdd.mock.calls.map(([type]) => type)).toEqual(['resize', 'scroll'])

    dispose()

    expect(windowRemove.mock.calls.filter(([type]) => type === 'scroll' || type === 'resize').map(([type]) => type)).toEqual(['scroll', 'resize'])
    expect(viewportRemove.mock.calls.map(([type]) => type)).toEqual(['resize', 'scroll'])
  })
})
