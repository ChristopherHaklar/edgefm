#!/usr/bin/env node
// Scans content/, segments all audio with ffmpeg, builds catalog + schedule,
// uploads new segments to R2, bundles catalog+schedule into src/ for wrangler deploy.

import { execSync, spawnSync } from "child_process";
import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync, rmSync } from "fs";
import { join, basename, extname, relative, sep } from "path";
import { fileURLToPath } from "url";
import { createHash } from "crypto";
import { buildSchedule, SCHEDULE_DAYS } from "./schedule.js";
import { isAudio, RARE_WEIGHT } from "./content.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const CONTENT_DIR = join(ROOT, "content");
const SEGMENTS_DIR = join(ROOT, "segments");
const UPLOADED_FILE = join(SEGMENTS_DIR, "uploaded.json");
const WHEELS_FILE = join(ROOT, "wheels.json");
const CATALOG_OUT = join(ROOT, "src", "catalog.json");
const SCHEDULE_OUT = join(ROOT, "src", "schedule.json");

const SEGMENT_DURATION = 10; // seconds
const R2_BUCKET = "edgefm-audio";

// --- Audio processing ---
function probe(filePath) {
  const result = spawnSync("ffprobe", [
    "-v", "error",
    "-show_entries", "format=duration:format_tags=title,artist",
    "-of", "json",
    filePath
  ], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`ffprobe failed on ${filePath}: ${result.stderr}`);
  const { format } = JSON.parse(result.stdout);
  const tags = Object.fromEntries(
    Object.entries(format.tags ?? {}).map(([k, v]) => [k.toLowerCase(), v])
  );
  return { duration: parseFloat(format.duration), title: tags.title, artist: tags.artist };
}

function segmentTrack(filePath, outDir, trackId, rawDuration) {
  rmSync(outDir, { recursive: true, force: true }); // clear any partial output
  mkdirSync(outDir, { recursive: true });
  // Pad duration to exact multiple of SEGMENT_DURATION
  const segmentCount = Math.ceil(rawDuration / SEGMENT_DURATION);
  const paddedDuration = segmentCount * SEGMENT_DURATION;
  const segmentPattern = join(outDir, `${trackId}_%03d.ts`);

  const result = spawnSync("ffmpeg", [
    "-hide_banner", "-loglevel", "error",
    "-i", filePath,
    "-map", "0:a",                       // drop embedded cover art
    "-af", "apad",                       // pad with silence so -t can extend short tracks
    // AAC frames don't land exactly on segment boundaries; stopping just short
    // of the padded length avoids a stray few-millisecond final segment
    "-t", String(paddedDuration - 0.1),
    "-c:a", "aac",
    "-b:a", "128k",
    "-ar", "44100",
    "-ac", "2",                          // keep every segment stereo, even from mono sources
    "-f", "segment",
    "-segment_time", String(SEGMENT_DURATION),
    "-segment_format", "mpegts",
    "-y",
    segmentPattern
  ], { stdio: "inherit" });
  if (result.status !== 0) throw new Error(`ffmpeg failed on ${filePath}`);

  const produced = readdirSync(outDir).filter(f => f.endsWith(".ts")).length;
  if (produced !== segmentCount) {
    throw new Error(`expected ${segmentCount} segments for ${filePath}, ffmpeg produced ${produced}`);
  }
  return { duration: paddedDuration, segmentCount };
}

// --- Scan content directory ---
function scanContent() {
  const catalog = { tracks: [] };

  function scanDir(dir, category, tags = [], defaultWeight = 1.0) {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        // subdirectory name becomes a tag (e.g. content/music/upbeat → tag "upbeat");
        // anything under a "rare" folder is rarely picked
        scanDir(fullPath, category, [...tags, entry.name], entry.name === "rare" ? RARE_WEIGHT : defaultWeight);
      } else if (isAudio(entry.name)) {
        // Hash the repo-relative path with "/" separators so IDs match across OSes
        const trackId = createHash("md5")
          .update(relative(ROOT, fullPath).split(sep).join("/"))
          .digest("hex")
          .slice(0, 12);

        // Optional sidecar file: track.mp3 → track.json for metadata overrides
        const sidecar = fullPath.replace(/\.[^.]+$/, ".json");
        const meta = existsSync(sidecar) ? JSON.parse(readFileSync(sidecar, "utf8")) : {};
        const info = probe(fullPath);

        const outDir = join(SEGMENTS_DIR, trackId);
        const expectedCount = Math.ceil(info.duration / SEGMENT_DURATION);
        // A partial set (e.g. from an interrupted run) gets re-segmented
        const existingCount = existsSync(outDir)
          ? readdirSync(outDir).filter(f => f.endsWith(".ts")).length
          : 0;

        let duration, segmentCount;
        if (existingCount === expectedCount) {
          segmentCount = existingCount;
          duration = segmentCount * SEGMENT_DURATION;
          console.log(`  skipping (already segmented): ${entry.name}`);
        } else {
          console.log(`  segmenting: ${entry.name}`);
          ({ duration, segmentCount } = segmentTrack(fullPath, outDir, trackId, info.duration));
        }

        catalog.tracks.push({
          id: trackId,
          file: relative(CONTENT_DIR, fullPath).split(sep).join("/"), // for slots that name a file
          name: meta.name ?? info.title ?? basename(entry.name, extname(entry.name)),
          artist: meta.artist ?? info.artist,
          category,
          tags: [...tags, ...(meta.tags ?? [])],
          weight: meta.weight ?? defaultWeight,
          duration,
          segmentCount,
        });
      }
    }
  }

  // Each top-level folder is a content type (music, bumper, promo, ...)
  for (const entry of readdirSync(CONTENT_DIR, { withFileTypes: true })) {
    if (entry.isDirectory()) scanDir(join(CONTENT_DIR, entry.name), entry.name);
    else if (isAudio(entry.name)) console.warn(`  warning: ${entry.name} is directly in content/ — put it in a type folder`);
  }

  return catalog;
}

// --- Upload segments to R2 ---
function uploadSegments(catalog) {
  // Remember what's already in R2 so re-runs only upload new segments
  const uploaded = new Set(existsSync(UPLOADED_FILE) ? JSON.parse(readFileSync(UPLOADED_FILE, "utf8")) : []);
  let skipped = 0;

  for (const track of catalog.tracks) {
    const outDir = join(SEGMENTS_DIR, track.id);
    const files = readdirSync(outDir).filter(f => f.endsWith(".ts"));
    for (const file of files) {
      const key = `segments/${track.id}/${file}`;
      if (uploaded.has(key)) { skipped++; continue; }
      console.log(`  uploading ${key}`);
      execSync(`wrangler r2 object put ${R2_BUCKET}/${key} --file="${join(outDir, file)}" --content-type="video/mp2t"`, {
        stdio: "inherit",
        cwd: ROOT,
      });
      uploaded.add(key);
    }
    writeFileSync(UPLOADED_FILE, JSON.stringify([...uploaded], null, 2));
  }

  if (skipped) console.log(`  ${skipped} segments already uploaded`);
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
writeFileSync(CATALOG_OUT, JSON.stringify(catalog));
writeFileSync(SCHEDULE_OUT, JSON.stringify(schedule));
console.log("  wrote src/catalog.json");
console.log("  wrote src/schedule.json");

console.log("\nDone. Run `wrangler deploy` or `npm run publish` to deploy.\n");
