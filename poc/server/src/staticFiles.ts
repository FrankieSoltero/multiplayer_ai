import fs from "node:fs";
import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json",
  ".map": "application/json",
  ".woff2": "font/woff2",
  ".txt": "text/plain",
};

/** Minimal static handler for the built client (spec §5): GET-only, path
 *  containment, SPA fallback for extensionless paths. WS upgrades never hit
 *  this handler. Deliberately not a framework — the POC serves one dist dir. */
export function staticHandler(
  distDir: string,
): (req: IncomingMessage, res: ServerResponse) => void {
  const root = path.resolve(distDir);
  return (req, res) => {
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405);
      res.end();
      return;
    }
    let pathname: string;
    try {
      pathname = decodeURIComponent(new URL(req.url ?? "/", "http://x").pathname);
    } catch {
      res.writeHead(400);
      res.end();
      return;
    }
    // Reject paths containing .. components (path traversal attempts)
    if (pathname.split("/").includes("..")) {
      res.writeHead(403);
      res.end("forbidden");
      return;
    }
    let filePath = path.resolve(root, "." + path.posix.normalize(pathname));
    if (filePath !== root && !filePath.startsWith(root + path.sep)) {
      res.writeHead(403);
      res.end("forbidden");
      return;
    }
    if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
      if (path.extname(filePath) === "") {
        filePath = path.join(root, "index.html"); // SPA fallback
      } else {
        res.writeHead(404);
        res.end("not found");
        return;
      }
    }
    if (!fs.existsSync(filePath)) {
      res.writeHead(404);
      res.end("not found");
      return;
    }
    res.writeHead(200, {
      "content-type": CONTENT_TYPES[path.extname(filePath)] ?? "application/octet-stream",
    });
    if (req.method === "HEAD") {
      res.end();
      return;
    }
    // File may vanish between existsSync and open; destroy response if stream
    // emits error (headers already sent at this point).
    fs.createReadStream(filePath)
      .on("error", () => res.destroy())
      .pipe(res);
  };
}
