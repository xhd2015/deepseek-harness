/**
 * Identity of the browser-wide Remote mux worker the Gateway serves.
 * @module @deepseek-ai/dsh-api-gateway/shared-mux-worker-route
 */

/**
 * Authenticated same-origin module Worker path serving the browser-wide Remote
 * mux. Host and browser code must agree on this one string, so it lives here
 * rather than in the plugin entry, which exports only what the Loader loads.
 */
export const REMOTE_SHARED_MUX_WORKER_PATH = '/api/remote.shared-mux-worker.js'
