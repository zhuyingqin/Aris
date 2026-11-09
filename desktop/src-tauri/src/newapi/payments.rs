//! Desktop checkout uses the website's pricing and fulfillment service. Account
//! credentials stay here; only a validated Alipay cashier URL reaches the UI.

use std::{collections::HashMap, time::Duration};

use reqwest::{header::LOCATION, StatusCode};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use super::{
    account_http_client_builder, api_ok, parse_json, secure_base, with_authenticated_session,
    with_session, NewApiSession, MANAGED_NEWAPI_CONFIG,
};

const PAYMENT_PATH: &str = "/v1/payments/alipay";
const GROUPS: [&str; 3] = ["go", "plus", "pro"];
static CHECKOUT_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PaymentOffer {
    pub group: String,
    pub plan_id: i64,
    pub price_fen: i64,
    pub total_amount: i64,
    pub original_fen: i64,
    pub promotion_fen: Option<i64>,
    pub student_fen: Option<i64>,
    pub price_kind: String,
    pub revision: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PaymentCatalog {
    pub user_id: i64,
    pub purchase_enabled: bool,
    pub page_pay_enabled: bool,
    pub student_check_unavailable: bool,
    pub offers: Vec<PaymentOffer>,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PaymentSelection {
    pub user_id: i64,
    pub group: String,
    pub expected_revision: i64,
    pub expected_fen: i64,
    pub price_kind: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PaymentCheckout {
    pub cashier_url: String,
    pub trade_no: String,
}

fn payment_origin(account_base: &str) -> Result<String, String> {
    let config: Value = serde_json::from_str(MANAGED_NEWAPI_CONFIG)
        .map_err(|_| "PAYMENT_UNAVAILABLE".to_string())?;
    // Build configuration explicitly pairs this origin with the managed
    // account issuer. Never take a credential destination from the webview.
    let issuer = secure_base(
        config
            .get("baseUrl")
            .and_then(Value::as_str)
            .unwrap_or_default(),
    )?;
    if secure_base(account_base)? != issuer {
        // Development loopback sessions and build-time account overrides must
        // never send their credentials to the production payment service.
        return Err("PAYMENT_UNAVAILABLE".to_string());
    }
    let origin = secure_base(
        config
            .get("paymentOrigin")
            .and_then(Value::as_str)
            .unwrap_or_default(),
    )?;
    if !origin.starts_with("https://") {
        return Err("PAYMENT_UNAVAILABLE".to_string());
    }
    Ok(origin)
}

fn valid_fen(value: i64) -> bool {
    (1..=999_900).contains(&value)
}

fn validate_offers(data: &Value) -> Result<Vec<PaymentOffer>, String> {
    let offers: Vec<PaymentOffer> =
        serde_json::from_value(data.clone()).map_err(|_| "PAYMENT_INVALID_QUOTE".to_string())?;
    if offers.len() != GROUPS.len() {
        return Err("PAYMENT_INVALID_QUOTE".to_string());
    }
    let mut sorted = Vec::new();
    for group in GROUPS {
        let matches: Vec<_> = offers.iter().filter(|offer| offer.group == group).collect();
        let [offer] = matches.as_slice() else {
            return Err("PAYMENT_INVALID_QUOTE".to_string());
        };
        let public_fen = offer.promotion_fen.unwrap_or(offer.original_fen);
        let expected_fen = match offer.price_kind.as_str() {
            "original" if offer.promotion_fen.is_none() => Some(offer.original_fen),
            "promotion" => offer.promotion_fen,
            "student" => offer.student_fen.filter(|price| *price < public_fen),
            _ => None,
        };
        if offer.plan_id <= 0
            || offer.plan_id > 9_007_199_254_740_991
            || !valid_fen(offer.original_fen)
            || !valid_fen(offer.price_fen)
            || [offer.promotion_fen, offer.student_fen]
                .into_iter()
                .flatten()
                .any(|price| !valid_fen(price) || price > offer.original_fen)
            || expected_fen != Some(offer.price_fen)
            || offer.revision < 1
            || offer.revision > 9_007_199_254_740_991
            || !(5_000..=9_007_199_254_740_991).contains(&offer.total_amount)
            || offer.total_amount % 5_000 != 0
        {
            return Err("PAYMENT_INVALID_QUOTE".to_string());
        }
        sorted.push((**offer).clone());
    }
    Ok(sorted)
}

async fn payment_json(response: reqwest::Response, uncertain: bool) -> Result<Value, String> {
    let status = response.status();
    let fallback = if uncertain {
        "PAYMENT_ORDER_UNCERTAIN"
    } else {
        "PAYMENT_UNAVAILABLE"
    };
    let body = parse_json(response, "支付服务")
        .await
        .map_err(|_| fallback.to_string())?;
    if status == StatusCode::UNAUTHORIZED {
        // The pricing service collapses upstream expired/revoked tokens into
        // auth_required. Reuse the existing refresh-and-retry-once contract.
        return Err("AUTH_UNAUTHORIZED".to_string());
    }
    if !status.is_success() || body.get("success") == Some(&Value::Bool(false)) {
        return Err(match body.get("message").and_then(Value::as_str) {
            Some("stale_price") => "PAYMENT_STALE_PRICE",
            Some("student_required") => "PAYMENT_STUDENT_REQUIRED",
            Some("student_unavailable") => "PAYMENT_STUDENT_UNAVAILABLE",
            Some("payment_unavailable") => "PAYMENT_UNAVAILABLE",
            _ => fallback,
        }
        .to_string());
    }
    Ok(body)
}

async fn payment_status(client: &reqwest::Client, origin: &str) -> Result<Value, String> {
    let response = client
        .get(format!("{origin}{PAYMENT_PATH}/status"))
        .send()
        .await
        .map_err(|_| "PAYMENT_UNAVAILABLE".to_string())?;
    let status = payment_json(response, false).await?;
    if status.get("service").and_then(Value::as_str) != Some("somniq-alipay")
        || status.get("mode").and_then(Value::as_str) != Some("one_time")
    {
        return Err("PAYMENT_UNAVAILABLE".to_string());
    }
    Ok(status)
}

async fn read_catalog(
    client: &reqwest::Client,
    origin: &str,
    session: &NewApiSession,
) -> Result<PaymentCatalog, String> {
    let (status, quote) = tokio::try_join!(payment_status(client, origin), async {
        let response = with_session(client.get(format!("{origin}{PAYMENT_PATH}/quote")), session)
            .send()
            .await
            .map_err(|_| "PAYMENT_UNAVAILABLE".to_string())?;
        payment_json(response, false).await
    })?;
    let data = &quote["data"];
    if !api_ok(&quote) || data["userId"].as_i64() != Some(session.user_id) {
        return Err("PAYMENT_ACCOUNT_CHANGED".to_string());
    }
    Ok(PaymentCatalog {
        user_id: session.user_id,
        purchase_enabled: status["purchaseEnabled"].as_bool() == Some(true),
        page_pay_enabled: status["pagePayEnabled"].as_bool() == Some(true),
        student_check_unavailable: data["eligibilityStatus"].as_str() == Some("unavailable"),
        offers: validate_offers(&data["prices"])?,
    })
}

#[tauri::command]
pub async fn newapi_payment_catalog() -> Result<PaymentCatalog, String> {
    let client = account_http_client_builder(Duration::from_secs(25))
        .build()
        .map_err(|_| "PAYMENT_UNAVAILABLE".to_string())?;
    with_authenticated_session(&client, |client, base, session| async move {
        let origin = payment_origin(&base)?;
        read_catalog(&client, &origin, &session).await
    })
    .await
}

fn money_fen(value: &str) -> Option<i64> {
    let (whole, cents) = value.split_once('.').unwrap_or((value, ""));
    if whole.is_empty()
        || whole.len() > 4
        || cents.len() > 2
        || (value.contains('.') && cents.is_empty())
        || !whole
            .bytes()
            .chain(cents.bytes())
            .all(|c| c.is_ascii_digit())
        || (whole.len() > 1 && whole.starts_with('0'))
    {
        return None;
    }
    let fen = whole.parse::<i64>().ok()? * 100
        + if cents.is_empty() {
            0
        } else {
            cents.parse::<i64>().ok()? * if cents.len() == 1 { 10 } else { 1 }
        };
    valid_fen(fen).then_some(fen)
}

fn validate_order(
    body: &Value,
    selection: &PaymentSelection,
    origin: &str,
    account_base: &str,
) -> Result<HashMap<String, String>, String> {
    let invalid = || "PAYMENT_INVALID_ORDER".to_string();
    if body["message"].as_str() != Some("success")
        || body["url"].as_str() != Some(format!("{origin}{PAYMENT_PATH}/submit.php").as_str())
    {
        return Err(invalid());
    }
    let fields: HashMap<String, String> =
        serde_json::from_value(body["data"].clone()).map_err(|_| invalid())?;
    let get = |key: &str| fields.get(key).map(String::as_str).unwrap_or_default();
    let prefix = format!("SUBUSR{}NO", selection.user_id);
    let suffix = get("out_trade_no")
        .strip_prefix(&prefix)
        .ok_or_else(invalid)?;
    if fields.len() > 20
        || fields
            .iter()
            .any(|(key, value)| key.len() > 64 || value.len() > 2_048)
        || suffix.len() != 16
        || !suffix.as_bytes()[..6]
            .iter()
            .all(|c| c.is_ascii_alphanumeric())
        || !suffix.as_bytes()[6..].iter().all(|c| c.is_ascii_digit())
        || get("type") != "alipay"
        || get("pid").is_empty()
        || get("sign_type") != "MD5"
        || get("sign").len() != 32
        || !get("sign").bytes().all(|c| c.is_ascii_hexdigit())
        || money_fen(get("money")) != Some(selection.expected_fen)
        || !get("name").starts_with("SUB:")
        || get("name").len() > 128
        || get("notify_url") != format!("{account_base}/api/subscription/epay/notify")
        || get("return_url") != format!("{account_base}/api/subscription/epay/return")
    {
        return Err(invalid());
    }
    Ok(fields)
}

fn validate_cashier(url: &str) -> Result<String, String> {
    let parsed = reqwest::Url::parse(url).map_err(|_| "PAYMENT_INVALID_CASHIER".to_string())?;
    let methods: Vec<_> = parsed
        .query_pairs()
        .filter(|(key, _)| key == "method")
        .map(|(_, value)| value)
        .collect();
    if url.len() > 16_384
        || url.chars().any(char::is_control)
        || parsed.scheme() != "https"
        || parsed.host_str() != Some("openapi.alipay.com")
        || parsed.port_or_known_default() != Some(443)
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.path() != "/gateway.do"
        || parsed.fragment().is_some()
        || methods.len() != 1
        || methods[0] != "alipay.trade.page.pay"
    {
        return Err("PAYMENT_INVALID_CASHIER".to_string());
    }
    Ok(parsed.to_string())
}

async fn submit_order(
    client: &reqwest::Client,
    origin: &str,
    fields: &HashMap<String, String>,
) -> Result<PaymentCheckout, String> {
    // This client has neither cookies nor default Authorization. The signed
    // form is submitted only to the configured bridge, never to a supplied URL.
    let response = client
        .post(format!("{origin}{PAYMENT_PATH}/submit.php"))
        .header("Origin", origin)
        .header("Sec-CH-UA-Mobile", "?0")
        .form(fields)
        .send()
        .await
        .map_err(|_| "PAYMENT_ORDER_UNCERTAIN".to_string())?;
    if response.status() != StatusCode::SEE_OTHER {
        return Err("PAYMENT_ORDER_UNCERTAIN".to_string());
    }
    let location = response
        .headers()
        .get(LOCATION)
        .and_then(|value| value.to_str().ok())
        .ok_or_else(|| "PAYMENT_INVALID_CASHIER".to_string())?;
    Ok(PaymentCheckout {
        cashier_url: validate_cashier(location)?,
        trade_no: fields.get("out_trade_no").cloned().unwrap_or_default(),
    })
}

async fn create_order(
    client: &reqwest::Client,
    origin: &str,
    base: &str,
    session: &NewApiSession,
    selection: &PaymentSelection,
) -> Result<HashMap<String, String>, String> {
    if selection.user_id != session.user_id {
        return Err("PAYMENT_ACCOUNT_CHANGED".to_string());
    }
    let status = payment_status(client, origin).await?;
    if status["purchaseEnabled"].as_bool() != Some(true)
        || status["pagePayEnabled"].as_bool() != Some(true)
    {
        return Err("PAYMENT_UNAVAILABLE".to_string());
    }
    // Only a definite auth rejection can retry this POST. Network or
    // ambiguous failures never create a second order automatically.
    let response = with_session(
        client.post(format!("{origin}{PAYMENT_PATH}/order")),
        session,
    )
    .json(
        &json!({ "group": selection.group, "expectedRevision": selection.expected_revision,
            "expectedFen": selection.expected_fen, "priceKind": selection.price_kind }),
    )
    .send()
    .await
    .map_err(|_| "PAYMENT_ORDER_UNCERTAIN".to_string())?;
    let body = payment_json(response, true).await?;
    validate_order(&body, selection, origin, base)
}

#[tauri::command]
pub async fn newapi_payment_checkout(
    selection: PaymentSelection,
) -> Result<PaymentCheckout, String> {
    let _guard = CHECKOUT_LOCK
        .try_lock()
        .map_err(|_| "PAYMENT_IN_PROGRESS".to_string())?;
    if selection.user_id <= 0
        || !GROUPS.contains(&selection.group.as_str())
        || !valid_fen(selection.expected_fen)
        || selection.expected_revision < 1
        || !["original", "promotion", "student"].contains(&selection.price_kind.as_str())
    {
        return Err("PAYMENT_INVALID_QUOTE".to_string());
    }
    let client = account_http_client_builder(Duration::from_secs(30))
        .build()
        .map_err(|_| "PAYMENT_UNAVAILABLE".to_string())?;
    let (fields, origin) = with_authenticated_session(&client, |client, base, session| {
        let selection = selection.clone();
        async move {
            let origin = payment_origin(&base)?;
            let fields = create_order(&client, &origin, &base, &session, &selection).await?;
            Ok((fields, origin))
        }
    })
    .await?;
    // Keep cashier submission outside the auth retry: failure here must never
    // repeat the order POST. Redirects are inspected, never followed by Rust.
    submit_order(&client, &origin, &fields).await
}

#[cfg(test)]
#[path = "../tests/newapi_payments.rs"]
mod tests;
