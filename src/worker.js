import catalog from "./catalog.json";
import schedule from "./schedule.json";

const SEGMENT_DURATION = 10; // seconds — must match the pipeline

// Live window around the segment playing now. Players start ~3 segments from
// the end of a live playlist, so 2 segments of lookahead puts listeners at "now".
const WINDOW_BEHIND = 3;
const WINDOW_AHEAD = 2;

const EPOCH_MS = new Date(schedule.epoch).getTime();
const LOOP_SECONDS = schedule.totalSeconds;
const entries = schedule.entries;
const tracks = new Map(catalog.tracks.map(t => [t.id, t]));

// Locate a point in time (seconds since epoch) in the looping schedule.
// `slot` counts slots since the epoch across loops, so it only ever increases.
function locate(seconds) {
  const loop = Math.floor(seconds / LOOP_SECONDS);
  const offset = seconds - loop * LOOP_SECONDS;

  // Binary search: find the last entry with t <= offset
  let lo = 0, hi = entries.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (entries[mid].t <= offset) lo = mid;
    else hi = mid - 1;
  }

  const entry = entries[lo];
  return {
    slot: loop * entries.length + lo,
    track: tracks.get(entry.id),
    position: offset - entry.t,
  };
}

function secondsSinceEpoch() {
  return (Date.now() - EPOCH_MS) / 1000;
}

function buildPlaylist(publicUrl) {
  // Every track is padded to a whole number of segments, so segment boundaries
  // line up globally and the segment index since epoch is the media sequence.
  const current = Math.floor(secondsSinceEpoch() / SEGMENT_DURATION);
  const first = current - WINDOW_BEHIND;

  const segments = [];
  for (let seq = first; seq <= current + WINDOW_AHEAD; seq++) {
    const { slot, track, position } = locate(seq * SEGMENT_DURATION);
    if (!track) return null;
    segments.push({ slot, track, index: Math.floor(position / SEGMENT_DURATION) });
  }

  const lines = [
    "#EXTM3U",
    "#EXT-X-VERSION:3",
    `#EXT-X-TARGETDURATION:${SEGMENT_DURATION}`,
    `#EXT-X-MEDIA-SEQUENCE:${first}`,
    // One discontinuity per track change, so the count before this window is the slot number
    `#EXT-X-DISCONTINUITY-SEQUENCE:${segments[0].slot}`,
  ];

  segments.forEach((seg, i) => {
    // Timestamps restart with each track's segments
    if (i > 0 && seg.slot !== segments[i - 1].slot) lines.push("#EXT-X-DISCONTINUITY");
    const n = String(seg.index).padStart(3, "0");
    lines.push(`#EXTINF:${SEGMENT_DURATION}.0,`);
    lines.push(`${publicUrl}/segments/${seg.track.id}/${seg.track.id}_${n}.ts`);
  });

  return lines.join("\n") + "\n";
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // CORS headers for browser players
    const headers = {
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "no-store",
    };

    if (url.pathname === "/stream.m3u8") {
      const publicUrl = env.PUBLIC_URL?.replace(/\/+$/, "");
      const playlist = publicUrl && buildPlaylist(publicUrl);

      if (!playlist) {
        return new Response("Schedule error", { status: 500, headers });
      }

      return new Response(playlist, {
        headers: {
          ...headers,
          "Content-Type": "application/vnd.apple.mpegurl",
          "Cache-Control": "public, max-age=5",
        },
      });
    }

    // Health check / now-playing info
    if (url.pathname === "/now-playing") {
      const { track, position } = locate(secondsSinceEpoch());
      return new Response(JSON.stringify({
        track: track?.name,
        artist: track?.artist,
        category: track?.category,
        tags: track?.tags,
        positionSeconds: Math.floor(position),
        durationSeconds: track?.duration,
      }), {
        headers: { ...headers, "Content-Type": "application/json" },
      });
    }

    return new Response("Not found", { status: 404, headers });
  },
};
