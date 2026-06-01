/// <reference types="vite/client" />

import type { HiveBridge } from "../../preload";

declare global {
  interface Window {
    hive: HiveBridge;
  }
}
