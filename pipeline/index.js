#!/usr/bin/env node
// Scans content/, segments all audio with ffmpeg, builds catalog + schedule,
// uploads new segments to R2, bundles catalog+schedule into src/ for wrangler deploy.

import { execSync, spawnSync } from "child_process";
import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from "fs";
import { join, basename, extname } from "path";
import { createHash } from "crypto";

const ROOT = new URL("..", import.meta.url).pathname;
const CONTENT_DIR = join(ROOT, "content");
const SEGMENTS_DIR = join(ROOT, "segments");
const WHEELS_FILE = join(ROOT, "wheels.json");
const CATALOG_OUT = join(ROOT, "src", "catalog.json");
const SCHEDULE_OUT = join(ROOT, "src", "schedule.json");

const SEGMENT_DURATION = 10; // seconds
const SCHEDULE_DAYS = 30;    // pre-compute this many days of schedule
const EPOCH = new Date("2026-01-01T00:00:00Z");
const R2_BUCKET = "edgefm-audio";
const PUBLIC_URL = process.env.PUBLIC_URL ?? "https://pub-CHANGEME.r2.dev";

// --- Seeded PRNG (mulberry32) ---
function mulberry32(seed) {
  return function () {
    seed |= 0; seed = seed + 0x6D2B79F5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

function seededPick(items, seed) {
  const rng = mulberry32(seed);
  // Weighted selection
  const totalWeight = items.reduce((s, i) => s + (i.weight ?? 1), 0);
  let r = rng() * totalWeight;
  for (const item of items) {
    r -= item.weight ?? 1;
    if (r <= 0) return item;
  }
  return items[items.length - 1];
}

// --- Audio processing ---
function getDuration(filePath) {
  const result = spawnSync("ffprobe", [
    "-v", "error",
    "-show_entries", "format=duration",
    "-of", "default=noprint_wrappers=1:nokey=1",
    filePath
  ], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`ffprobe failed on ${filePath}: ${result.stderr}`);
  return parseFloat(result.stdout.trim());
}

function segmentTrack(filePath, outDir, trackId) {
  mkdirSync(outDir, { recursive: true });
  const rawDuration = getDuration(filePath);
  // Pad duration to exact multiple of SEGMENT_DURATION
  const paddedDuration = Math.ceil(rawDuration / SEGMENT_DURATION) * SEGMENT_DURATION;
  const segmentPattern = join(outDir, `${trackId}_%03d.ts`);

  spawnSync("ffmpeg", [
    "-i", filePath,
    "-t", String(paddedDuration),
    "-c:a", "aac",
    "-b:a", "128k",
    "-ar", "44100",
    "-f", "segment",
    "-segment_time", String(SEGMENT_DURATION),
    "-segment_format", "mpegts",
    "-y",
    segmentPattern
  ], { stdio: "inherit" });

  const segmentCount = Math.round(paddedDuration / SEGMENT_DURATION);
  return { duration: paddedDuration, segmentCount };
}

// --- Scan content directory ---
function scanContent() {
  const catalog = { tracks: [] };
  const audioExts = new Set([".mp3", ".wav", ".flac", ".aac", ".m4a", ".ogg"]);

  function scanDir(dir, category, tags = [], defaultWeight = 1.0) {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        // subdirectory name becomes a tag (e.g. content/music/upbeat → tag "upbeat")
        scanDir(fullPath, category, [...tags, entry.name], defaultWeight);
      } else if (audioExts.has(extname(entry.name).toLowerCase())) {
        const trackId = createHash("md5")
          .update(fullPath.replace(ROOT, ""))
          .digest("hex")
          .slice(0, 12);

        // Optional sidecar file: track.mp3 → track.json for metadata overrides
        const sidecar = fullPath.replace(/\.[^.]+$/, ".json");
        const meta = existsSync(sidecar) ? JSON.parse(readFileSync(sidecar, "utf8")) : {};

        const outDir = join(SEGMENTS_DIR, trackId);
        const alreadySegmented = existsSync(join(outDir, `${trackId}_000.ts`));

        let duration, segmentCount;
        if (alreadySegmented) {
          const existing = readdirSync(outDir).filter(f => f.endsWith(".ts"));
          segmentCount = existing.length;
          duration = segmentCount * SEGMENT_DURATION;
          console.log(`  skipping (already segmented): ${entry.name}`);
        } else {
          console.log(`  segmenting: ${entry.name}`);
          ({ duration, segmentCount } = segmentTrack(fullPath, outDir, trackId));
        }

        catalog.tracks.push({
          id: trackId,
          name: meta.name ?? basename(entry.name, extname(entry.name)),
          category,
          tags: [...tags, ...(meta.tags ?? [])],
          weight: meta.weight ?? defaultWeight,
          duration,
          segmentCount,
        });
      }
    }
  }

  scanDir(join(CONTENT_DIR, "music"), "music");
  scanDir(join(CONTENT_DIR, "bumpers", "common"), "bumper", [], 1.0);
  scanDir(join(CONTENT_DIR, "bumpers", "rare"), "bumper", ["rare"], 0.05);
  scanDir(join(CONTENT_DIR, "dj-intro"), "dj-intro");

  return catalog;
}

