import {
  mkdir,
  open,
  appendFile,
  readFile,
  writeFile,
  rename,
} from "node:fs/promises";
import path from "node:path";
import os from "node:os";
export const persistentStore = Boolean(process.env.TRADING_DATA_DIR);
const root = process.env.TRADING_DATA_DIR || path.join(os.tmpdir(), "4scans");
function safe(key: string) {
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(key))
    throw new Error("Invalid storage key");
  return key;
}
export async function journal(kind: string, data: unknown) {
  await mkdir(root, { recursive: true });
  await appendFile(
    path.join(root, `${safe(kind)}.jsonl`),
    JSON.stringify({ time: Date.now(), data }) + "\n",
  );
}
export async function saveRecords(key: string, data: unknown) {
  await mkdir(root, { recursive: true });
  const dest = path.join(root, `${safe(key)}.json`),
    tmp = dest + "." + crypto.randomUUID() + ".tmp";
  await writeFile(tmp, JSON.stringify(data));
  await rename(tmp, dest);
}
export async function readRecords<T>(key: string): Promise<T | null> {
  try {
    return JSON.parse(
      await readFile(path.join(root, `${safe(key)}.json`), "utf8"),
    );
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
}
export async function claimTrade(symbol: string, requestId: string) {
  if (!persistentStore)
    throw new Error(
      "Live execution requires TRADING_DATA_DIR on persistent storage",
    );
  await mkdir(root, { recursive: true });
  const handle = await open(
    path.join(root, `request-${safe(requestId)}.lock`),
    "wx",
  );
  await handle.writeFile(symbol);
  await handle.close();
  // Deliberately retained until an operator reconciles the account. Survives crashes and retries.
  const lock = await open(path.join(root, `symbol-${safe(symbol)}.lock`), "wx");
  await lock.writeFile(requestId);
  await lock.close();
}
