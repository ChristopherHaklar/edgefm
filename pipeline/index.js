#!/usr/bin/env node
// Scans content/, segments all audio with ffmpeg, builds catalog + schedule,
// uploads new segments to R2, bundles catalog+schedule into src/ for wrangler deploy.

import { spawnSync } from "child_process";
import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync, rmSync } from "fs";
import { join, basename, extname, relative, sep } from "path";
import { fileURLToPath } from "url";
import { createHash } from "crypto";
import { buildSchedule, SCHEDULE_DAYS } from "../public/lib/schedule.js";
import { isAudio, RARE_WEIGHT } from "./content.js";
import { readManifestOrExit, writeManifest, putSegment, putObject, STATION_KEY, STATION_CACHE_CONTROL } from "./r2.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const CONTENT_DIR = join(ROOT, "content");
const SEGMENTS_DIR = join(ROOT, "segments");
const WHEELS_FILE = join(ROOT, "wheels.json");
const CATALOG_OUT = join(ROOT, "src", "catalog.json");
const SCHEDULE_OUT = join(ROOT, "src", "schedule.json");
const STATION_OUT = join(ROOT, "src", "station.json");

const SEGMENT_DURATION = 10; // seconds
// Part of every track ID: bump it whenever the ffmpeg settings in segmentTrack
// change, so re-encoded segments get new R2 keys instead of stale cached ones
const SEGMENT_FORMAT = "aac-128k-44100-stereo-10s-v1";
const REUPLOAD = process.argv.includes("--reupload");

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
  const seen = new Map(); // track ID → first file with that audio

  function scanDir(dir, category, tags = [], defaultWeight = 1.0) {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        // subdirectory name becomes a tag (e.g. content/music/upbeat → tag "upbeat");
        // anything under a "rare" folder is rarely picked
        scanDir(fullPath, category, [...tags, entry.name], entry.name === "rare" ? RARE_WEIGHT : defaultWeight);
      } else if (isAudio(entry.name)) {
        // ID from the audio itself (plus encoding settings): moving or renaming a file
        // keeps its ID and R2 keys, while changing the audio gives new ones
        const trackId = createHash("sha256")
          .update(readFileSync(fullPath))
          .update(SEGMENT_FORMAT)
          .digest("hex")
          .slice(0, 12);
        const file = relative(CONTENT_DIR, fullPath).split(sep).join("/");
        if (seen.has(trackId)) {
          console.warn(`  warning: ${file} is the same audio as ${seen.get(trackId)}, skipping it`);
          continue;
        }
        seen.set(trackId, file);

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
          file, // for slots that name a file
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
  // The manifest in the bucket lists what's already there; --reupload ignores it
  // (but keeps it, so prune still knows about older segments)
  const manifest = readManifestOrExit();
  let skipped = 0, uploaded = 0;

  for (const track of catalog.tracks) {
    const outDir = join(SEGMENTS_DIR, track.id);
    let changed = false;
    for (const file of readdirSync(outDir).filter(f => f.endsWith(".ts"))) {
      const key = `segments/${track.id}/${file}`;
      if (manifest.has(key) && !REUPLOAD) { skipped++; continue; }
      console.log(`  uploading ${key}`);
      putSegment(key, join(outDir, file));
      manifest.add(key);
      uploaded++;
      changed = true;
    }
    // Record progress per track, so an interrupted run doesn't redo finished tracks
    if (changed) writeManifest(manifest);
  }

  console.log(`  ${uploaded} uploaded, ${skipped} already in R2`);
}

// Segment folders for audio that's no longer in content/ (moved files keep their ID)
function removeStaleSegments(catalog) {
  if (!existsSync(SEGMENTS_DIR)) return;
  const ids = new Set(catalog.tracks.map(t => t.id));
  const stale = readdirSync(SEGMENTS_DIR, { withFileTypes: true }).filter(e => e.isDirectory() && !ids.has(e.name));
  for (const dir of stale) rmSync(join(SEGMENTS_DIR, dir.name), { recursive: true, force: true });
  if (stale.length) console.log(`  removed ${stale.length} unused local segment folder${stale.length > 1 ? "s" : ""}`);
}

// --- Main ---
console.log("=== edgefm pipeline ===\n");

console.log("[1/4] Scanning and segmenting content...");
const catalog = scanContent();
removeStaleSegments(catalog);
console.log(`  ${catalog.tracks.length} tracks found\n`);

const wheels = JSON.parse(readFileSync(WHEELS_FILE, "utf8"));

console.log("[2/4] Building schedule...");
const schedule = buildSchedule(catalog, wheels);
console.log(`  ${schedule.entries.length} slots scheduled over ${SCHEDULE_DAYS} days\n`);

// Everything the web player needs to build the same schedule and playlists itself.
// One file, so a page never mixes an old catalog with new wheels
const stationBody = JSON.stringify({ wheels, catalog });
const station = { version: createHash("sha256").update(stationBody).digest("hex").slice(0, 12), wheels, catalog };
writeFileSync(STATION_OUT, JSON.stringify(station));

console.log("[3/4] Uploading segments to R2...");
uploadSegments(catalog);
// After the segments, so the player never sees a catalog whose audio isn't there yet
putObject(STATION_KEY, STATION_OUT, "application/json", STATION_CACHE_CONTROL);
console.log(`  uploaded ${STATION_KEY} (version ${station.version})`);
console.log();

console.log("[4/4] Writing catalog + schedule for Worker...");
writeFileSync(CATALOG_OUT, JSON.stringify(catalog));
writeFileSync(SCHEDULE_OUT, JSON.stringify(schedule));
console.log("  wrote src/catalog.json");
console.log("  wrote src/schedule.json");

console.log("\nDone. Run `wrangler deploy` or `npm run publish` to deploy.");
console.log("After deploying, `npm run prune` lists R2 segments nothing uses any more.\n");
