// The station's live HLS playlist and now-playing, as pure functions of the
// schedule and the time. Shared by the Worker (for external players) and the
// web player (which builds its own playlists, so it never calls the Worker).

export const SEGMENT_DURATION = 10; // seconds — must match the pipeline

// Live window around the segment playing now. Players start ~3 segments from
// the end of a live playlist, so 2 segments of lookahead puts listeners at "now".
const WINDOW_BEHIND = 3;
const WINDOW_AHEAD = 2;

export function createStation(schedule, catalog) {
  const epochMs = new Date(schedule.epoch).getTime();
  const loopSeconds = schedule.totalSeconds;
  const entries = schedule.entries;
  const tracks = new Map(catalog.tracks.map(t => [t.id, t]));

  // Locate a point in time (seconds since epoch) in the looping schedule.
  // `slot` counts slots since the epoch across loops, so it only ever increases.
  function locate(seconds) {
    const loop = Math.floor(seconds / loopSeconds);
    const offset = seconds - loop * loopSeconds;

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

  const secondsAt = nowMs => (nowMs - epochMs) / 1000;

  function playlist(publicUrl, nowMs) {
    // Every track is padded to a whole number of segments, so segment boundaries
    // line up globally and the segment index since epoch is the media sequence.
    const current = Math.floor(secondsAt(nowMs) / SEGMENT_DURATION);
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

  // What's playing at a point in time (seconds since epoch)
  function nowPlayingAt(seconds) {
    const { track, position } = locate(seconds);
    return {
      track: track?.name,
      artist: track?.artist,
      category: track?.category,
      tags: track?.tags,
      positionSeconds: Math.floor(position),
      durationSeconds: track?.duration,
    };
  }

  return {
    playlist,
    nowPlaying: nowMs => nowPlayingAt(secondsAt(nowMs)),
    // A segment's media sequence number is its index since epoch, so the web player
    // can name exactly what's audible from the segment hls.js is playing
    nowPlayingAtSegment: seq => nowPlayingAt(seq * SEGMENT_DURATION),
  };
}
