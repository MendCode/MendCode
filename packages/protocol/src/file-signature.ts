/** The fields of a `Stats` that identify one version of a file's content. */
export type FileStat = { ino?: number | bigint; size: number | bigint; mtimeMs: number | bigint; ctimeMs: number | bigint }

/**
 * What marks one version of a file when its content is not read: inode, size, mtime and ctime. A filesystem with coarse
 * timestamps (some container overlays, network and FAT volumes) gives two writes in one tick the same mtime, so mtime alone
 * treats the second as unchanged. A rewrite of another length changes the size; a replacement by rename changes the inode;
 * ctime moves with every metadata change even where mtime was set back. Limit: a rewrite of the same length, in the same
 * timestamp tick, on a filesystem whose ctime is as coarse, is not visible to stat; only reading the content tells.
 */
export function fileSignature(info: FileStat): string {
  return `${info.ino ?? 0}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`
}

/** Whether two stats describe the same version of a file (see `fileSignature`). */
export const sameFileVersion = (a: FileStat, b: FileStat): boolean => fileSignature(a) === fileSignature(b)
