import type { PushSubscription } from 'web-push';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';

const DB_PATH = join(process.cwd(), '.push-subscriptions.json');

function read(): PushSubscription[] {
  if (!existsSync(DB_PATH)) return [];
  try {
    return JSON.parse(readFileSync(DB_PATH, 'utf-8')) as PushSubscription[];
  } catch {
    return [];
  }
}

function write(subs: PushSubscription[]): void {
  writeFileSync(DB_PATH, JSON.stringify(subs, null, 2));
}

export async function getAllSubscriptions(): Promise<PushSubscription[]> {
  return read();
}

export async function addSubscription(sub: PushSubscription): Promise<void> {
  const subs = read();
  if (!subs.some(s => s.endpoint === sub.endpoint)) {
    subs.push(sub);
    write(subs);
  }
}

export async function removeSubscription(endpoint: string): Promise<void> {
  write(read().filter(s => s.endpoint !== endpoint));
}
