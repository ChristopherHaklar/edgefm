variable "cloudflare_account_id" {
  description = "Cloudflare account ID"
  type        = string
}

variable "domain" {
  description = "Domain the station is hosted on. Must already be added to the Cloudflare account"
  type        = string
}

variable "r2_location" {
  description = "R2 bucket location hint (weur, eeur, apac, wnam, enam, oc)"
  type        = string
  default     = "weur"
}

variable "github_owner" {
  description = "GitHub username or org that owns the repo"
  type        = string
}

variable "github_repo" {
  description = "GitHub repo name"
  type        = string
  default     = "edgefm"
}
