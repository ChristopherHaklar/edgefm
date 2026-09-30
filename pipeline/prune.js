#!/usr/bin/env node
// Deletes R2 segments that no track in src/catalog.json uses any more (audio that
// was removed or changed). Run it after `npm run publish`, so the live Worker is
// already on the new catalog. Lists what it would delete unless given --yes.

import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { fileURLToPath } from "url";
import { readManifestOrExit, writeManifest, deleteObject, segmentKeys, R2_BUCKET } from "./r2.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const CATALOG = join(ROOT, "src", "catalog.json");
const CONFIRMED = process.argv.includes("--yes");

if (!existsSync(CATALOG)) {
  console.error("No src/catalog.json — run `npm run publish` first.");
  process.exit(1);
}

const live = new Set(segmentKeys(JSON.parse(readFileSync(CATALOG, "utf8"))));
const manifest = readManifestOrExit();
const unused = [...manifest].filter(key => !live.has(key)).sort();

if (!unused.length) {
  console.log(`Nothing to prune: all ${manifest.size} segments in ${R2_BUCKET} are in use.`);
  process.exit(0);
}

const tracks = new Set(unused.map(key => key.split("/")[1]));
console.log(`${unused.length} unused segments from ${tracks.size} old track${tracks.size > 1 ? "s" : ""} in ${R2_BUCKET}:`);
for (const id of tracks) console.log(`  segments/${id}/ (${unused.filter(k => k.split("/")[1] === id).length} segments)`);

if (!CONFIRMED) {
  console.log("\nNothing deleted. Make sure the Worker is deployed with the current catalog (npm run publish),");
  console.log("then run `npm run prune -- --yes` to delete them.");
  process.exit(0);
}

let deleted = 0;
for (const key of unused) {
  deleteObject(key);
  manifest.delete(key);
  // Save progress now and then, so an interrupted prune picks up where it left off
  if (++deleted % 25 === 0) writeManifest(manifest);
}
writeManifest(manifest);
console.log(`\nDeleted ${deleted} segments.`);
