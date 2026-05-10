#!/usr/bin/env node
// Generates synthetic demo audio using ffmpeg's tone generator.
// Produces one file per category so the full pipeline can be tested
// without real content. Each track uses a distinct frequency so you
// can identify it by ear.

import { spawnSync, execSync } from "child_process";
import { writeFileSync, mkdirSync, existsSync } from "fs";
import { join, dirname } from "path";

const ROOT = new URL("..", import.meta.url).pathname;

const tracks = [
  // Music — longer tracks, distinct frequencies
  {
    path: "content/music/upbeat/demo_upbeat_1.mp3",
    freq: 440, duration: 122, // ~2m, not a multiple of 10 — tests padding
    meta: { name: "Demo Upbeat A (440Hz)" },
  },
  {
    path: "content/music/upbeat/demo_upbeat_2.mp3",
    freq: 550, duration: 150,
    meta: { name: "Demo Upbeat B (550Hz)" },
  },
  {
    path: "content/music/chill/demo_chill_1.mp3",
    freq: 330, duration: 180,
    meta: { name: "Demo Chill A (330Hz)" },
  },
  {
    path: "content/music/chill/demo_chill_2.mp3",
    freq: 277, duration: 140,
    meta: { name: "Demo Chill B (277Hz)" },
  },
  {
    path: "content/music/hype/demo_hype_1.mp3",
    freq: 660, duration: 130,
    meta: { name: "Demo Hype A (660Hz)" },
  },

  // Bumpers — short
  {
    path: "content/bumpers/common/demo_bumper_1.mp3",
    freq: 880, duration: 15,
    meta: { name: "Demo Common Bumper A" },
  },
  {
    path: "content/bumpers/common/demo_bumper_2.mp3",
    freq: 990, duration: 20,
    meta: { name: "Demo Common Bumper B" },
  },

  // Rare bumper — low weight
  {
    path: "content/bumpers/rare/demo_rare_bumper.mp3",
    freq: 1320, duration: 10,
    meta: { name: "Demo Rare Bumper (Easter Egg!)", weight: 0.05 },
  },

  // DJ intros — short spoken-slot placeholders
  {
    path: "content/dj-intro/demo_dj_intro_1.mp3",
    freq: 220, duration: 18,
    meta: { name: "Demo DJ Intro A (220Hz)" },
  },
  {
    path: "content/dj-intro/demo_dj_intro_2.mp3",
    freq: 196, duration: 22,
    meta: { name: "Demo DJ Intro B (196Hz)" },
  },
];

for (const track of tracks) {
  const absPath = join(ROOT, track.path);
  const dir = dirname(absPath);
  mkdirSync(dir, { recursive: true });

  if (existsSync(absPath)) {
    console.log(`skip  ${track.path}`);
  } else {
    console.log(`gen   ${track.path} (${track.freq}Hz, ${track.duration}s)`);
    // Sine wave with a gentle AM tremolo so it sounds slightly less like a
    // pure test tone and segment boundaries are audible as a pulse.
    const filter = `sine=frequency=${track.freq}:duration=${track.duration},tremolo=f=2:d=0.3`;
    const result = spawnSync("ffmpeg", [
      "-f", "lavfi", "-i", filter,
      "-c:a", "libmp3lame", "-b:a", "128k",
      "-y", absPath,
    ], { stdio: "inherit" });

    if (result.status !== 0) {
      console.error(`ffmpeg failed for ${track.path}`);
      process.exit(1);
    }
  }

  // Write sidecar metadata
  const sidecarPath = absPath.replace(/\.mp3$/, ".json");
  writeFileSync(sidecarPath, JSON.stringify(track.meta, null, 2));
}

console.log("\nDemo content ready. Run `npm run pipeline` to segment and upload.\n");
