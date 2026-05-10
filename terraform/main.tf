terraform {
  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 4.0"
    }
  }

  backend "s3" {
    # Config is supplied via backend.hcl (gitignored).
    # Run: terraform init -backend-config=backend.hcl
  }
}

provider "cloudflare" {
  # Set CLOUDFLARE_API_TOKEN in your environment
  account_id = var.cloudflare_account_id
}

# --- R2 bucket for audio segments ---

resource "cloudflare_r2_bucket" "audio" {
  account_id = var.cloudflare_account_id
  name       = "edgefm-audio"
  location   = var.r2_location
}

resource "cloudflare_r2_bucket_cors_configuration" "audio" {
  account_id  = var.cloudflare_account_id
  bucket_name = cloudflare_r2_bucket.audio.name

  cors_rule {
    allowed_headers = ["*"]
    allowed_methods = ["GET", "HEAD"]
    allowed_origins = ["*"]
    max_age_seconds = 3600
  }
}

# --- Cloudflare Pages project for the web player ---

resource "cloudflare_pages_project" "player" {
  account_id        = var.cloudflare_account_id
  name              = "edgefm-player"
  production_branch = "main"

  source {
    type = "github"
    config {
      owner                         = var.github_owner
      repo_name                     = var.github_repo
      production_branch             = "main"
      pr_comments_enabled           = false
      deployments_enabled           = true
      production_deployment_enabled = true
    }
  }

  build_config {
    build_command   = ""
    destination_dir = "public"
  }
}
