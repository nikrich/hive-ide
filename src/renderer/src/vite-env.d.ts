/// <reference types="vite/client" />

// `HiveBridge` is the renderer ↔ main contract — see `src/preload/api.ts`.
// Re-importing it here so `window.hive` is fully typed across the renderer.
import type { HiveBridge } from '../../preload/api';

declare global {
  interface Window {
    hive: HiveBridge;
  }
}

export {};
