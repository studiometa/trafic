import { isAbsolute, relative, sep } from "node:path";

/** Whether `child` is strictly inside `parent`. Both are resolved paths. */
export function isInside(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return Boolean(path) && !isAbsolute(path) && path.split(sep)[0] !== "..";
}
