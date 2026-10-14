const hashes = new WeakSet<object>();

/** Record JSON provenance without adding fields to validated snapshot data. */
export function registerSnapshotHashes(value: unknown): void {
  if (value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) registerSnapshotHashes(item);
    return;
  }
  hashes.add(value);
  for (const item of Object.values(value)) registerSnapshotHashes(item);
}
export function isSnapshotHash(value: object): boolean {
  return hashes.has(value);
}
