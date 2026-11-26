import { realpathSync, statSync } from "node:fs";
import { isAbsolute, relative } from "node:path";

export function resolveAllowedCwd(
  rawCwd: string | undefined,
  allowedDirs: string[],
): { ok: true; cwd: string } | { ok: false; rejected: boolean; error: string } {
  const candidate = rawCwd?.trim() || allowedDirs[0];
  if (allowedDirs.length === 0 || !candidate) {
    return {
      ok: false,
      rejected: Boolean(rawCwd?.trim()),
      error: "Live execution disabled: no allowedDirs configured",
    };
  }
  let cwdReal: string;
  try {
    cwdReal = realpathSync(candidate);
    if (!statSync(cwdReal).isDirectory()) {
      return {
        ok: false,
        rejected: true,
        error: `Not a directory: ${candidate}`,
      };
    }
  } catch {
    return {
      ok: false,
      rejected: true,
      error: `Directory missing: ${candidate}`,
    };
  }
  for (const dir of allowedDirs) {
    try {
      const rel = relative(realpathSync(dir), cwdReal);
      if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) {
        return { ok: true, cwd: cwdReal };
      }
    } catch {
      // Ignore unreachable allowlist entry.
    }
  }
  return {
    ok: false,
    rejected: true,
    error: `Rejected cwd outside allowedDirs: ${candidate}`,
  };
}
