<p align="center"><img src="public/logo.svg" alt="EdgeFM" width="320"></p>

# EdgeFM

An internet radio station that runs entirely on Cloudflare's free tier. Streams pre-planned content via HLS, with clock wheel scheduling and deterministic track selection — all listeners hear the same thing at the same time.

## How it works

- Audio files are stored in Cloudflare R2 as 10-second AAC/MPEG-TS segments
- The web player builds the live HLS playlist itself from the current UTC time and `station.json` (the wheels and track list, published to R2), so web listeners never call the Worker and stay within the free tier
- A Cloudflare Worker serves the same playlist at `/stream.m3u8` for external players like VLC, from the same code (`public/lib/playlist.js`)
- Track order is determined by a clock wheel template + seeded RNG, so the selection is semi-random but reproducible — every listener gets the same stream
- All heavy lifting (segmenting, scheduling) happens locally before deploy; the Worker is pure math

## Architecture

```
content/                   # Your audio files: one folder per type, subfolders are tags
demo/generate.js           # Generates synthetic demo audio for local testing
demo/voices.js             # Generates text-to-speech bumpers, DJ breaks, promos and talk
pipeline/index.js          # Local tool: ffmpeg → R2 → catalog + schedule
public/lib/schedule.js     # Clock wheel scheduling (shared by the pipeline, scheduler and web player)
public/lib/playlist.js     # Live playlist + now-playing (shared by the Worker and web player)
pipeline/content.js        # content/ folder conventions
pipeline/r2.js             # R2 uploads, deletes and the in-bucket manifest
pipeline/prune.js          # Deletes R2 segments nothing uses any more
scheduler/                 # Local web tool for editing wheels.json
src/worker.js              # Cloudflare Worker: serves /stream.m3u8 and /now-playing
src/catalog.json           # Generated — track metadata bundled with Worker
src/schedule.json          # Generated — 30-day pre-computed slot schedule
public/index.html          # Web player (hls.js), deployed to Cloudflare Pages
wheels.json                # Clock wheel slot template
wrangler.toml              # Cloudflare Worker config
terraform/                 # Cloudflare infrastructure (R2 bucket, Pages project)
```

## Content structure

Each top-level folder under `content/` is a **type** of content, and every subfolder inside it adds a **tag**. A wheel slot picks a type, and optionally tags to narrow it down. To add a new type, just make a folder (or use **+ New type** in the scheduler). Folder names use lowercase letters, numbers and dashes.

```
content/
├── music/
│   ├── crossing/          # tag: crossing (Lud & Schlatt Crossing soundtrack)
│   ├── upbeat/            # tag: upbeat
│   ├── chill/             # tag: chill
│   └── hype/              # tag: hype
├── bumper/                # station IDs
│   ├── common/            # tag: common
│   └── rare/              # tag: rare, rarely picked
├── dj-intro/              # short DJ breaks between songs
├── promo/
│   ├── ads/               # tag: ads (sponsor spots)
│   └── station/           # tag: station (plugs for the stream)
└── talk/
    └── stories/           # tag: stories (longer spoken pieces)
```

Tracks in any folder named `rare` get a weight of 0.05 (picked about 1/20th as often) unless a sidecar sets one. `npm run demo:voices` generates text-to-speech placeholders for the bumper, dj-intro, promo and talk folders.

Supported formats: `.mp3`, `.wav`, `.flac`, `.aac`, `.m4a`, `.ogg`

### Sidecar metadata

Track names and artists come from the file's ID3/metadata tags when present, falling back to the filename. Place a `.json` file next to any audio file to override defaults:

```json
{
  "name": "My Track Title",
  "artist": "My Artist",
  "weight": 0.05,
  "tags": ["extra-tag"]
}
```

`weight` controls how often a track is selected relative to others in the same pool. Default is `1.0`. Use low values (e.g. `0.05`) for rare easter-egg content.

## Setup

### Prerequisites

