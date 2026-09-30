#!/usr/bin/env node
// Generates placeholder bumpers and DJ intros with the OS text-to-speech
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
    path: "content/bumpers/common/tts_bumper_1.mp3", voice: STATION, bed: BRIGHT,
    text: "You're listening to Edge FM.",
    meta: { name: "Station ID", artist: "Edge FM" },
  },
  {
    path: "content/bumpers/common/tts_bumper_2.mp3", voice: STATION, bed: BRIGHT,
    text: "Edge FM. Broadcasting from the edge of the network.",
    meta: { name: "Station ID", artist: "Edge FM" },
  },
  {
    path: "content/bumpers/common/tts_bumper_3.mp3", voice: STATION, bed: BRIGHT,
    text: "Edge FM. All day, every day, from Lud and Schlatt Crossing.",
    meta: { name: "Station ID", artist: "Edge FM" },
  },
  {
    path: "content/bumpers/rare/tts_rare_bumper.mp3", voice: DJ, bed: BRIGHT,
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
