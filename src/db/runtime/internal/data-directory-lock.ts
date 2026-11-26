import { closeSync, constants, openSync } from "node:fs";
import { join } from "node:path";
import { errorForLog } from "../../../logger.js";

const LOCK_FILE_NAME = ".paseo-hub.lock";
const IN_USE =
  "Embedded database directory is already in use by another Paseo Hub process. Embedded mode supports one process per data directory.";

export interface DataDirectoryLock {
  release(): Promise<void>;
}

/**
 * PGlite has no lock of its own, so two processes on one data directory corrupt it.
 *
 * The guard is an OS advisory lock on `.paseo-hub.lock`: an open-file-description lock on
 * Linux, `flock` on macOS, and `LockFileEx` on Windows. The kernel releases it when the
 * holder exits, including after SIGKILL or an OOM kill, so a lock file left on the volume or
 * restored from a backup never blocks a start. It also holds across containers that share the
 * volume, because they share the kernel's lock table whatever their PID, hostname, or network.
 *
 * The file is never deleted. Deleting it would let a starter that opened the old file and one
 * that created a new file both hold a lock.
 */
export async function acquireDataDirectoryLock(dataDirectory: string): Promise<DataDirectoryLock> {
  // Loaded here so the native addon is only required by embedded mode.
  const { tryLock, unlock } = await import("fs-native-extensions");
  // A numeric descriptor, unlike a FileHandle, is never closed by garbage collection.
  // LockFileEx needs read or write access; an append-only Windows handle fails with EPERM.
  const fd = openSync(
    join(dataDirectory, LOCK_FILE_NAME),
    constants.O_RDWR | constants.O_CREAT,
    0o600,
  );
  let locked: boolean;
  try {
    locked = tryLock(fd);
  } catch (error) {
    closeSync(fd);
    throw error;
  }
  if (!locked) {
    closeSync(fd);
    // Logs keep the message but not the directory path.
    throw errorForLog(new Error(`${IN_USE} Directory: ${dataDirectory}`), {
      diagnosticMessage: IN_USE,
    });
  }

  let released = false;
  return {
    async release() {
      if (released) return;
      released = true;
      try {
        unlock(fd);
      } finally {
        closeSync(fd);
      }
    },
  };
}
