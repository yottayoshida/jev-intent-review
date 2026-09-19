import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { deleteRecord, findRecord, listRecords } from "../records/store.ts";

export interface PluginHost {
  deleteRecord: typeof deleteRecord;
  findRecord: typeof findRecord;
  listRecords: typeof listRecords;
}

// Plugins live outside this repository, in a directory chosen at deploy time. Each one receives
// the record store and may use it however it likes.
export async function loadPlugins(directory: string): Promise<number> {
  const host: PluginHost = { deleteRecord, findRecord, listRecords };
  let loaded = 0;
  for (const name of await readdir(directory)) {
    const plugin = (await import(join(directory, name))) as { register(host: PluginHost): void };
    plugin.register(host);
    loaded += 1;
  }
  return loaded;
}
