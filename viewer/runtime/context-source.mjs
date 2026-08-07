import { constants } from "node:fs";
import { open, realpath, stat } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import {
  CONTEXT_MAP_RELATIVE_PATH,
  MAX_SOURCE_BYTES,
} from "./constants.mjs";

export class ContextSourceError extends Error {
  constructor(code) {
    super(code);
    this.name = "ContextSourceError";
    this.code = code;
  }
}

function isInside(rootPath, candidatePath) {
  const child = relative(rootPath, candidatePath);
  return child === "" || (!child.startsWith(`..${sep}`) && child !== ".." && !child.startsWith(sep));
}

export async function resolveContextMap(rootUri, fsApi = { realpath }) {
  let workspacePath;
  try {
    const url = new URL(rootUri);
    if (url.protocol !== "file:") throw new Error("unsupported protocol");
    workspacePath = fileURLToPath(url);
  } catch {
    throw new ContextSourceError("ACCESS_DENIED");
  }

  let rootPath;
  try {
    rootPath = await fsApi.realpath(resolve(workspacePath));
  } catch {
    throw new ContextSourceError("ACCESS_DENIED");
  }

  const filePath = join(rootPath, ...CONTEXT_MAP_RELATIVE_PATH.split("/"));
  try {
    const targetPath = await fsApi.realpath(filePath);
    if (!isInside(rootPath, targetPath)) throw new ContextSourceError("ACCESS_DENIED");
  } catch (error) {
    if (error instanceof ContextSourceError) throw error;
    if (error?.code !== "ENOENT") throw new ContextSourceError("ACCESS_DENIED");
  }

  return {
    rootPath,
    handoffDir: dirname(filePath),
    filePath,
    relativePath: CONTEXT_MAP_RELATIVE_PATH,
  };
}

/**
 * TOCTOU-safe read of one fixed file inside a canonical workspace root.
 *
 * Security properties (shared by the Context Map source and every v3 content
 * file):
 * - O_NOFOLLOW open: the final path component must not be a symlink.
 * - The opened handle is stat'ed: it must be a regular file within maxBytes.
 * - The path is canonicalized with realpath AFTER opening and must stay
 *   inside rootPath (canonical containment).
 * - The realpath target's dev/ino must match the opened handle, so replacing
 *   a parent directory between validation and read cannot redirect the bytes.
 */
export async function readContainedFile(
  filePath,
  rootPath,
  { maxBytes = MAX_SOURCE_BYTES, fsApi = { open, realpath, stat } } = {},
) {
  let handle;
  try {
    handle = await fsApi.open(
      filePath,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
  } catch (error) {
    if (error?.code === "ENOENT") throw new ContextSourceError("MISSING");
    throw new ContextSourceError("ACCESS_DENIED");
  }

  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new ContextSourceError("ACCESS_DENIED");
    if (info.size > maxBytes) throw new ContextSourceError("TOO_LARGE");

    const targetPath = await fsApi.realpath(filePath);
    if (!isInside(rootPath, targetPath)) {
      throw new ContextSourceError("ACCESS_DENIED");
    }
    const targetInfo = await fsApi.stat(targetPath);
    if (targetInfo.dev !== info.dev || targetInfo.ino !== info.ino) {
      throw new ContextSourceError("ACCESS_DENIED");
    }

    const bytes = Buffer.allocUnsafe(maxBytes + 1);
    let offset = 0;
    while (offset < bytes.byteLength) {
      const { bytesRead } = await handle.read(
        bytes,
        offset,
        bytes.byteLength - offset,
        null,
      );
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset > maxBytes) {
      throw new ContextSourceError("TOO_LARGE");
    }
    return bytes.subarray(0, offset).toString("utf8");
  } catch (error) {
    if (error instanceof ContextSourceError) throw error;
    throw new ContextSourceError("ACCESS_DENIED");
  } finally {
    await handle.close().catch(() => {});
  }
}

export async function readContextMapSource(
  source,
  fsApi = { open, realpath, stat },
) {
  return readContainedFile(source.filePath, source.rootPath, {
    maxBytes: MAX_SOURCE_BYTES,
    fsApi,
  });
}
