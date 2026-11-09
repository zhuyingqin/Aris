use super::*;
use std::{
    io::{Read, Write},
    net::TcpListener,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    thread,
};

fn offers() -> Value {
    json!(GROUPS
        .iter()
        .enumerate()
        .map(|(index, group)| json!({
            "group": group, "planId": index + 8, "priceFen": 1900, "totalAmount": 30_000_000,
            "originalFen": 2900, "promotionFen": 1900, "studentFen": 1500,
            "priceKind": "promotion", "revision": 2,
        }))
        .collect::<Vec<_>>())
}

fn selection() -> PaymentSelection {
    PaymentSelection {
        user_id: 17,
        group: "go".into(),
        expected_fen: 1900,
        expected_revision: 2,
        price_kind: "promotion".into(),
    }
}

fn session() -> NewApiSession {
    NewApiSession {
        user_id: 17,
        user_token: Some("account-access-sentinel".into()),
        access_expires_at: None,
        refresh_session: None,
    }
}

fn order(origin: &str) -> Value {
    json!({ "message": "success", "url": format!("{origin}{PAYMENT_PATH}/submit.php"), "data": {
        "pid": "somniq", "type": "alipay", "out_trade_no": "SUBUSR17NOAbcd121792000000",
        "money": "19.00", "name": "SUB:Go", "sign": "0123456789abcdef0123456789abcdef", "sign_type": "MD5",
        "notify_url": "https://account.example/api/subscription/epay/notify",
        "return_url": "https://account.example/api/subscription/epay/return",
    } })
}

#[test]
fn offers_require_a_complete_consistent_account_quote() {
    assert_eq!(validate_offers(&offers()).unwrap().len(), 3);
    for (field, value) in [
        ("priceFen", json!(100)),
        ("revision", json!(0)),
        ("totalAmount", json!(5001)),
        ("studentFen", json!(3000)),
        ("planId", json!(0)),
        ("group", json!("other")),
    ] {
        let mut data = offers();
        data[0][field] = value;
        assert!(validate_offers(&data).is_err(), "invalid {field}");
    }
    let mut data = offers();
    data[0]["priceKind"] = json!("student");
    data[0]["priceFen"] = json!(1500);
    assert!(validate_offers(&data).is_ok());
    data[0] = data[1].clone();
    assert!(validate_offers(&data).is_err(), "duplicate groups");
}

#[test]
fn orders_bind_the_account_amount_and_callback_hosts() {
    let origin = "https://shop.example";
    let body = order(origin);
    assert!(validate_order(&body, &selection(), origin, "https://account.example").is_ok());
    for (field, value) in [
        ("out_trade_no", "SUBUSR18NOAbcd121792000000"),
        ("money", "19.001"),
        ("money", "19."),
        ("money", "019.00"),
        ("money", "29.00"),
        ("type", "wxpay"),
        ("sign", ""),
        ("notify_url", "https://evil.example/notify"),
        ("return_url", "https://evil.example/return"),
        ("out_trade_no", "SUBUSR17NO中中ab17920000"),
    ] {
        let mut changed = body.clone();
        changed["data"][field] = json!(value);
        assert!(
            validate_order(&changed, &selection(), origin, "https://account.example").is_err(),
            "invalid {field}"
        );
    }
    let mut changed = body;
    changed["url"] = json!("https://evil.example/v1/payments/alipay/submit.php");
    assert!(validate_order(&changed, &selection(), origin, "https://account.example").is_err());
}

#[test]
fn cashier_requires_the_alipay_desktop_gateway() {
    assert!(validate_cashier(
        "https://openapi.alipay.com/gateway.do?method=alipay.trade.page.pay&sign=test"
    )
    .is_ok());
    for url in [
        "http://openapi.alipay.com/gateway.do?method=alipay.trade.page.pay",
        "https://openapi.alipay.com.evil.example/gateway.do?method=alipay.trade.page.pay",
        "https://attacker@openapi.alipay.com/gateway.do?method=alipay.trade.page.pay",
        "https://openapi.alipay.com:444/gateway.do?method=alipay.trade.page.pay",
        "https://openapi.alipay.com/gateway.do?method=alipay.trade.wap.pay",
        "https://openapi.alipay.com/gateway.do?method=alipay.trade.page.pay&method=alipay.trade.wap.pay",
        "https://openapi.alipay.com/other?method=alipay.trade.page.pay",
        "javascript:alert(1)",
    ] {
        assert!(validate_cashier(url).is_err(), "invalid {url}");
    }
}

