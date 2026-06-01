import { contextBridge } from "electron";

const api = {
  platform: process.platform,
  versions: process.versions,
};

contextBridge.exposeInMainWorld("hive", api);

export type HiveBridge = typeof api;
