#!/usr/bin/env node
// Generates placeholder bumpers, DJ intros, promos and talk with the OS text-to-speech
// (Windows SAPI or macOS `say`), each over a soft synth bed. Clips are sized
// to just under a whole number of 10s segments so the pipeline's padding
// doesn't leave dead air. Pass --force to regenerate existing clips.

import { spawnSync } from "child_process";
import { writeFileSync, mkdirSync, existsSync, rmSync, mkdtempSync } from "fs";
import { join, dirname } from "path";
import { tmpdir, platform } from "os";
import { fileURLToPath } from "url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const FORCE = process.argv.includes("--force");

// Voices: [Windows SAPI voice, macOS voice]
const STATION = ["Microsoft Zira Desktop", "Samantha"];
const DJ = ["Microsoft David Desktop", "Alex"];

// Beds: chord frequencies (Hz) for the synth pad under the voice
const BRIGHT = [523.25, 659.25, 783.99]; // C major, higher
const WARM = [174.61, 220.0, 261.63];    // F major, lower

const clips = [
  {
    path: "content/bumper/common/tts_bumper_1.mp3", voice: STATION, bed: BRIGHT,
    text: "You're listening to Edge FM.",
    meta: { name: "Station ID", artist: "Edge FM" },
  },
  {
    path: "content/bumper/common/tts_bumper_2.mp3", voice: STATION, bed: BRIGHT,
    text: "Edge FM. Broadcasting from the edge of the network.",
    meta: { name: "Station ID", artist: "Edge FM" },
  },
  {
    path: "content/bumper/common/tts_bumper_3.mp3", voice: STATION, bed: BRIGHT,
    text: "Edge FM. All day, every day, from Lud and Schlatt Crossing.",
    meta: { name: "Station ID", artist: "Edge FM" },
  },
  {
    path: "content/bumper/rare/tts_rare_bumper.mp3", voice: DJ, bed: BRIGHT,
    text: "Congratulations. You have found the rare Edge FM bumper. Tell no one.",
    meta: { name: "Station ID (rare)", artist: "Edge FM" },
  },
  {
    path: "content/dj-intro/tts_dj_intro_1.mp3", voice: DJ, bed: WARM,
    text: "Hey there, this is Edge FM. Stick around, we've got plenty more music on the way.",
    meta: { name: "DJ break", artist: "Edge FM" },
  },
  {
    path: "content/dj-intro/tts_dj_intro_2.mp3", voice: DJ, bed: WARM,
    text: "Welcome back to Edge FM. Grab a coffee, get comfortable, and let's keep the tunes rolling.",
    meta: { name: "DJ break", artist: "Edge FM" },
  },
  {
    path: "content/dj-intro/tts_dj_intro_3.mp3", voice: DJ, bed: WARM,
    text: "You're tuned in to Edge FM, streaming straight from Lud and Schlatt Crossing. Here's another one for you.",
    meta: { name: "DJ break", artist: "Edge FM" },
  },
  {
    path: "content/dj-intro/tts_dj_intro_4.mp3", voice: DJ, bed: WARM,
    text: "Edge FM, keeping you company around the clock. Up next, more from the Crossing soundtrack.",
    meta: { name: "DJ break", artist: "Edge FM" },
  },

  // Promos: fictional sponsor ads and plugs for the station
  {
    path: "content/promo/ads/tts_ad_tax_office.mp3", voice: STATION, bed: BRIGHT,
    text: "Tired of doing your own taxes? Come on down to the Tax Office, open day and night. " +
          "We'll get to your paperwork eventually. The Tax Office. Your financial obligations are our financial obligations.",
    meta: { name: "Ad: The Tax Office", artist: "Edge FM" },
  },
  {
    path: "content/promo/ads/tts_ad_bait_and_tackle.mp3", voice: STATION, bed: BRIGHT,
    text: "Sunset Pier Bait and Tackle is celebrating its grand opening! Fresh bait, questionable tackle, " +
          "and the best sunsets on the whole island. Sunset Pier Bait and Tackle. Now open, most days.",
    meta: { name: "Ad: Sunset Pier Bait and Tackle", artist: "Edge FM" },
  },
  {
    path: "content/promo/ads/tts_ad_dental.mp3", voice: STATION, bed: BRIGHT,
    text: "Crossing Dental. Every cleaning comes with a free lullaby, and every lullaby comes with a small cleaning fee. " +
          "Crossing Dental. We'll see you when we see you.",
    meta: { name: "Ad: Crossing Dental", artist: "Edge FM" },
  },
  {
    path: "content/promo/station/tts_promo_1.mp3", voice: DJ, bed: WARM,
    text: "Love what you're hearing? Edge FM streams around the clock, straight from the edge of the network. Tell a friend.",
    meta: { name: "Station promo: tell a friend", artist: "Edge FM" },
  },
  {
    path: "content/promo/station/tts_promo_2.mp3", voice: DJ, bed: WARM,
    text: "Coming up on Edge FM: more music from the Crossing, more station IDs than anyone asked for, and absolutely no news.",
    meta: { name: "Station promo: coming up", artist: "Edge FM" },
  },

  // Talk: longer spoken pieces
  {
    path: "content/talk/stories/tts_tales_from_the_pier.mp3", voice: DJ, bed: WARM,
    text: "Welcome to Tales from the Pier. Every evening, just as the sun dips behind the water, the pier fills up. " +
          "Fishermen, dreamers, and the occasional raccoon looking for a snack. " +
          "Old timers say that if you stand at the very end of the pier at exactly ten P M, " +
          "you can hear music drifting across the water, even when the radio is off. " +
          "Nobody knows where it comes from. Most people agree it's pretty good, though. " +
          "That's all for Tales from the Pier. Back to the music.",
    meta: { name: "Tales from the Pier", artist: "Edge FM" },
  },
  {
    path: "content/talk/stories/tts_basement_report.mp3", voice: DJ, bed: WARM,
    text: "This is the Basement Report. Nobody is quite sure what's down in the old basement under town hall. " +
          "Some say it's filing cabinets. Some say it's more filing cabinets. " +
          "Last week, a brave volunteer went down with a flashlight and came back two hours later holding a single stapler. " +
          "He won't talk about what he saw. The investigation continues. This has been the Basement Report.",
    meta: { name: "The Basement Report", artist: "Edge FM" },
  },
];

