use reqwest::header;
use serde::Deserialize;
use serde_json::Value as JsonValue;
use tracing::warn;

use super::{CheckoutInput, CheckoutSession, ProcessorContext, ProcessorError, ProcessorKind};

pub(crate) async fn create_session(
    context: ProcessorContext<'_>,
    input: CheckoutInput<'_>,
) -> Result<CheckoutSession, ProcessorError> {
    let config = context
        .config
        .stripe
        .as_ref()
        .ok_or(ProcessorError::MissingConfig(
            "Stripe processor is not configured",
        ))?;

    if input.plan.monthly_price_cents <= 0 {
        return Err(ProcessorError::NotImplemented(
            "Stripe processor can only be used for paid plans",
        ));
    }

    let plan_key = input.plan.id.to_ascii_lowercase();
    let price_id = config.price_lookup.get(&plan_key).ok_or_else(|| {
        ProcessorError::MissingConfig("Stripe price ID missing for requested plan")
    })?;

    let endpoint = format!("{}/v1/checkout/sessions", config.api_base_url);
    let mut form = vec![
        ("mode".to_string(), "subscription".to_string()),
        ("success_url".to_string(), input.success_url.to_string()),
        ("cancel_url".to_string(), input.cancel_url.to_string()),
        ("client_reference_id".to_string(), input.org_id.to_string()),
        ("line_items[0][price]".to_string(), price_id.to_string()),
        ("line_items[0][quantity]".to_string(), "1".to_string()),
    ];
    if let Some(customer_id) = input
        .customer_id
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        form.push(("customer".to_string(), customer_id.to_string()));
    }
    if config.checkout_tos_consent {
        form.push((
            "consent_collection[terms_of_service]".to_string(),
            "required".to_string(),
        ));
    }
    form.extend([
        ("metadata[orgId]".to_string(), input.org_id.to_string()),
        (
            "metadata[projectId]".to_string(),
            input.project_id.to_string(),
        ),
        ("metadata[planId]".to_string(), input.plan.id.to_string()),
        (
            "subscription_data[metadata][orgId]".to_string(),
            input.org_id.to_string(),
        ),
        (
            "subscription_data[metadata][projectId]".to_string(),
            input.project_id.to_string(),
        ),
        (
            "subscription_data[metadata][planId]".to_string(),
            input.plan.id.to_string(),
        ),
    ]);

    let send_checkout_form = |form: Vec<(String, String)>| {
        let endpoint = endpoint.clone();
        async move {
            let response = context
                .http_client
                .post(&endpoint)
                .header(
                    header::AUTHORIZATION,
                    format!("Bearer {}", config.secret_key),
                )
                .header(header::CONTENT_TYPE, "application/x-www-form-urlencoded")
                .form(&form)
                .send()
                .await
                .map_err(|error| {
                    warn!(?error, "failed to create Stripe checkout session");
                    ProcessorError::Upstream {
                        message: "Failed to reach Stripe checkout processor".to_string(),
                    }
                })?;
            let status = response.status();
            let body = response
                .text()
                .await
                .unwrap_or_else(|_| "<unavailable body>".to_string());
            Ok::<_, ProcessorError>((status, body))
        }
    };

    let had_customer = form.iter().any(|(key, _)| key == "customer");
    let (mut status, mut body) = send_checkout_form(form.clone()).await?;

    // A stored customer id can go stale (deleted customer, test/live mode
    // switch). That must not brick checkout for the org forever — drop the
    // reuse and let Stripe mint a fresh customer.
    if !status.is_success() && had_customer && body.contains("No such customer") {
        warn!(
            body = body.as_str(),
            "stored Stripe customer id is invalid; retrying checkout without customer reuse"
        );
        let retry_form: Vec<(String, String)> = form
            .into_iter()
            .filter(|(key, _)| key != "customer")
            .collect();
        (status, body) = send_checkout_form(retry_form).await?;
    }

    if !status.is_success() {
        warn!(
            status = status.as_u16(),
            body = body.as_str(),
            "Stripe checkout session request rejected"
        );
        return Err(ProcessorError::Upstream {
            message: format!(
                "Stripe rejected the checkout request (status {})",
                status.as_u16()
            ),
        });
    }

    let parsed: StripeCheckoutResponse = serde_json::from_str(&body).map_err(|error| {
        warn!(
            ?error,
            body = body.as_str(),
            "failed to parse Stripe checkout session response"
        );
        ProcessorError::Upstream {
            message: "Stripe returned an unexpected response".to_string(),
        }
    })?;

    let checkout_url = parsed.url.ok_or_else(|| ProcessorError::Upstream {
        message: "Stripe response missing checkout URL".to_string(),
    })?;
    let reference = parsed.id;
    let expires_at = parsed.expires_at.map(|timestamp| timestamp.to_string());

    Ok(CheckoutSession {
        processor: ProcessorKind::Stripe,
        checkout_url,
        reference,
        expires_at,
    })
}

