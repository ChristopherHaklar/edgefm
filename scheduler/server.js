#!/usr/bin/env node
// Local web tool for editing wheels.json and previewing the resulting schedule.
// Run: npm run scheduler, then open http://localhost:8790

import { createServer } from "http";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { spawn } from "child_process";
import { join } from "path";
import { fileURLToPath } from "url";
import { validateWheels, formatWheels, SCHEDULE_DAYS, EPOCH } from "../public/lib/schedule.js";
import { listFolders, FOLDER_NAME } from "../pipeline/content.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const WHEELS_FILE = join(ROOT, "wheels.json");
const CATALOG_FILE = join(ROOT, "src", "catalog.json");
const CONTENT_DIR = join(ROOT, "content");
const PORT = Number(process.env.PORT ?? 8790);

// The page builds its preview with the same scheduling code the pipeline uses
const STATIC = {
  "/": [join(ROOT, "scheduler", "index.html"), "text/html; charset=utf-8"],
  "/schedule.js": [join(ROOT, "public", "lib", "schedule.js"), "text/javascript; charset=utf-8"],
};

// Re-read on every request so a pipeline run is picked up without restarting
function loadCatalog() {
  return existsSync(CATALOG_FILE) ? JSON.parse(readFileSync(CATALOG_FILE, "utf8")) : null;
}

// Folders on disk plus the processed track list; a folder can have audio the pipeline hasn't seen yet
function contentState() {
  const catalog = loadCatalog();
  return { folders: listFolders(CONTENT_DIR), tracks: catalog?.tracks ?? [], catalogMissing: !catalog };
}

// "promo" or "promo/ads": 1–4 simple folder names, never anything outside content/
function contentPath(path, { allowRoot = false } = {}) {
  if (typeof path !== "string") return null;
  if (path === "" && allowRoot) return CONTENT_DIR;
  const parts = path.split("/");
  if (parts.length > 4 || !parts.every(p => FOLDER_NAME.test(p))) return null;
  return join(CONTENT_DIR, ...parts);
}

function openInFileManager(dir) {
  const [cmd, args] = process.platform === "win32" ? ["explorer.exe", [dir]]
    : process.platform === "darwin" ? ["open", [dir]]
    : ["xdg-open", [dir]];
  spawn(cmd, args, { detached: true, stdio: "ignore" }).on("error", () => {}).unref();
}

function send(res, status, body, type = "application/json") {
  res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store" });
  res.end(type === "application/json" ? JSON.stringify(body) : body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", chunk => {
      data += chunk;
      if (data.length > 1e6) reject(new Error("request too large"));
    });
    req.on("end", () => {
      try { resolve(JSON.parse(data)); } catch { reject(new Error("invalid JSON")); }
    });
  });
}

createServer(async (req, res) => {
  try {
    if (req.method === "GET" && STATIC[req.url]) {
      const [file, type] = STATIC[req.url];
      return send(res, 200, readFileSync(file, "utf8"), type);
    }

    if (req.method === "GET" && req.url === "/api/state") {
      return send(res, 200, {
        wheels: JSON.parse(readFileSync(WHEELS_FILE, "utf8")),
        ...contentState(),
        epoch: EPOCH.toISOString(),
        days: SCHEDULE_DAYS,
      });
    }

    if (req.method === "GET" && req.url === "/api/content") {
      return send(res, 200, contentState());
    }

    // Create a content type (top-level folder) or a tag (subfolder)
    if (req.method === "POST" && req.url === "/api/folders") {
      const { path } = await readBody(req);
      const dir = contentPath(path);
      if (!dir) return send(res, 400, { errors: ["Use lowercase letters, numbers and dashes, e.g. \"promo\" or \"late-night\""] });
      if (existsSync(dir)) return send(res, 409, { errors: [`content/${path} already exists`] });
      mkdirSync(dir, { recursive: true });
      return send(res, 200, contentState());
    }

    if (req.method === "POST" && req.url === "/api/open") {
      const { path } = await readBody(req);
      const dir = contentPath(path, { allowRoot: true });
      if (!dir || !existsSync(dir)) return send(res, 400, { errors: [`content/${path} doesn't exist`] });
      openInFileManager(dir);
      return send(res, 200, { ok: true });
    }

    if (req.method === "POST" && req.url === "/api/save") {
      const { wheels } = await readBody(req);
      const { errors } = validateWheels(wheels, loadCatalog() ?? undefined);
      if (errors.length) return send(res, 400, { errors });
      writeFileSync(WHEELS_FILE, formatWheels(wheels));
      return send(res, 200, { ok: true });
    }

    send(res, 404, { errors: ["not found"] });
  } catch (err) {
    send(res, 500, { errors: [err.message] });
  }
}).listen(PORT, "127.0.0.1", () => {
  console.log(`EdgeFM scheduler running at http://localhost:${PORT}`);
  console.log("Saving writes wheels.json — run `npm run publish` to put the new schedule on air.");
});