function run(cmd, args, options = {}) {
  const result = spawnSync(cmd, args, { encoding: "utf8", ...options });
  if (result.error) throw new Error(`${cmd} not found: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`${cmd} failed: ${result.stderr}`);
  return result.stdout;
}

function speak(text, [windowsVoice, macVoice], outFile) {
  if (platform() === "win32") {
    // Windows PowerShell 5 ships System.Speech; text goes via env to avoid quoting issues
    run("powershell.exe", ["-NoProfile", "-Command",
      "Add-Type -AssemblyName System.Speech;" +
      "$s = New-Object System.Speech.Synthesis.SpeechSynthesizer;" +
      "$s.SelectVoice($env:TTS_VOICE); $s.SetOutputToWaveFile($env:TTS_OUT);" +
      "$s.Speak($env:TTS_TEXT); $s.Dispose()",
    ], { env: { ...process.env, TTS_TEXT: text, TTS_VOICE: windowsVoice, TTS_OUT: outFile } });
  } else if (platform() === "darwin") {
    run("say", ["-v", macVoice, "-o", outFile, "--data-format=LEI16@22050", text]);
  } else {
    throw new Error("text-to-speech needs Windows or macOS");
  }
}

function duration(file) {
  return parseFloat(run("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file]));
}

const LEAD_IN = 0.6; // seconds of bed before the voice starts
const SEGMENT = 10;
const TARGET_LUFS = -14; // the Crossing tracks measure about -13

const work = mkdtempSync(join(tmpdir(), "edgefm-voices-"));
try {
  for (const clip of clips) {
    const outPath = join(ROOT, clip.path);
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath.replace(/\.mp3$/, ".json"), JSON.stringify(clip.meta, null, 2) + "\n");

    if (existsSync(outPath) && !FORCE) {
      console.log(`skip  ${clip.path}`);
      continue;
    }

    const wav = join(work, "voice.wav");
    speak(clip.text, clip.voice, wav);

    // Just under a whole number of segments, leaving room for the bed to fade out
    const total = Math.ceil((LEAD_IN + duration(wav) + 1.5) / SEGMENT) * SEGMENT - 0.5;
    const pad = clip.bed
      .map((f, i) => `${(0.06 - i * 0.01).toFixed(2)}*sin(2*PI*${f}*t)`)
      .join("+");

    console.log(`gen   ${clip.path} (${total.toFixed(1)}s)`);
    const mix = join(work, "mix.wav");
    run("ffmpeg", [
      "-v", "error",
      "-i", wav,
      "-f", "lavfi", "-i", `aevalsrc=${pad}:s=44100:d=${total}`,
      "-filter_complex",
      `[0:a]aresample=44100,adelay=${LEAD_IN * 1000}:all=1[voice];` +
      `[1:a]tremolo=f=0.5:d=0.4,afade=t=in:d=0.8,afade=t=out:st=${total - 2}:d=2[bed];` +
      `[voice][bed]amix=inputs=2:duration=longest:normalize=0,aformat=channel_layouts=stereo`,
      "-t", String(total),
      "-y", mix,
    ]);

    // Measure, then apply exact gain to roughly match the music's loudness
    // (single-pass loudnorm undershoots badly on clips this short)
    const report = spawnSync("ffmpeg", ["-hide_banner", "-i", mix, "-af", "ebur128", "-f", "null", "-"], { encoding: "utf8" }).stderr;
    const measured = parseFloat(report.slice(report.lastIndexOf("Integrated loudness")).match(/I:\s+(-?[\d.]+)/)[1]);
    run("ffmpeg", [
      "-v", "error",
      "-i", mix,
      "-af", `volume=${(TARGET_LUFS - measured).toFixed(2)}dB,alimiter=limit=0.84:level=false`,
      "-c:a", "libmp3lame", "-b:a", "128k",
      "-metadata", `title=${clip.meta.name}`, "-metadata", `artist=${clip.meta.artist}`,
      "-y", outPath,
    ]);
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}

console.log("\nVoice clips ready. Run `npm run pipeline` to segment and upload.\n");