// --- Build schedule ---
function buildSchedule(catalog, wheels) {
  const totalSeconds = SCHEDULE_DAYS * 24 * 60 * 60;
  const schedule = []; // [{startTime, trackId}]

  // Index tracks by category+tags for fast lookup
  function getPool(slotDef) {
    return catalog.tracks.filter(t => {
      if (t.category !== slotDef.type) return false;
      if (slotDef.tags) return slotDef.tags.every(tag => t.tags.includes(tag));
      return true;
    });
  }

  // Get active wheel for a given second offset (could vary by hour in future)
  function getWheel(offset) {
    const hour = Math.floor(offset / 3600) % 24;
    const match = wheels.schedule.find(s => {
      const [from, to] = s.hours.split("-").map(Number);
      return hour >= from && hour <= to;
    });
    return wheels.wheels[match?.wheel ?? "default"];
  }

  let cursor = 0;
  let slotIndex = 0;

  while (cursor < totalSeconds) {
    const wheel = getWheel(cursor);
    const slotDef = wheel[slotIndex % wheel.length];
    const pool = getPool(slotDef);

    if (pool.length === 0) {
      console.warn(`  warning: no tracks for slot type "${slotDef.type}" tags [${slotDef.tags ?? ""}]`);
      slotIndex++;
      continue;
    }

    const track = seededPick(pool, slotIndex);
    schedule.push({ t: cursor, id: track.id });
    cursor += track.duration;
    slotIndex++;
  }

  return { epoch: EPOCH.toISOString(), totalSeconds, entries: schedule };
}

// --- Upload segments to R2 ---
function uploadSegments(catalog) {
  for (const track of catalog.tracks) {
    const outDir = join(SEGMENTS_DIR, track.id);
    const files = readdirSync(outDir).filter(f => f.endsWith(".ts"));
    for (const file of files) {
      const key = `segments/${track.id}/${file}`;
      console.log(`  uploading ${key}`);
      execSync(`wrangler r2 object put ${R2_BUCKET}/${key} --file="${join(outDir, file)}" --content-type="video/mp2t"`, {
        stdio: "inherit",
        cwd: ROOT,
      });
    }
  }
}

// --- Main ---
console.log("=== edgefm pipeline ===\n");

console.log("[1/4] Scanning and segmenting content...");
const catalog = scanContent();
console.log(`  ${catalog.tracks.length} tracks found\n`);

const wheels = JSON.parse(readFileSync(WHEELS_FILE, "utf8"));

console.log("[2/4] Building schedule...");
const schedule = buildSchedule(catalog, wheels);
console.log(`  ${schedule.entries.length} slots scheduled over ${SCHEDULE_DAYS} days\n`);

console.log("[3/4] Uploading segments to R2...");
uploadSegments(catalog);
console.log();

console.log("[4/4] Writing catalog + schedule for Worker...");
writeFileSync(CATALOG_OUT, JSON.stringify({ ...catalog, publicUrl: PUBLIC_URL }));
writeFileSync(SCHEDULE_OUT, JSON.stringify(schedule));
console.log("  wrote src/catalog.json");
console.log("  wrote src/schedule.json");

console.log("\nDone. Run `wrangler deploy` or `npm run publish` to deploy.\n");