pub(crate) async fn create_portal_session(
    context: ProcessorContext<'_>,
    external_id: &str,
    return_url: &str,
) -> Result<String, ProcessorError> {
    let config = context
        .config
        .stripe
        .as_ref()
        .ok_or(ProcessorError::MissingConfig(
            "Stripe processor is not configured",
        ))?;

    let external_id = external_id.trim();
    if external_id.is_empty() {
        return Err(ProcessorError::Upstream {
            message: "Subscription reference missing for billing portal".to_string(),
        });
    }
    let return_url = return_url.trim();
    if return_url.is_empty() {
        return Err(ProcessorError::Upstream {
            message: "Return URL missing for billing portal".to_string(),
        });
    }

    let customer_id = resolve_customer_id(&context, config, external_id).await?;

    let endpoint = format!("{}/v1/billing_portal/sessions", config.api_base_url);
    let mut form = vec![
        ("customer".to_string(), customer_id),
        ("return_url".to_string(), return_url.to_string()),
    ];
    if let Some(configuration) = config.portal_configuration_id.as_deref() {
        // Pin the portal configuration so a dashboard-side default change
        // cannot silently alter what cancel/plan-switch options users get.
        form.push(("configuration".to_string(), configuration.to_string()));
    }

    let response = context
        .http_client
        .post(&endpoint)
        .header(
            header::AUTHORIZATION,
            format!("Bearer {}", config.secret_key),
        )
        .header(header::CONTENT_TYPE, "application/x-www-form-urlencoded")
        .form(&form)
        .send()
        .await
        .map_err(|error| {
            warn!(?error, "failed to create Stripe billing portal session");
            ProcessorError::Upstream {
                message: "Failed to reach Stripe billing portal".to_string(),
            }
        })?;

    let status = response.status();
    let body = response
        .text()
        .await
        .unwrap_or_else(|_| "<unavailable body>".to_string());
    if !status.is_success() {
        warn!(
            status = status.as_u16(),
            body = body.as_str(),
            "Stripe billing portal request rejected"
        );
        return Err(ProcessorError::Upstream {
            message: format!(
                "Stripe rejected the billing portal request (status {})",
                status.as_u16()
            ),
        });
    }

    let parsed: StripePortalResponse = serde_json::from_str(&body).map_err(|error| {
        warn!(
            ?error,
            body = body.as_str(),
            "failed to parse Stripe billing portal response"
        );
        ProcessorError::Upstream {
            message: "Stripe returned an unexpected response".to_string(),
        }
    })?;

    let url = parsed.url.ok_or_else(|| ProcessorError::Upstream {
        message: "Stripe response missing billing portal URL".to_string(),
    })?;

    Ok(url)
}

#[derive(Deserialize)]
struct StripeCheckoutResponse {
    id: Option<String>,
    url: Option<String>,
    expires_at: Option<i64>,
}

async fn resolve_customer_id(
    context: &ProcessorContext<'_>,
    config: &crate::config::StripeConfig,
    external_id: &str,
) -> Result<String, ProcessorError> {
    if external_id.starts_with("cs_") {
        return load_customer_from_checkout_session(context, config, external_id).await;
    }
    if external_id.starts_with("sub_") {
        return load_customer_from_subscription(context, config, external_id).await;
    }

    match load_customer_from_subscription(context, config, external_id).await {
        Ok(customer_id) => Ok(customer_id),
        Err(subscription_error) => {
            load_customer_from_checkout_session(context, config, external_id)
                .await
                .map_err(|_| subscription_error)
        }
    }
}

