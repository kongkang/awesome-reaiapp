import { lstatSync, readdirSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { BuildError } from "@reai/app-cli";

export function isSafePackagePath(path: string): boolean {
  return path.length > 0 && !isAbsolute(path) && !/[\\\\:\u0000-\u001f\u007f]/.test(path)
    && path.split("/").every(part => part !== "" && part !== "." && part !== "..");
}

export function safeChild(root: string, path: string): string {
  if (!isSafePackagePath(path)) throw new BuildError("Unsafe path: " + path);
  const full = resolve(root, path);
  const child = relative(root, full);
  if (!child || child === ".." || child.startsWith("../") || isAbsolute(child)) throw new BuildError("Path escapes app root");
  return full;
}

/** Never follow symlinks during cleanup or package collection (also excludes cycles). */
export function assertSafeTree(root: string, path: string): void {
  safeChild(root, path);
  let prefix = root;
  for (const part of path.split("/")) {
    prefix = join(prefix, part);
    let stat;
    try { stat = lstatSync(prefix); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    if (stat.isSymbolicLink()) throw new BuildError("Symlink is not a package resource: " + path);
  }
  const visit = (full: string): void => {
    const stat = lstatSync(full);
    if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) throw new BuildError("Unsupported package resource");
    if (stat.isDirectory()) for (const name of readdirSync(full)) visit(join(full, name));
  };
  visit(join(root, path));
}
