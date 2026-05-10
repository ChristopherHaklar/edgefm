import catalog from "./catalog.json";
import schedule from "./schedule.json";

const EPOCH_MS = new Date(schedule.epoch).getTime();
const SCHEDULE_DURATION_S = schedule.totalSeconds;

// Binary search: find the last entry with t <= offset
function findCurrentSlot(offsetSeconds) {
  const entries = schedule.entries;
  let lo = 0, hi = entries.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (entries[mid].t <= offsetSeconds) lo = mid;
    else hi = mid - 1;
  }
  return entries[lo];
}

function getTrack(id) {
  return catalog.tracks.find(t => t.id === id);
}

function buildPlaylist(offsetSeconds) {
  const entries = schedule.entries;
  const lines = [
    "#EXTM3U",
    "#EXT-X-VERSION:3",
    `#EXT-X-TARGETDURATION:10`,
    "#EXT-X-PLAYLIST-TYPE:EVENT",
  ];

  // Find the slot playing now
  let slotIdx = schedule.entries.findIndex((e, i) => {
    const next = entries[i + 1];
    return e.t <= offsetSeconds && (!next || next.t > offsetSeconds);
  });
  if (slotIdx < 0) slotIdx = 0;

  const slot = entries[slotIdx];
  const track = getTrack(slot.id);
  if (!track) return null;

  const posInTrack = offsetSeconds - slot.t;
  const startSegment = Math.floor(posInTrack / 10);
  const segBase = `${catalog.publicUrl}/segments/${track.id}/${track.id}`;

  // Emit from current segment position, continue into next tracks as needed
  let seqNumber = startSegment;
  lines.push(`#EXT-X-MEDIA-SEQUENCE:${seqNumber}`);

  // Include remaining segments of current track
  let currentSlotIdx = slotIdx;
  let segFrom = startSegment;

  // Emit ~3 tracks worth of segments (enough for a smooth buffer)
  for (let emitted = 0; emitted < 3 && currentSlotIdx < entries.length; currentSlotIdx++) {
    const currentTrack = getTrack(entries[currentSlotIdx].id);
    if (!currentTrack) break;
    const from = currentSlotIdx === slotIdx ? segFrom : 0;
    for (let s = from; s < currentTrack.segmentCount; s++) {
      const seg = String(s).padStart(3, "0");
      lines.push(`#EXTINF:10.0,`);
      lines.push(`${segBase}_${seg}.ts`.replace(track.id, currentTrack.id));
    }
    emitted++;
  }

  return lines.join("\n");
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
      const nowMs = Date.now();
      const offsetSeconds = Math.floor((nowMs - EPOCH_MS) / 1000) % SCHEDULE_DURATION_S;
      const playlist = buildPlaylist(offsetSeconds);

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
      const nowMs = Date.now();
      const offsetSeconds = Math.floor((nowMs - EPOCH_MS) / 1000) % SCHEDULE_DURATION_S;
      const slot = findCurrentSlot(offsetSeconds);
      const track = getTrack(slot.id);
      return new Response(JSON.stringify({
        track: track?.name,
        category: track?.category,
        tags: track?.tags,
        positionSeconds: offsetSeconds - slot.t,
        durationSeconds: track?.duration,
      }), {
        headers: { ...headers, "Content-Type": "application/json" },
      });
    }

    return new Response("Not found", { status: 404, headers });
  },
};