#[test]
fn payment_service_is_bound_to_its_configured_account_issuer() {
    let config: Value = serde_json::from_str(MANAGED_NEWAPI_CONFIG).unwrap();
    assert_eq!(
        payment_origin(config["baseUrl"].as_str().unwrap()).unwrap(),
        config["paymentOrigin"].as_str().unwrap()
    );
    assert!(payment_origin("http://127.0.0.1:3000").is_err());
    assert!(payment_origin("https://another-account.example").is_err());
}

struct Gateway {
    base: String,
    requests: Arc<Mutex<Vec<String>>>,
    stop: Arc<AtomicBool>,
    worker: Option<thread::JoinHandle<()>>,
}

impl Gateway {
    fn new(respond: impl Fn(&str, &str) -> (u16, String, String) + Send + 'static) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let origin = base.clone();
        let requests = Arc::new(Mutex::new(Vec::new()));
        let log = requests.clone();
        let stop = Arc::new(AtomicBool::new(false));
        let stopped = stop.clone();
        let worker = thread::spawn(move || {
            while !stopped.load(Ordering::Relaxed) {
                let Ok((mut stream, _)) = listener.accept() else {
                    thread::sleep(Duration::from_millis(2));
                    continue;
                };
                stream.set_nonblocking(false).unwrap();
                stream
                    .set_read_timeout(Some(Duration::from_secs(3)))
                    .unwrap();
                let mut bytes = Vec::new();
                let mut buffer = [0; 4096];
                loop {
                    let count = stream.read(&mut buffer).unwrap();
                    if count == 0 {
                        break;
                    }
                    bytes.extend_from_slice(&buffer[..count]);
                    let text = String::from_utf8_lossy(&bytes);
                    if let Some((headers, body)) = text.split_once("\r\n\r\n") {
                        let length = headers
                            .lines()
                            .find_map(|line| {
                                line.to_lowercase()
                                    .strip_prefix("content-length:")
                                    .and_then(|value| value.trim().parse::<usize>().ok())
                            })
                            .unwrap_or(0);
                        if body.len() >= length {
                            break;
                        }
                    }
                }
                let request = String::from_utf8(bytes).unwrap();
                log.lock().unwrap().push(request.clone());
                let (status, headers, body) = respond(&request, &origin);
                let response = format!("HTTP/1.1 {status} Test\r\nContent-Type: application/json\r\nContent-Length: {}\r\n{headers}Connection: close\r\n\r\n{body}", body.len());
                stream.write_all(response.as_bytes()).unwrap();
            }
        });
        Self {
            base,
            requests,
            stop,
            worker: Some(worker),
        }
    }
}

impl Drop for Gateway {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        let result = self.worker.take().unwrap().join();
        if !thread::panicking() {
            result.unwrap();
        }
    }
}

fn status(enabled: bool) -> String {
    json!({ "service": "somniq-alipay", "mode": "one_time", "purchaseEnabled": enabled, "pagePayEnabled": enabled }).to_string()
}

fn client() -> reqwest::Client {
    account_http_client_builder(Duration::from_secs(5))
        .no_proxy()
        .build()
        .unwrap()
}

#[tokio::test]
async fn reads_personalized_quote_and_rejects_another_accounts_quote() {
    for user_id in [17, 18] {
        let gateway =
            Gateway::new(move |request, _| {
                if request.starts_with("GET /v1/payments/alipay/status ") {
                    assert!(!request.to_lowercase().contains("authorization:"));
                    (200, String::new(), status(true))
                } else {
                    assert!(request.starts_with("GET /v1/payments/alipay/quote "));
                    assert!(request
                        .to_lowercase()
                        .contains("authorization: bearer account-access-sentinel"));
                    assert!(request.to_lowercase().contains("new-api-user: 17"));
                    (200, String::new(), json!({ "success": true, "data": {
                    "userId": user_id, "eligibilityStatus": "unavailable", "prices": offers(),
                }}).to_string())
                }
            });
        let result = read_catalog(&client(), &gateway.base, &session()).await;
        if user_id == 17 {
            let catalog = result.unwrap();
            assert!(
                catalog.purchase_enabled
                    && catalog.page_pay_enabled
                    && catalog.student_check_unavailable
            );
        } else {
            assert_eq!(result.err().unwrap(), "PAYMENT_ACCOUNT_CHANGED");
        }
    }
}

