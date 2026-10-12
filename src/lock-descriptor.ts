// A Linux flock is attached to an open file description. Git children inherit
// this descriptor so a surviving mutation keeps exclusion after its parent dies.
let descriptors: number[] = [];
export function lockDescriptor(): number | null {
  return descriptors[0] ?? null;
}
export function setLockDescriptor(value: number | null): void {
  descriptors = value === null ? [] : [value];
}
export function setLockDescriptors(values: number[]): void {
  descriptors = values;
}
export function lockedStdio(): ["ignore", "pipe", "pipe", ...number[]] {
  return ["ignore", "pipe", "pipe", ...descriptors];
}
