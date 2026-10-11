// A Linux flock is attached to an open file description. Git children inherit
// this descriptor so a surviving mutation keeps exclusion after its parent dies.
let descriptor: number | null = null;
export function lockDescriptor(): number | null {
  return descriptor;
}
export function setLockDescriptor(value: number | null): void {
  descriptor = value;
}
export function lockedStdio(): ["ignore", "pipe", "pipe", ...number[]] {
  return descriptor === null ? ["ignore", "pipe", "pipe"] : ["ignore", "pipe", "pipe", descriptor];
}
