#!/usr/bin/env node
// Local web tool for editing wheels.json and previewing the resulting schedule.
// Run: npm run scheduler, then open http://localhost:8790

import { createServer } from "http";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import { fileURLToPath } from "url";
import { validateWheels, formatWheels, SCHEDULE_DAYS, EPOCH } from "../pipeline/schedule.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const WHEELS_FILE = join(ROOT, "wheels.json");
const CATALOG_FILE = join(ROOT, "src", "catalog.json");
const PORT = Number(process.env.PORT ?? 8790);

// The page builds its preview with the same scheduling code the pipeline uses
const STATIC = {
  "/": [join(ROOT, "scheduler", "index.html"), "text/html; charset=utf-8"],
  "/schedule.js": [join(ROOT, "pipeline", "schedule.js"), "text/javascript; charset=utf-8"],
};

// Re-read on every request so a pipeline run is picked up without restarting
function loadCatalog() {
  return existsSync(CATALOG_FILE) ? JSON.parse(readFileSync(CATALOG_FILE, "utf8")) : null;
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
      const catalog = loadCatalog();
      return send(res, 200, {
        wheels: JSON.parse(readFileSync(WHEELS_FILE, "utf8")),
        tracks: catalog?.tracks ?? [],
        catalogMissing: !catalog,
        epoch: EPOCH.toISOString(),
        days: SCHEDULE_DAYS,
      });
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
