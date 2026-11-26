import * as ClientStore from '@deepseek-ai/dsh-client-store'
import type { ClientBundleRequire } from '@deepseek-ai/dsh-package-manifest'
import { describe, expect, it } from 'vitest'
import { PLATFORM_MODULES } from '../src/platform.ts'
import { getSourceStaticModules } from '../src/seed.ts'

/** Source registrations are already materialized, so their factories resolve nothing. */
const unusedRequire: ClientBundleRequire = Object.assign(
  () => { throw new Error('seed: a source registration resolves no dependencies') },
  {
    async: async () => { throw new Error('seed: a source registration loads no dependencies') },
    asset: (reference: string) => reference,
  },
)

describe('getSourceStaticModules', () => {
  it('seeds every platform module once, in baseline order', () => {
    expect(getSourceStaticModules().map(row => row.id)).toEqual([...PLATFORM_MODULES])
  })

  it('hands the loader the imported source namespace itself', () => {
    const store = getSourceStaticModules().find(row => row.id === '@deepseek-ai/dsh-client-store')
    expect(store?.factory(unusedRequire)).toBe(ClientStore)
  })

  it('carries no compiled stylesheet metadata', () => {
    for (const row of getSourceStaticModules()) expect(row.meta).toBeUndefined()
  })
})
