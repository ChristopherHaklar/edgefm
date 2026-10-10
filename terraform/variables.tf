variable "cloudflare_api_token" {
  description = "Cloudflare API token. Set it with TF_VAR_cloudflare_api_token, not in a file"
  type        = string
  sensitive   = true
}

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

variable "alert_email" {
  description = "Email address to receive the budget alert"
  type        = string
}

variable "budget_alert_dollars" {
  description = "Email when usage charges for the billing period reach this many dollars"
  type        = number
  default     = 1
}
