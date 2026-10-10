output "r2_bucket_name" {
  description = "R2 bucket name — use as bucket_name in wrangler.toml"
  value       = cloudflare_r2_bucket.audio.name
}

output "audio_url" {
  description = "Public URL of the audio bucket — use as PUBLIC_URL in wrangler.toml and STATION_URL in public/index.html"
  value       = "https://${local.audio_host}"
}

output "site_url" {
  description = "Web player URL"
  value       = "https://${var.domain}"
}

output "pages_url" {
  description = "Cloudflare Pages URL for the web player"
  value       = "https://${local.pages_host}"
}
