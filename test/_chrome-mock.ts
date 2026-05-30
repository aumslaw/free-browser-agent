/**
 * test/_chrome-mock.ts
 *
 * Permissive in-memory `chrome` mock for Node/vitest. MUST be imported BEFORE any
 * src module that touches a chrome.* namespace at top-level (e.g. cdp.ts registers
 * chrome.debugger.onDetach listeners on import). ESM evaluates imported modules in
 * statement order, so importing this first guarantees globalThis.chrome exists
 * before the module graph under test is evaluated.
 *
 * storage.local / storage.session are real in-memory stores (exported for reset);
 * every other namespace is a no-op stub sufficient to satisfy top-level listeners.
 */
type StorageArea = Record<string, unknown>;

export const localStore: StorageArea = {};
export const sessionStore: StorageArea = {};

function makeStorageMock(store: StorageArea) {
  return {
    get: async (key: string | string[]) => {
      if (Array.isArray(key)) return Object.fromEntries(key.map((k) => [k, store[k]]));
      return { [key]: store[key] };
    },
    set: async (obj: StorageArea) => { Object.assign(store, obj); },
    remove: async (key: string | string[]) => {
      (Array.isArray(key) ? key : [key]).forEach((k) => { delete store[k]; });
    },
  };
}

const noop = () => {};
const listener = { addListener: noop, removeListener: noop, hasListener: () => false };

(globalThis as Record<string, unknown>).chrome = {
  storage: { local: makeStorageMock(localStore), session: makeStorageMock(sessionStore) },
  debugger: { onDetach: listener, onEvent: listener, attach: noop, detach: noop, sendCommand: async () => ({}) },
  runtime: {
    onMessage: listener, onConnect: listener, onInstalled: listener, onStartup: listener,
    sendMessage: async () => undefined, connect: () => ({ onMessage: listener, onDisconnect: listener, postMessage: noop }),
    getURL: (p: string) => p, lastError: undefined,
  },
  alarms: { create: noop, onAlarm: listener },
  tabs: { query: async () => [], sendMessage: async () => undefined, onUpdated: listener },
  action: { onClicked: listener },
  sidePanel: { open: noop, setPanelBehavior: noop },
  offscreen: { hasDocument: async () => false, createDocument: noop },
};

export function resetChromeStores(): void {
  for (const k of Object.keys(localStore)) delete localStore[k];
  for (const k of Object.keys(sessionStore)) delete sessionStore[k];
}
