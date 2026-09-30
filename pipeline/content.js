// Content folder conventions, shared by the pipeline and the scheduler server.
//
//   content/<type>/[<tag>/...]<file>
//
// Each top-level folder is a content type (music, bumper, promo, ...), and every
// subfolder below it adds a tag. A folder named "rare" makes its tracks rarely
// picked unless a sidecar sets a weight.

import { readdirSync, existsSync } from "fs";
import { join, extname } from "path";

export const AUDIO_EXTS = new Set([".mp3", ".wav", ".flac", ".aac", ".m4a", ".ogg"]);
export const RARE_WEIGHT = 0.05;

// Folder names double as type and tag names, so keep them simple and URL-safe
export const FOLDER_NAME = /^[a-z0-9][a-z0-9-]{0,39}$/;

export const isAudio = name => AUDIO_EXTS.has(extname(name).toLowerCase());

// Every folder under content/ with the audio files directly inside it:
// [{ path: "promo/ads", audio: ["promo/ads/spot.mp3", ...] }, ...]
export function listFolders(contentDir) {
  const folders = [];
  function walk(rel) {
    const entries = readdirSync(join(contentDir, rel), { withFileTypes: true });
    folders.push({
      path: rel,
      audio: entries.filter(e => e.isFile() && isAudio(e.name)).map(e => `${rel}/${e.name}`),
    });
    for (const e of entries) if (e.isDirectory()) walk(`${rel}/${e.name}`);
  }
  if (!existsSync(contentDir)) return folders;
  for (const e of readdirSync(contentDir, { withFileTypes: true })) {
    if (e.isDirectory()) walk(e.name);
  }
  return folders.sort((a, b) => a.path.localeCompare(b.path));
}
