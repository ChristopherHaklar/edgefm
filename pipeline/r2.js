// R2 access through wrangler, shared by the pipeline and prune.
//
// Wrangler can't list a bucket, so the pipeline keeps a manifest of every
// segment key it has uploaded in the bucket itself. Because it lives next to
// the segments, it always describes what's really there: a wiped bucket loses
// the manifest too, and everything gets uploaded again.

import { execSync } from "child_process";
import { readFileSync, writeFileSync, existsSync, rmSync, mkdtempSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

export const R2_BUCKET = "edgefm-audio";
export const MANIFEST_KEY = "edgefm-manifest.json";

// Segment keys are derived from the audio's content, so a key never changes
// meaning and the CDN can keep segments forever
export const SEGMENT_CACHE_CONTROL = "public, max-age=31536000, immutable";

// What the web player loads to build its own playlists (wheels + catalog). It
// changes on every publish, so edge caches only keep it for a minute
export const STATION_KEY = "station.json";
export const STATION_CACHE_CONTROL = "public, max-age=60";

const quote = arg => (/^[\w@%+=:,./-]+$/.test(arg) ? arg : `"${arg.replace(/"/g, '\\"')}"`);

function wrangler(args, { quiet = false } = {}) {
  // --remote: wrangler 4 talks to a local simulator unless told otherwise
  const cmd = ["wrangler", ...args, "--remote"].map(quote).join(" ");
  return execSync(cmd, { stdio: quiet ? "pipe" : ["ignore", "ignore", "inherit"], encoding: "utf8" });
}

function withTempFile(fn) {
  const dir = mkdtempSync(join(tmpdir(), "edgefm-"));
  try { return fn(join(dir, "file")); } finally { rmSync(dir, { recursive: true, force: true }); }
}

// Every key the pipeline has uploaded; empty for a new (or wiped) bucket
export function readManifest() {
  return withTempFile(file => {
    try {
      wrangler(["r2", "object", "get", `${R2_BUCKET}/${MANIFEST_KEY}`, `--file=${file}`], { quiet: true });
    } catch (err) {
      const output = `${err.stdout ?? ""}${err.stderr ?? ""}`;
      if (/does not exist|not found|NoSuchKey|\b404\b|10007/i.test(output)) return new Set();
      // Anything else (auth, network) must not be mistaken for an empty bucket
      throw new Error(`couldn't read ${MANIFEST_KEY} from R2:\n${output}`);
    }
    return existsSync(file) ? new Set(JSON.parse(readFileSync(file, "utf8")).keys) : new Set();
  });
}

export function writeManifest(keys) {
  withTempFile(file => {
    writeFileSync(file, JSON.stringify({ keys: [...keys].sort() }, null, 2));
    wrangler(["r2", "object", "put", `${R2_BUCKET}/${MANIFEST_KEY}`, `--file=${file}`,
      "--content-type=application/json", "--cache-control=no-store"]);
  });
}

export function putObject(key, file, contentType, cacheControl) {
  wrangler(["r2", "object", "put", `${R2_BUCKET}/${key}`, `--file=${file}`,
    `--content-type=${contentType}`, `--cache-control=${cacheControl}`]);
}

export function putSegment(key, file) {
  putObject(key, file, "video/mp2t", SEGMENT_CACHE_CONTROL);
}

export function deleteObject(key) {
  wrangler(["r2", "object", "delete", `${R2_BUCKET}/${key}`]);
}

// readManifest, but a failure ends the run with a readable message instead of a stack trace
export function readManifestOrExit() {
  try {
    return readManifest();
  } catch (err) {
    console.error(`\n${err.message}\nNothing was changed in R2. Check \`wrangler login\` (or your network) and try again.`);
    process.exit(1);
  }
}

// The R2 keys a catalog's tracks need
export function segmentKeys(catalog) {
  return catalog.tracks.flatMap(t =>
    Array.from({ length: t.segmentCount }, (_, i) => `segments/${t.id}/${t.id}_${String(i).padStart(3, "0")}.ts`));
}
