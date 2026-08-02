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

export async function readContextMapSource(
  source,
  fsApi = { open, realpath, stat },
) {
  let handle;
  try {
    handle = await fsApi.open(
      source.filePath,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
  } catch (error) {
    if (error?.code === "ENOENT") throw new ContextSourceError("MISSING");
    throw new ContextSourceError("ACCESS_DENIED");
  }

  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new ContextSourceError("ACCESS_DENIED");
    if (info.size > MAX_SOURCE_BYTES) throw new ContextSourceError("TOO_LARGE");

    const targetPath = await fsApi.realpath(source.filePath);
    if (!isInside(source.rootPath, targetPath)) {
      throw new ContextSourceError("ACCESS_DENIED");
    }
    const targetInfo = await fsApi.stat(targetPath);
    if (targetInfo.dev !== info.dev || targetInfo.ino !== info.ino) {
      throw new ContextSourceError("ACCESS_DENIED");
    }

    const bytes = Buffer.allocUnsafe(MAX_SOURCE_BYTES + 1);
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
    if (offset > MAX_SOURCE_BYTES) {
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
