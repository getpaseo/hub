declare module "fs-native-extensions" {
  /** Takes an exclusive lock on the whole file without waiting. Returns false if it is held. */
  export function tryLock(fd: number): boolean;
  export function unlock(fd: number): void;
}
