variable "cloudflare_account_id" {
  description = "Cloudflare account ID"
  type        = string
}

variable "r2_location" {
  description = "R2 bucket location hint (WEUR, EEUR, APAC, WNAM, ENAM)"
  type        = string
  default     = "WEUR"
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

variable "alert_email" {
  description = "Email address to receive billing spend alerts"
  type        = string
}
