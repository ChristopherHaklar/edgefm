terraform {
  required_version = ">= 1.10"

  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 5.0"
    }
  }

  backend "s3" {
    # Config is supplied via backend.hcl (gitignored).
    # Run: terraform init -backend-config=backend.hcl
  }
}

provider "cloudflare" {
  # Set CLOUDFLARE_API_TOKEN in your environment
}

locals {
  audio_host = "audio.${var.domain}"
  pages_host = "${cloudflare_pages_project.player.name}.pages.dev"
  site_hosts = toset([var.domain, "www.${var.domain}"])
}

# The domain must already be added to the Cloudflare account; Terraform only looks it up
data "cloudflare_zone" "site" {
  filter = {
    name = var.domain
    account = {
      id = var.cloudflare_account_id
    }
  }
}

# --- R2 bucket for audio segments ---

resource "cloudflare_r2_bucket" "audio" {
  account_id = var.cloudflare_account_id
  name       = "edgefm-audio"
  location   = var.r2_location
}

resource "cloudflare_r2_bucket_cors" "audio" {
  account_id  = var.cloudflare_account_id
  bucket_name = cloudflare_r2_bucket.audio.name

  rules = [{
    allowed = {
      headers = ["*"]
      methods = ["GET", "HEAD"]
      origins = ["*"]
    }
    max_age_seconds = 3600
  }]
}

# Public URL of the bucket, behind Cloudflare's CDN (creates its own DNS record)
resource "cloudflare_r2_custom_domain" "audio" {
  account_id  = var.cloudflare_account_id
  bucket_name = cloudflare_r2_bucket.audio.name
  zone_id     = data.cloudflare_zone.site.zone_id
  domain      = local.audio_host
  enabled     = true
}

# .ts and .json aren't cached by default, so every segment would be an R2 read.
# This makes everything on the audio host cacheable, for as long as the pipeline's
# Cache-Control headers say
resource "cloudflare_ruleset" "cache" {
  zone_id     = data.cloudflare_zone.site.zone_id
  name        = "default"
  description = "Cache settings"
  kind        = "zone"
  phase       = "http_request_cache_settings"

  rules = [{
    ref         = "cache_audio"
    description = "Cache audio segments and station.json"
    expression  = "(http.host eq \"${local.audio_host}\")"
    action      = "set_cache_settings"
    action_parameters = {
      cache       = true
      edge_ttl    = { mode = "respect_origin" }
      browser_ttl = { mode = "respect_origin" }
    }
  }]
}

# --- Cloudflare Pages project for the web player ---

# Direct upload: `npm run publish` deploys public/ along with the audio and the Worker,
# so the player never runs different scheduling code from them

resource "cloudflare_pages_project" "player" {
  account_id        = var.cloudflare_account_id
  name              = "edgefm-player"
  production_branch = "main"

  build_config = {
    build_command   = ""
    destination_dir = "public"
  }
}

resource "cloudflare_pages_domain" "site" {
  for_each = local.site_hosts

  account_id   = var.cloudflare_account_id
  project_name = cloudflare_pages_project.player.name
  name         = each.value
}

resource "cloudflare_dns_record" "site" {
  for_each = local.site_hosts

  zone_id = data.cloudflare_zone.site.zone_id
  name    = each.value
  type    = "CNAME"
  content = local.pages_host
  proxied = true
  ttl     = 1
}
