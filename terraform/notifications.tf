resource "cloudflare_notification_policy" "spend_alert" {
  account_id  = var.cloudflare_account_id
  name        = "EdgeFM - Any Spend Detected"
  description = "Fires as soon as any billable usage is detected on the account"
  enabled     = true
  alert_type  = "billing_usage_alert"

  email_integration {
    id   = var.alert_email
    name = var.alert_email
  }

  filters {
    spend_limit_alert = ["0"]
  }
}
