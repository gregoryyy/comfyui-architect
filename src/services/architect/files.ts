// Writing run records under `ARCHITECT_DATA_DIR/artifacts/` without following a symbolic
// link (SEC T9). A stored ID is data: every path segment is checked, each directory is
// created one level at a time and must be a plain directory, and files are opened with
// O_NOFOLLOW, so nothing is created or written through a link someone placed there.

import { closeSync, constants, lstatSync, mkdirSync, openSync, realpathSync, writeSync } from "node:fs";
import { join } from "node:path";

const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export class UnsafePathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsafePathError";
  }
}

/** `<dataDir>/artifacts/<segments…>`, created as plain directories; refuses links and odd names. */
export function artifactDir(dataDir: string, segments: readonly string[]): string {
  let dir = realpathSync(dataDir);
  for (const segment of ["artifacts", ...segments]) {
    if (!SEGMENT.test(segment) || segment.includes("..")) throw new UnsafePathError(`refusing the path segment ${JSON.stringify(segment)}`);
    dir = join(dir, segment);
    let stat;
    try {
      stat = lstatSync(dir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      mkdirSync(dir);
      stat = lstatSync(dir);
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new UnsafePathError(`refusing ${dir}: not a plain directory`);
  }
  return dir;
}

/** Write a text file, refusing a symbolic link at its name. */
export function writeFileNoFollow(path: string, text: string): void {
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o644);
  try {
    writeSync(fd, text);
  } finally {
    closeSync(fd);
  }
}
