//! Account billing weights for relative price comparisons, never bundled list prices.
use std::{collections::BTreeMap, time::Duration};

use serde::{Deserialize, Serialize};
use serde_json::Value;

#[path = "pricing_expression.rs"]
mod expression;
const REFERENCE_INPUT_TOKENS: u32 = 1000;
const BASELINE_MODEL: &str = "deepseek-v4.1-flash";

use super::{
    account_group, account_http_client_builder, api_ok,
    with_authenticated_session, parse_json, session_api_error, user_self, with_session,
    NewApiSession,
};

#[cfg(test)]
use super::authenticated_stored_session;

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelPrice {
    pub model: String,
    /// tokens, per_request, tiered, or unknown. Rates share the gateway's billing unit.
    pub billing: String,
    pub input_rate: Option<f64>,
    pub output_rate: Option<f64>,
    pub cache_read_rate: Option<f64>,
    pub cache_creation_rate: Option<f64>,
    pub tier: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelPricingCatalog {
    pub username: String,
    pub group: String,
    pub fetched_at: u64,
    pub valid_until: u64,
    pub reference_input_tokens: u32,
    /// Fixed comparison denominator; the model list still contains current rates.
    pub peak_baseline: Option<ModelPrice>,
    pub models: Vec<ModelPrice>,
}

fn rate(value: &Value) -> Option<f64> {
    value
        .as_f64()
        .or_else(|| value.as_str()?.parse().ok())
        .filter(|number| number.is_finite() && *number >= 0.0)
}

fn product(left: Option<f64>, right: Option<f64>) -> Option<f64> {
    let result = left? * right?;
    (result.is_finite() && result >= 0.0).then_some(result)
}

fn parse_model_price(
    item: &Value,
    group: &str,
    group_rate: Option<f64>,
    fetched_at: u64,
) -> Option<(ModelPrice, bool)> {
    let model = item.get("model_name")?.as_str()?.trim();
    if model.is_empty() || super::is_tool_service_model(model) {
        return None;
    }
    let mut price = ModelPrice {
        model: model.to_string(),
        billing: "unknown".to_string(),
        input_rate: None,
        output_rate: None,
        cache_read_rate: None,
        cache_creation_rate: None,
        tier: None,
    };
    // /api/pricing also lists models reachable through other usable groups.
    // The managed token follows exactly the account's current group.
    let enabled = item
        .get("enable_groups")
        .and_then(Value::as_array)
        .is_some_and(|groups| {
            groups
                .iter()
                .any(|value| matches!(value.as_str(), Some("all")) || value.as_str() == Some(group))
        });
    if !enabled || group_rate.is_none() {
        return Some((price, false));
    }
    let mode = item
        .get("billing_mode")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let has_expression = item
        .get("billing_expr")
        .and_then(Value::as_str)
        .is_some_and(|expr| !expr.trim().is_empty());
    let has_variants = item
        .get("billing_plugin_variants")
        .and_then(Value::as_array)
        .is_some_and(|variants| !variants.is_empty());
    if has_variants {
        price.billing = "tiered".to_string();
        return Some((price, false));
    }
    if mode == "tiered_expr" || has_expression {
        price.billing = "tiered".to_string();
        if let Some((fees, temporal)) = item
            .get("billing_expr")
            .and_then(Value::as_str)
            .and_then(|source| expression::evaluate(source, fetched_at, REFERENCE_INPUT_TOKENS))
        {
            price.tier = fees.tier;
            if fees.fixed.is_some() {
                price.billing = "per_request".to_string();
            } else {
                let mut weights = fees.rates;
                // New API keeps cache tokens inside p unless the expression
                // explicitly prices that category separately.
                if !fees.used[2] {
                    weights[2] = weights[0];
                }
                if !fees.used[3] {
                    weights[3] = weights[0];
                }
                let rates: Vec<_> = weights
                    .into_iter()
                    .map(|rate| product(Some(rate), group_rate))
                    .collect();
                if rates.iter().all(Option::is_some) {
                    price.billing = "tokens".to_string();
                    price.input_rate = rates[0];
                    price.output_rate = rates[1];
                    price.cache_read_rate = rates[2];
                    price.cache_creation_rate = rates[3];
                }
            }
            return Some((price, temporal));
        }
        return Some((price, false));
    }
    if !matches!(mode, "" | "ratio") {
        return Some((price, false));
    }
    match item.get("quota_type").and_then(rate) {
        Some(0.0) => {
            // Legacy model_ratio=1 is two billing currency units per million
            // input tokens. Expression coefficients are already per million.
            let input = product(
                product(item.get("model_ratio").and_then(rate), Some(2.0)),
                group_rate,
            );
            let output = product(input, item.get("completion_ratio").and_then(rate));
            if input.is_some() && output.is_some() {
                price.billing = "tokens".to_string();
                price.input_rate = input;
                price.output_rate = output;
                price.cache_read_rate = product(input, item.get("cache_ratio").and_then(rate));
                price.cache_creation_rate = product(
                    input,
                    item.get("create_cache_ratio")
                        .or_else(|| item.get("cache_creation_ratio"))
                        .and_then(rate),
                );
            }
        }
        Some(1.0) => price.billing = "per_request".to_string(),
        _ => {}
    }
    Some((price, false))
}

fn peak_baseline_price(
    items: &[Value],
    group: &str,
    group_rate: Option<f64>,
    fetched_at: u64,
) -> Option<ModelPrice> {
    let mut baseline = None;
    for item in items.iter().filter(|item| {
        item.get("model_name")
            .and_then(Value::as_str)
            .map(str::trim)
            == Some(BASELINE_MODEL)
    }) {
        let (mut current, temporal) = parse_model_price(item, group, group_rate, fetched_at)?;
        let peak = if temporal {
            // Supported time expressions depend only on hour and weekday in
            // UTC/Shanghai. One week of hourly samples covers every branch,
            // including peak rates when the user first signs in off peak.
            let day_start = fetched_at - fetched_at % 86_400_000;
            let mut peak = None;
            for hour in 0..7 * 24 {
                let sample = day_start.saturating_add(hour * 3_600_000);
                let (price, _) = parse_model_price(item, group, group_rate, sample)?;
                if price.tier.as_deref() != Some("peak") {
                    continue;
                }
                if price.billing != "tokens"
                    || peak.as_ref().is_some_and(|previous| previous != &price)
                {
                    return None;
                }
                peak = Some(price);
            }
            peak?
        } else {
            if current.billing != "tokens"
                || !matches!(
                    current.tier.as_deref(),
                    None | Some("peak" | "standard" | "base")
                )
            {
                return None;
            }
            // A constant token rate is also its rate during peak hours.
            current.tier = Some("peak".to_string());
            current
        };
        if baseline.as_ref().is_some_and(|previous| previous != &peak) {
            return None;
        }
        baseline = Some(peak);
    }
    baseline
}

fn parse_catalog(
    body: &Value,
    account: &Value,
    fetched_at: u64,
) -> Result<ModelPricingCatalog, String> {
    let group = account_group(account)?;
    let username = account
        .get("username")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or("Price response has no account identity.")?;
    let items = body
        .get("data")
        .and_then(Value::as_array)
        .ok_or("The gateway returned an unsupported price list.")?;
    let group_rate = body
        .get("group_ratio")
        .and_then(|groups| groups.get(&group))
        .and_then(rate);
    let peak_baseline = peak_baseline_price(items, &group, group_rate, fetched_at);
    let mut models = BTreeMap::<String, ModelPrice>::new();
    let mut valid_until = fetched_at.saturating_add(5 * 60_000);
    for item in items {
        if let Some((mut price, temporal)) = parse_model_price(item, &group, group_rate, fetched_at)
        {
            if temporal {
                valid_until = valid_until.min((fetched_at / 60_000 + 1) * 60_000);
            }
            if let Some(previous) = models.get(&price.model) {
                if previous != &price {
                    // Conflicting duplicate entries do not identify one billable rate.
                    price.billing = "unknown".to_string();
                    price.input_rate = None;
                    price.output_rate = None;
                    price.cache_read_rate = None;
                    price.cache_creation_rate = None;
                    price.tier = None;
                }
            }
            models.insert(price.model.clone(), price);
        }
    }
    Ok(ModelPricingCatalog {
        username: username.to_string(),
        group,
        fetched_at,
        valid_until,
        reference_input_tokens: REFERENCE_INPUT_TOKENS,
        peak_baseline,
        models: models.into_values().collect(),
    })
}

async fn fetch_pricing(
    client: &reqwest::Client,
    base: &str,
    session: &NewApiSession,
) -> Result<Value, String> {
    let response = with_session(client.get(format!("{base}/api/pricing")), session)
        .send()
        .await
        .map_err(|error| format!("获取模型价格失败: {error}"))?;
    let body = parse_json(response, "模型价格").await?;
    if !api_ok(&body) {
        return Err(session_api_error(&body, "获取模型价格失败"));
    }
    Ok(body)
}

/// Uses the existing account session; no credential ever enters the webview.
#[tauri::command]
pub async fn newapi_model_pricing() -> Result<ModelPricingCatalog, String> {
    let client = account_http_client_builder(Duration::from_secs(20))
        .build()
        .map_err(|error| format!("HTTP 客户端创建失败: {error}"))?;
    let (account, prices) = with_authenticated_session(&client, |client, base, session| async move {
        tokio::try_join!(
            user_self(&client, &base, &session),
            fetch_pricing(&client, &base, &session),
        )
    })
    .await?;
    let fetched_at = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|error| error.to_string())?
        .as_millis() as u64;
    parse_catalog(&prices, &account, fetched_at)
}

#[cfg(test)]
#[path = "../tests/newapi_pricing.rs"]
mod tests;
