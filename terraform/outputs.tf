output "r2_bucket_name" {
  description = "R2 bucket name — use as bucket_name in wrangler.toml"
  value       = cloudflare_r2_bucket.audio.name
}

output "pages_url" {
  description = "Cloudflare Pages URL for the web player"
  value       = "https://${cloudflare_pages_project.player.name}.pages.dev"
}
