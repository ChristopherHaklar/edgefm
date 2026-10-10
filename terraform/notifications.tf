# Cloudflare's own provider has no billing_budget_alert type yet, so this one resource
# is managed through the API directly. The alert only notifies: Cloudflare has no hard
# spending cap
provider "restapi" {
  uri                  = "https://api.cloudflare.com/client/v4"
  bearer_token         = var.cloudflare_api_token
  write_returns_object = true
  id_attribute         = "result/id"
}

locals {
  budget_alert = jsonencode({
    name        = "EdgeFM - spend reached ${var.budget_alert_dollars} USD"
    description = "Usage charges for the billing period reached the budget threshold"
    enabled     = true
    alert_type  = "billing_budget_alert"
    mechanisms = {
      email = [{ id = var.alert_email }]
    }
    filters = {
      total_spend_dollars = [tostring(var.budget_alert_dollars)]
    }
  })
}

resource "terraform_data" "budget_alert" {
  input = local.budget_alert
}

resource "restapi_object" "budget_alert" {
  path = "/accounts/${var.cloudflare_account_id}/alerting/v3/policies"
  data = local.budget_alert

  # Cloudflare wraps responses in { result: ... }. Left alone, the provider would read that
  # as drift and send the wrapped object back on update
  update_data               = local.budget_alert
  ignore_all_server_changes = true

  # The provider reports an error after a successful update, so any change to the alert
  # replaces it instead
  lifecycle {
    replace_triggered_by = [terraform_data.budget_alert]
  }
}