async fn load_customer_from_subscription(
    context: &ProcessorContext<'_>,
    config: &crate::config::StripeConfig,
    subscription_id: &str,
) -> Result<String, ProcessorError> {
    let endpoint = format!(
        "{}/v1/subscriptions/{}",
        config.api_base_url,
        urlencoding::encode(subscription_id.trim())
    );

    let response = context
        .http_client
        .get(&endpoint)
        .header(
            header::AUTHORIZATION,
            format!("Bearer {}", config.secret_key),
        )
        .send()
        .await
        .map_err(|error| {
            warn!(?error, "failed to retrieve Stripe subscription for portal");
            ProcessorError::Upstream {
                message: "Failed to reach Stripe subscription API".to_string(),
            }
        })?;

    let status = response.status();
    let body = response
        .text()
        .await
        .unwrap_or_else(|_| "<unavailable body>".to_string());
    if !status.is_success() {
        warn!(
            status = status.as_u16(),
            body = body.as_str(),
            "Stripe subscription lookup rejected"
        );
        return Err(ProcessorError::Upstream {
            message: format!(
                "Stripe rejected the subscription lookup (status {})",
                status.as_u16()
            ),
        });
    }

    let parsed: StripeSubscriptionResponse = serde_json::from_str(&body).map_err(|error| {
        warn!(
            ?error,
            body = body.as_str(),
            "failed to parse Stripe subscription response"
        );
        ProcessorError::Upstream {
            message: "Stripe returned an unexpected subscription response".to_string(),
        }
    })?;

    parsed
        .customer
        .and_then(parse_customer_reference)
        .ok_or_else(|| ProcessorError::Upstream {
            message: "Stripe subscription response missing customer".to_string(),
        })
}

async fn load_customer_from_checkout_session(
    context: &ProcessorContext<'_>,
    config: &crate::config::StripeConfig,
    checkout_id: &str,
) -> Result<String, ProcessorError> {
    let endpoint = format!(
        "{}/v1/checkout/sessions/{}",
        config.api_base_url,
        urlencoding::encode(checkout_id.trim())
    );

    let response = context
        .http_client
        .get(&endpoint)
        .header(
            header::AUTHORIZATION,
            format!("Bearer {}", config.secret_key),
        )
        .send()
        .await
        .map_err(|error| {
            warn!(
                ?error,
                "failed to retrieve Stripe checkout session for portal"
            );
            ProcessorError::Upstream {
                message: "Failed to reach Stripe checkout session API".to_string(),
            }
        })?;

    let status = response.status();
    let body = response
        .text()
        .await
        .unwrap_or_else(|_| "<unavailable body>".to_string());
    if !status.is_success() {
        warn!(
            status = status.as_u16(),
            body = body.as_str(),
            "Stripe checkout session lookup rejected"
        );
        return Err(ProcessorError::Upstream {
            message: format!(
                "Stripe rejected the checkout session lookup (status {})",
                status.as_u16()
            ),
        });
    }

    let parsed: StripeCheckoutSessionResponse = serde_json::from_str(&body).map_err(|error| {
        warn!(
            ?error,
            body = body.as_str(),
            "failed to parse Stripe checkout session response"
        );
        ProcessorError::Upstream {
            message: "Stripe returned an unexpected checkout session response".to_string(),
        }
    })?;

    parsed
        .customer
        .and_then(parse_customer_reference)
        .ok_or_else(|| ProcessorError::Upstream {
            message: "Stripe checkout session response missing customer".to_string(),
        })
}

fn parse_customer_reference(value: JsonValue) -> Option<String> {
    match value {
        JsonValue::String(value) => {
            let trimmed = value.trim();
            if trimmed.is_empty() {
                None
            } else {
                Some(trimmed.to_string())
            }
        }
        JsonValue::Object(map) => map
            .get("id")
            .and_then(JsonValue::as_str)
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty()),
        _ => None,
    }
}

/// Point-in-time details of a Stripe subscription needed by webhook handlers.
/// Fields are read version-tolerantly: `current_period_end` lives at the top
/// level pre-Basil and on the subscription items in newer API versions.
#[derive(Debug, Default)]
pub(crate) struct SubscriptionSnapshot {
    pub(crate) customer: Option<String>,
    pub(crate) cancel_at_period_end: Option<bool>,
    pub(crate) current_period_end: Option<i64>,
}

pub(crate) fn subscription_snapshot_from_object(object: &JsonValue) -> SubscriptionSnapshot {
    SubscriptionSnapshot {
        customer: object
            .get("customer")
            .cloned()
            .and_then(parse_customer_reference),
        cancel_at_period_end: object
            .get("cancel_at_period_end")
            .and_then(JsonValue::as_bool),
        current_period_end: subscription_current_period_end(object),
    }
}