- [Node.js](https://nodejs.org) 18+ (install via [nvm](https://github.com/nvm-sh/nvm))
- [ffmpeg](https://ffmpeg.org) in your PATH
- [Terraform](https://developer.hashicorp.com/terraform/install) 1.5+
- A [Cloudflare account](https://cloudflare.com) with an API token that has R2 and Pages permissions

### 1. Provision infrastructure

Terraform state is stored in a Cloudflare R2 bucket. Create it before the first init:

```bash
wrangler r2 bucket create edgefm-tfstate
```

Then configure the backend and your variables:

```bash
cd terraform
cp backend.hcl.example backend.hcl
# Edit backend.hcl — fill in your account ID and R2 API token credentials
# (create R2 API tokens at dash.cloudflare.com → R2 → Manage R2 API tokens)

cp terraform.tfvars.example terraform.tfvars
# Edit terraform.tfvars — fill in your Cloudflare account ID, GitHub details, and alert email

export CLOUDFLARE_API_TOKEN="your-api-token"
terraform init -backend-config=backend.hcl
terraform apply
```

This creates the `edgefm-audio` R2 bucket (with CORS configured), the Cloudflare Pages project for the web player, and a billing notification policy that emails you the moment any spend is detected.

After `apply`:
- Give the bucket a public URL (Cloudflare dashboard → R2 → `edgefm-audio` → Settings):
  - **Production:** connect a **custom domain** (e.g. `audio.example.com`; the domain must be on Cloudflare). This puts Cloudflare's CDN cache in front of the segments.
  - **Testing only:** enable the public development URL (`pub-XXXX.r2.dev`). It's rate-limited and not cached, so don't point listeners at it.
- Set a hard spend cap: Cloudflare dashboard → Billing → Spend Management → set limit to **$0**. Terraform cannot enforce this programmatically — it must be set manually. This is your backstop against runaway costs.

### 2. Configure the Worker

Update `wrangler.toml` with your R2 public URL:

```toml
[vars]
PUBLIC_URL = "https://audio.example.com" # The bucket's custom domain (or r2.dev URL for testing) from step 1
```

The station start time is `EPOCH` in `public/lib/schedule.js` — don't change it once live.

Update `public/index.html`:
- `REPLACE_WITH_R2_PUBLIC_URL` → the bucket's public URL from step 1 (same as `PUBLIC_URL`). The player loads `station.json` and the audio from there.
- `REPLACE_WITH_WORKER_URL` → your Worker URL (`https://edgefm.<your-subdomain>.workers.dev`). Only used by browsers that can't run hls.js (older iPhones), or if `station.json` can't be loaded.

### 3. Add content and deploy

```bash
npm install
npx wrangler login

# To test with synthetic audio before adding real content:
npm run demo

# Once content is in place:
npm run publish
```

`npm run demo` generates 10 synthetic tone tracks (one per slot category) using ffmpeg — useful for verifying the full pipeline before adding real audio.

`npm run publish` runs the full pipeline — segments audio with ffmpeg, uploads new segments to R2, generates the catalog and schedule, then deploys the Worker. Run it again whenever you add or change content.

### How content maps to R2

R2 has no folders for your content. Each track's ID is a hash of its audio (plus the encoding settings), and its segments are stored as `segments/<id>/<id>_000.ts`, `_001.ts`, and so on. Folders only decide a track's type and tags, which live in the catalog built into the Worker. So:

- **Moving or renaming a file** keeps its ID: nothing is re-encoded or re-uploaded.
- **Changing a file's audio** gives it a new ID and new keys. Segments never change once uploaded, so they're served with `Cache-Control: public, max-age=31536000, immutable` and the CDN can keep them forever.
- The pipeline keeps a list of every key it has uploaded in the bucket (`edgefm-manifest.json`) and skips those next time. `npm run pipeline -- --reupload` uploads everything again.
- Old segments are never deleted automatically. After publishing, `npm run prune` lists segments nothing uses any more, and `npm run prune -- --yes` deletes them.

## Day-to-day commands

| Command | What it does |
|---|---|
| `npm run demo` | Generate synthetic demo audio into `content/` for testing |
| `npm run publish` | Full pipeline + Worker deploy |
| `npm run pipeline` | Segment + upload + generate catalog/schedule only |
| `npm run dev` | Local Worker dev server (segment URLs still point at R2) |
| `npm run scheduler` | Web tool for editing `wheels.json` with a live schedule preview |
| `npm run prune` | List R2 segments no track uses any more (`-- --yes` deletes them; run after publishing) |

## Clock wheel

### Scheduler tool

```bash
npm run scheduler
```

Open http://localhost:8790 to edit wheels and assign them to hours of the day, with a day-by-day preview of exactly what will play (it runs the same scheduling code as the pipeline) and play counts for every track. It reads your tracks from `src/catalog.json`, so run `npm run pipeline` once after adding content. Saving writes `wheels.json`; run `npm run publish` to put it on air.

### wheels.json

Or edit `wheels.json` by hand to change the slot sequence. Each slot has a `type` matching a content category, and optionally `tags` to filter the pool.

```json
{
  "wheels": {
    "default": [
      { "type": "music", "tags": ["upbeat"] },
      { "type": "bumper" },
      { "type": "music", "tags": ["chill"] },
      { "type": "dj-intro" },
      { "type": "music", "tags": ["hype"] },
      { "type": "bumper" }
    ]
  },
  "schedule": [
    { "hours": "0-23", "wheel": "default" }
  ]
}
```

To play one exact track every time a slot comes round, name its path under `content/` with `file` (tags are ignored):

```json
{ "type": "music", "file": "music/crossing/Grand-Opening-PM-Music.mp3" }
```

If that file is renamed or removed, the slot is skipped with a warning.

Multiple named wheels with different hour ranges are supported — add entries to `wheels` and split the `hours` ranges in `schedule` to add time-of-day variation. Hours are UTC and can be a single hour (`"9"`), a range (`"6-17"`), or a range that wraps past midnight (`"22-5"`). The first matching entry wins; hours with no entry use the `default` wheel.

## Endpoints

| Endpoint | Description |
|---|---|
| `GET /stream.m3u8` | HLS playlist for the current position in the schedule |
| `GET /now-playing` | JSON — current track name, category, tags, and playback position |

## Listening

The Cloudflare Pages deployment of `public/index.html` is the primary web player. It builds its own playlists, so each web listener costs only R2 segment reads, not Worker requests. For external players, point them at your Worker's stream URL directly:

```
https://edgefm.<your-subdomain>.workers.dev/stream.m3u8
```

This URL works in VLC, Pacific Drive (add it as a custom radio station via M3U), and any HLS-capable player.
