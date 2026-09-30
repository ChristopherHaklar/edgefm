import catalog from "./catalog.json";
import schedule from "./schedule.json";
import { createStation } from "../public/lib/playlist.js";

// The web player builds its own playlists from station.json in R2; these
// endpoints serve external players (VLC etc.) that can't run its code
const station = createStation(schedule, catalog);

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
      const playlist = publicUrl && station.playlist(publicUrl, Date.now());

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
      return new Response(JSON.stringify(station.nowPlaying(Date.now())), {
        headers: { ...headers, "Content-Type": "application/json" },
      });
    }

    return new Response("Not found", { status: 404, headers });
  },
};