fn subscription_current_period_end(object: &JsonValue) -> Option<i64> {
    if let Some(value) = object.get("current_period_end").and_then(JsonValue::as_i64) {
        return Some(value);
    }
    object
        .get("items")
        .and_then(|items| items.get("data"))
        .and_then(JsonValue::as_array)
        .and_then(|data| {
            data.iter()
                .filter_map(|item| item.get("current_period_end").and_then(JsonValue::as_i64))
                .max()
        })
}

pub(crate) async fn fetch_subscription_snapshot(
    context: &ProcessorContext<'_>,
    subscription_id: &str,
) -> Result<SubscriptionSnapshot, ProcessorError> {
    let config = context
        .config
        .stripe
        .as_ref()
        .ok_or(ProcessorError::MissingConfig(
            "Stripe processor is not configured",
        ))?;
    let object = fetch_stripe_object(
        context,
        config,
        &format!(
            "/v1/subscriptions/{}",
            urlencoding::encode(subscription_id.trim())
        ),
    )
    .await?;
    Ok(subscription_snapshot_from_object(&object))
}

/// Resolves the subscription behind a charge (charge -> invoice ->
/// subscription), tolerating both pre- and post-Basil invoice shapes.
pub(crate) async fn fetch_charge_subscription_id(
    context: &ProcessorContext<'_>,
    charge_id: &str,
) -> Result<Option<String>, ProcessorError> {
    let config = context
        .config
        .stripe
        .as_ref()
        .ok_or(ProcessorError::MissingConfig(
            "Stripe processor is not configured",
        ))?;
    let charge = fetch_stripe_object(
        context,
        config,
        &format!("/v1/charges/{}", urlencoding::encode(charge_id.trim())),
    )
    .await?;
    let Some(invoice_id) = charge
        .get("invoice")
        .cloned()
        .and_then(parse_customer_reference)
    else {
        return Ok(None);
    };
    let invoice = fetch_stripe_object(
        context,
        config,
        &format!("/v1/invoices/{}", urlencoding::encode(invoice_id.trim())),
    )
    .await?;
    Ok(invoice_subscription_reference(&invoice))
}

/// The invoice's subscription reference: top-level `subscription` pre-Basil,
/// `parent.subscription_details.subscription` from API version 2025-03-31 on.
pub(crate) fn invoice_subscription_reference(invoice: &JsonValue) -> Option<String> {
    invoice
        .get("subscription")
        .cloned()
        .and_then(parse_customer_reference)
        .or_else(|| {
            invoice
                .get("parent")
                .and_then(|parent| parent.get("subscription_details"))
                .and_then(|details| details.get("subscription"))
                .cloned()
                .and_then(parse_customer_reference)
        })
}

/// Switches an existing subscription to a different price in place (plan
/// change without a second checkout — a second checkout would create a second
/// live subscription and double-bill the customer). Upgrades invoice the
/// prorated difference immediately; downgrades credit it against the next
/// invoice. Entitlements are applied by the customer.subscription.updated
/// webhook, not here.
pub(crate) async fn change_subscription_price(
    context: &ProcessorContext<'_>,
    subscription_id: &str,
    price_id: &str,
    plan_id: &str,
) -> Result<(), ProcessorError> {
    let config = context
        .config
        .stripe
        .as_ref()
        .ok_or(ProcessorError::MissingConfig(
            "Stripe processor is not configured",
        ))?;

    let subscription = fetch_stripe_object(
        context,
        config,
        &format!(
            "/v1/subscriptions/{}",
            urlencoding::encode(subscription_id.trim())
        ),
    )
    .await?;
    let item_id = subscription
        .get("items")
        .and_then(|items| items.get("data"))
        .and_then(JsonValue::as_array)
        .and_then(|data| data.first())
        .and_then(|item| item.get("id"))
        .and_then(JsonValue::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| ProcessorError::Upstream {
            message: "Stripe subscription has no item to update".to_string(),
        })?;

    let endpoint = format!(
        "{}/v1/subscriptions/{}",
        config.api_base_url,
        urlencoding::encode(subscription_id.trim())
    );
    let form = vec![
        ("items[0][id]".to_string(), item_id.to_string()),
        ("items[0][price]".to_string(), price_id.to_string()),
        (
            "proration_behavior".to_string(),
            "always_invoice".to_string(),
        ),
        // Choosing a new plan is a clear intent to stay: clear any pending
        // cancel-at-period-end, otherwise the customer pays a prorated
        // upgrade on a subscription that still ends this period.
        ("cancel_at_period_end".to_string(), "false".to_string()),
        ("metadata[planId]".to_string(), plan_id.to_string()),
    ];

    let response = context
        .http_client
        .post(&endpoint)
        .header(
            header::AUTHORIZATION,
            format!("Bearer {}", config.secret_key),
        )
        .header(header::CONTENT_TYPE, "application/x-www-form-urlencoded")
        .form(&form)
        .send()
        .await
        .map_err(|error| {
            warn!(
                ?error,
                subscription_id, "failed to reach Stripe to change plan"
            );
            ProcessorError::Upstream {
                message: "Failed to reach Stripe to change the plan".to_string(),
            }
        })?;

    let status = response.status();
    let body = response
        .text()
        .await
        .unwrap_or_else(|_| "<unavailable body>".to_string());
    if !status.is_success() {
        warn!(
            status = status.as_u16(),
            subscription_id,
            body = body.as_str(),
            "Stripe subscription plan change rejected"
        );
        return Err(ProcessorError::Upstream {
            message: format!(
                "Stripe rejected the plan change (status {})",
                status.as_u16()
            ),
        });
    }
    Ok(())
}

