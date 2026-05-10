# EdgeFM

An internet radio station that runs entirely on Cloudflare's free tier. Streams pre-planned content via HLS, with clock wheel scheduling and deterministic track selection — all listeners hear the same thing at the same time.

## How it works

- Audio files are stored in Cloudflare R2 as 10-second AAC/MPEG-TS segments
- A Cloudflare Worker serves a dynamic HLS playlist calculated from the current UTC time
- Track order is determined by a clock wheel template + seeded RNG, so the selection is semi-random but reproducible — every listener gets the same stream
- All heavy lifting (segmenting, scheduling) happens locally before deploy; the Worker is pure math

## Architecture

```
content/                   # Your audio files, organised by category
demo/generate.js           # Generates synthetic demo audio for local testing
pipeline/index.js          # Local tool: ffmpeg → R2 → catalog + schedule
src/worker.js              # Cloudflare Worker: serves /stream.m3u8 and /now-playing
src/catalog.json           # Generated — track metadata bundled with Worker
src/schedule.json          # Generated — 30-day pre-computed slot schedule
public/index.html          # Web player (hls.js), deployed to Cloudflare Pages
wheels.json                # Clock wheel slot template
wrangler.toml              # Cloudflare Worker config
terraform/                 # Cloudflare infrastructure (R2 bucket, Pages project)
```

## Content structure

Drop audio files into subdirectories under `content/`. The directory name becomes the track's tag.

```
content/
├── music/
│   ├── upbeat/            # tag: upbeat
│   ├── chill/             # tag: chill
│   └── hype/              # tag: hype
├── bumpers/
│   ├── common/            # weight: 1.0
│   └── rare/              # weight: 0.05 (rarely selected)
└── dj-intro/
```

Supported formats: `.mp3`, `.wav`, `.flac`, `.aac`, `.m4a`, `.ogg`

### Sidecar metadata

Place a `.json` file next to any audio file to override defaults:

```json
{
  "name": "My Track Title",
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

```bash
cd terraform
cp terraform.tfvars.example terraform.tfvars
# Edit terraform.tfvars — fill in your Cloudflare account ID and GitHub details

export CLOUDFLARE_API_TOKEN="your-api-token"
terraform init
terraform apply
```

This creates the R2 bucket (with CORS configured) and the Cloudflare Pages project for the web player.

After `apply`, go to the Cloudflare dashboard → R2 → `edgefm-audio` → Settings and enable the public development URL. Copy the resulting `pub-XXXX.r2.dev` URL.

### 2. Configure the Worker

Update `wrangler.toml` with your R2 public URL and desired epoch:

```toml
[vars]
EPOCH      = "2026-01-01T00:00:00Z"   # Station start time — don't change once live
PUBLIC_URL = "https://pub-XXXX.r2.dev" # Your R2 public URL from step 1
```

Update `public/index.html` — replace `REPLACE_WITH_WORKER_URL` with your Worker URL
(`https://edgefm.<your-subdomain>.workers.dev`).

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

## Day-to-day commands

| Command | What it does |
|---|---|
| `npm run demo` | Generate synthetic demo audio into `content/` for testing |
| `npm run publish` | Full pipeline + Worker deploy |
| `npm run pipeline` | Segment + upload + generate catalog/schedule only |
| `npm run dev` | Local Worker dev server (segment URLs still point at R2) |

## Clock wheel

Edit `wheels.json` to change the slot sequence. Each slot has a `type` matching a content category, and optionally `tags` to filter the pool.

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

Multiple named wheels with different hour ranges are supported — add entries to `wheels` and split the `hours` ranges in `schedule` to add time-of-day variation.

## Endpoints

| Endpoint | Description |
|---|---|
| `GET /stream.m3u8` | HLS playlist for the current position in the schedule |
| `GET /now-playing` | JSON — current track name, category, tags, and playback position |

## Listening

The Cloudflare Pages deployment of `public/index.html` is the primary web player. For external players, point them at your Worker's stream URL directly:

```
https://edgefm.<your-subdomain>.workers.dev/stream.m3u8
```

This URL works in VLC, Pacific Drive (add it as a custom radio station via M3U), and any HLS-capable player.
