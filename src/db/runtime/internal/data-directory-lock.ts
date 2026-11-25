import { randomUUID } from "node:crypto";
import { open, readFile, unlink } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";

const LOCK_FILE_NAME = ".paseo-hub.lock";
const OWNER_READ_ATTEMPTS = 10;
const OWNER_READ_DELAY_MS = 10;

declare global {
  // Tokens of the locks this process holds. Vite reloads server modules inside one process, so they
  // live on globalThis: a reload must not forget a lock the open runtime still holds.
  var paseoHubDataDirectoryLockTokens: Set<string> | undefined;
}
const heldTokens = (globalThis.paseoHubDataDirectoryLockTokens ??= new Set<string>());

interface LockOwner {
  pid: number;
  token: string;
  hostname?: string;
}

export interface DataDirectoryLock {
  release(): Promise<void>;
}

export async function acquireDataDirectoryLock(dataDirectory: string): Promise<DataDirectoryLock> {
  const path = join(dataDirectory, LOCK_FILE_NAME);
  const owner = { pid: process.pid, token: randomUUID(), hostname: hostname() };

  for (;;) {
    try {
      const handle = await open(path, "wx", 0o600);
      try {
        await handle.writeFile(JSON.stringify(owner));
      } finally {
        await handle.close();
      }
      heldTokens.add(owner.token);
      return new OwnedDataDirectoryLock(path, owner);
    } catch (error) {
      if (!hasCode(error, "EEXIST")) throw error;
    }

    const existingOwner = await readLockOwner(path);
    if (existingOwner !== undefined && ownerIsRunning(existingOwner)) {
      throw new Error(
        `Embedded database directory is already in use by another Paseo Hub process (PID ${existingOwner.pid}): ${dataDirectory}. Embedded mode supports one process per data directory.`,
      );
    }

    try {
      await unlink(path);
    } catch (error) {
      if (!hasCode(error, "ENOENT")) throw error;
    }
  }
}

class OwnedDataDirectoryLock implements DataDirectoryLock {
  constructor(
    private readonly path: string,
    private readonly owner: LockOwner,
  ) {}

  async release(): Promise<void> {
    heldTokens.delete(this.owner.token);
    const currentOwner = await readLockOwner(this.path);
    if (currentOwner?.token !== this.owner.token) return;
    try {
      await unlink(this.path);
    } catch (error) {
      if (!hasCode(error, "ENOENT")) throw error;
    }
  }
}

async function readLockOwner(path: string): Promise<LockOwner | undefined> {
  for (let attempt = 0; attempt < OWNER_READ_ATTEMPTS; attempt += 1) {
    try {
      const owner = parseLockOwner(await readFile(path, "utf8"));
      if (owner !== undefined) return owner;
    } catch (error) {
      if (hasCode(error, "ENOENT")) return undefined;
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, OWNER_READ_DELAY_MS));
  }
  return undefined;
}

function parseLockOwner(value: string): LockOwner | undefined {
  try {
    const parsed: unknown = JSON.parse(value);
    const pid: unknown = Reflect.get(parsed ?? {}, "pid");
    const token: unknown = Reflect.get(parsed ?? {}, "token");
    const host: unknown = Reflect.get(parsed ?? {}, "hostname");
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof pid === "number" &&
      typeof token === "string"
    ) {
      return typeof host === "string" ? { pid, token, hostname: host } : { pid, token };
    }
  } catch {
    // A process may have died before finishing its lock record. The caller recovers it as stale.
  }
  return undefined;
}

function ownerIsRunning(owner: LockOwner): boolean {
  // This host and PID with a token this process never took: an earlier process with the same PID left
  // the lock, as PID 1 does when a container restarts. Containers sharing one volume differ by hostname.
  if (owner.hostname === hostname() && owner.pid === process.pid)
    return heldTokens.has(owner.token);
  return processIsRunning(owner.pid);
}

function processIsRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !hasCode(error, "ESRCH");
  }
}

function hasCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && Reflect.get(error, "code") === code;
}