/// Immediately cancels a subscription (org deletion path — there is no org
/// left to bill). A 404 counts as success: the subscription is already gone.
pub(crate) async fn cancel_subscription(
    context: &ProcessorContext<'_>,
    subscription_id: &str,
) -> Result<(), ProcessorError> {
    let config = context
        .config
        .stripe
        .as_ref()
        .ok_or(ProcessorError::MissingConfig(
            "Stripe processor is not configured",
        ))?;
    let endpoint = format!(
        "{}/v1/subscriptions/{}",
        config.api_base_url,
        urlencoding::encode(subscription_id.trim())
    );
    let response = context
        .http_client
        .delete(&endpoint)
        .header(
            header::AUTHORIZATION,
            format!("Bearer {}", config.secret_key),
        )
        .send()
        .await
        .map_err(|error| {
            warn!(
                ?error,
                subscription_id, "failed to reach Stripe to cancel subscription"
            );
            ProcessorError::Upstream {
                message: "Failed to reach Stripe to cancel the subscription".to_string(),
            }
        })?;

    let status = response.status();
    if status.is_success() || status == reqwest::StatusCode::NOT_FOUND {
        return Ok(());
    }
    let body = response
        .text()
        .await
        .unwrap_or_else(|_| "<unavailable body>".to_string());
    warn!(
        status = status.as_u16(),
        subscription_id,
        body = body.as_str(),
        "Stripe subscription cancel rejected"
    );
    Err(ProcessorError::Upstream {
        message: format!(
            "Stripe rejected the subscription cancellation (status {})",
            status.as_u16()
        ),
    })
}

async fn fetch_stripe_object(
    context: &ProcessorContext<'_>,
    config: &crate::config::StripeConfig,
    path: &str,
) -> Result<JsonValue, ProcessorError> {
    let endpoint = format!("{}{}", config.api_base_url, path);
    let response = context
        .http_client
        .get(&endpoint)
        .header(
            header::AUTHORIZATION,
            format!("Bearer {}", config.secret_key),
        )
        .send()
        .await
        .map_err(|error| {
            warn!(?error, path, "failed to reach Stripe API");
            ProcessorError::Upstream {
                message: "Failed to reach Stripe API".to_string(),
            }
        })?;

    let status = response.status();
    let body = response
        .text()
        .await
        .unwrap_or_else(|_| "<unavailable body>".to_string());
    if !status.is_success() {
        warn!(
            status = status.as_u16(),
            path,
            body = body.as_str(),
            "Stripe object lookup rejected"
        );
        return Err(ProcessorError::Upstream {
            message: format!("Stripe rejected the lookup (status {})", status.as_u16()),
        });
    }
    serde_json::from_str(&body).map_err(|error| {
        warn!(?error, path, "failed to parse Stripe object response");
        ProcessorError::Upstream {
            message: "Stripe returned an unexpected response".to_string(),
        }
    })
}

#[derive(Deserialize)]
struct StripeSubscriptionResponse {
    customer: Option<JsonValue>,
}

#[derive(Deserialize)]
struct StripeCheckoutSessionResponse {
    customer: Option<JsonValue>,
}

#[derive(Deserialize)]
struct StripePortalResponse {
    url: Option<String>,
}
