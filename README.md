# EdgeFM

An internet radio station that runs entirely on Cloudflare's free tier. Streams pre-planned content via HLS, with clock wheel scheduling and deterministic track selection — all listeners hear the same thing at the same time.

## How it works

- Audio files are stored in Cloudflare R2 as 10-second AAC/MPEG-TS segments
- A Cloudflare Worker serves a dynamic HLS playlist calculated from the current UTC time
- Track order is determined by a clock wheel template + seeded RNG, so the selection is random but reproducible — every listener gets the same stream
- All heavy lifting (segmenting, scheduling) happens locally before deploy

## Architecture

```
content/                   # Your audio files, organised by category
pipeline/index.js          # Local tool: ffmpeg → R2 → catalog + schedule
src/worker.js              # Cloudflare Worker: serves /stream.m3u8 and /now-playing
src/catalog.json           # Generated — track metadata bundled with Worker
src/schedule.json          # Generated — 30-day pre-computed slot schedule
public/index.html          # Web player (hls.js), deployable to Cloudflare Pages
wheels.json                # Clock wheel slot template
wrangler.toml              # Cloudflare config
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

- [Node.js](https://nodejs.org) 18+
- [ffmpeg](https://ffmpeg.org) in your PATH
- [Terraform](https://developer.hashicorp.com/terraform/install) 1.5+
- A [Cloudflare account](https://cloudflare.com)

### 1. Provision infrastructure (Terraform)

```bash
cd terraform
cp terraform.tfvars.example terraform.tfvars
# Fill in your Cloudflare account ID and GitHub details in terraform.tfvars

export CLOUDFLARE_API_TOKEN="your-api-token"
terraform init
terraform apply
```

This creates the R2 bucket (with CORS) and the Cloudflare Pages project for the web player.

After apply, enable public access on the R2 bucket in the Cloudflare dashboard and copy the `pub-XXXX.r2.dev` URL into `wrangler.toml` as `PUBLIC_URL`.

### 2. Deploy the Worker

```bash
npm install
npx wrangler login
```

### Deploy

```bash
npm run publish
```

This runs the pipeline (segment all audio, upload to R2, generate catalog + schedule) then deploys the Worker.

To only run the pipeline without deploying:

```bash
npm run pipeline
```

### Development

```bash
npm run dev
```

Starts a local Worker dev server. Note: segment URLs will still point at R2.

## Clock wheel

Edit `wheels.json` to change the slot sequence. Each slot has a `type` matching a content category, and optionally `tags` to filter the pool further.

```json
{
  "wheels": {
    "default": [
      { "type": "music", "tags": ["upbeat"] },
      { "type": "bumper" },
      { "type": "music", "tags": ["chill"] },
      { "type": "dj-intro" },
      { "type": "music", "tags": ["hype"] }
    ]
  },
  "schedule": [
    { "hours": "0-23", "wheel": "default" }
  ]
}
```

Multiple named wheels with different hour ranges are supported — add entries to `wheels` and narrow the `hours` ranges in `schedule` to add time-of-day variation.

## Endpoints

| Endpoint | Description |
|---|---|
| `GET /stream.m3u8` | HLS playlist for the current position in the schedule |
| `GET /now-playing` | JSON with current track name, category, and position |

The stream URL works directly in VLC, Pacific Drive (via M3U), and any HLS-capable player.

## Listening

Open `public/index.html` in a browser, or deploy it to Cloudflare Pages and point `WORKER_URL` at your Worker's URL.

For VLC or Pacific Drive, point them at:
```
https://<your-worker>.workers.dev/stream.m3u8
```
