import type { UserConfig } from 'tsdown'
import { clientBundle } from '../../client/tsdown.client.ts'

/** Self-contained module Worker served by the Gateway Host route. */
const sharedMuxWorker: UserConfig = {
  entry: ['lib/types/client/shared-mux-worker.js'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'browser',
  target: 'es2022',
  dts: false,
  clean: false,
  sourcemap: true,
  deps: { alwaysBundle: () => true },
  codeSplitting: false,
  outputOptions: { entryFileNames: 'shared-mux-worker.js' },
}

export default clientBundle('@deepseek-ai/dsh-api-gateway', ['lib/types/index.js'], {
  companions: [sharedMuxWorker],
})