#[tokio::test]
async fn checkout_uses_one_order_post_and_sends_no_account_credentials_to_the_cashier() {
    let gateway = Gateway::new(|request, origin| {
        if request.starts_with("GET /v1/payments/alipay/status ") {
            return (200, String::new(), status(true));
        }
        if request.starts_with("POST /v1/payments/alipay/order ") {
            assert!(request
                .to_lowercase()
                .contains("authorization: bearer account-access-sentinel"));
            let body: Value =
                serde_json::from_str(request.split_once("\r\n\r\n").unwrap().1).unwrap();
            assert_eq!(
                body,
                json!({ "group": "go", "expectedFen": 1900, "expectedRevision": 2, "priceKind": "promotion" })
            );
            return (200, String::new(), order(origin).to_string());
        }
        assert!(request.starts_with("POST /v1/payments/alipay/submit.php "));
        let headers = request.to_lowercase();
        assert!(!headers.contains("authorization:") && !headers.contains("cookie:"));
        assert!(
            headers.contains(&format!("origin: {origin}"))
                && headers.contains("sec-ch-ua-mobile: ?0")
        );
        (303, "Location: https://openapi.alipay.com/gateway.do?method=alipay.trade.page.pay&sign=test\r\n".into(), String::new())
    });
    let client = client();
    let fields = create_order(
        &client,
        &gateway.base,
        "https://account.example",
        &session(),
        &selection(),
    )
    .await
    .unwrap();
    let result = submit_order(&client, &gateway.base, &fields).await.unwrap();
    assert_eq!(result.trade_no, "SUBUSR17NOAbcd121792000000");
    let requests = gateway.requests.lock().unwrap();
    assert_eq!(requests.len(), 3, "never follows the cashier redirect");
}

#[tokio::test]
async fn stopped_payments_and_changed_accounts_cannot_create_an_order() {
    let gateway = Gateway::new(|request, _| {
        assert!(request.starts_with("GET /v1/payments/alipay/status "));
        (200, String::new(), status(false))
    });
    let client = client();
    assert_eq!(
        create_order(
            &client,
            &gateway.base,
            "https://account.example",
            &session(),
            &selection()
        )
        .await
        .err()
        .unwrap(),
        "PAYMENT_UNAVAILABLE"
    );
    let mut changed = selection();
    changed.user_id = 18;
    assert_eq!(
        create_order(
            &client,
            &gateway.base,
            "https://account.example",
            &session(),
            &changed
        )
        .await
        .err()
        .unwrap(),
        "PAYMENT_ACCOUNT_CHANGED"
    );
    assert_eq!(gateway.requests.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn stale_prices_and_ambiguous_failures_never_retry_an_order() {
    for (http_status, body, expected) in [
        (
            409,
            json!({ "success": false, "message": "stale_price" }).to_string(),
            "PAYMENT_STALE_PRICE",
        ),
        (
            403,
            json!({ "success": false, "message": "student_required" }).to_string(),
            "PAYMENT_STUDENT_REQUIRED",
        ),
        (
            401,
            json!({ "success": false, "message": "auth_required" }).to_string(),
            "AUTH_UNAUTHORIZED",
        ),
        (
            503,
            "upstream disconnected".to_string(),
            "PAYMENT_ORDER_UNCERTAIN",
        ),
    ] {
        let gateway = Gateway::new(move |request, _| {
            if request.starts_with("GET /v1/payments/alipay/status ") {
                return (200, String::new(), status(true));
            }
            (http_status, String::new(), body.clone())
        });
        let failure = create_order(
            &client(),
            &gateway.base,
            "https://account.example",
            &session(),
            &selection(),
        )
        .await
        .err()
        .unwrap();
        assert_eq!(failure, expected);
        assert_eq!(gateway.requests.lock().unwrap().len(), 2);
    }
}
