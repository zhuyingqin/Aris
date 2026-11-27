use super::*;

#[test]
fn reads_every_operation_in_camel_case() {
    let ping = parse_request(r#"{"id":1,"op":"ping"}"#).unwrap();
    assert_eq!(ping, Request { id: 1, op: Op::Ping });

    let snapshot =
        parse_request(r#"{"id":2,"op":"snapshot","hwnd":42,"filter":"all","maxChars":900,"ref":7}"#)
            .unwrap();
    assert_eq!(
        snapshot.op,
        Op::Snapshot {
            hwnd: 42,
            filter: Some(Filter::All),
            max_chars: Some(900),
            reference: Some(7),
        }
    );

    let shot = parse_request(
        r#"{"id":3,"op":"screenshot","hwnd":42,"maxLongEdge":800,"region":{"x":0,"y":500,"width":500,"height":500}}"#,
    )
    .unwrap();
    assert_eq!(
        shot.op,
        Op::Screenshot {
            hwnd: 42,
            max_long_edge: Some(800),
            region: Some(Region {
                x: 0,
                y: 500,
                width: 500,
                height: 500
            }),
        }
    );

    let find = parse_request(r#"{"id":4,"op":"find","hwnd":42,"query":"保存"}"#).unwrap();
    assert_eq!(
        find.op,
        Op::Find {
            hwnd: 42,
            query: "保存".into(),
            limit: None
        }
    );
}

#[test]
fn malformed_requests_keep_their_id_and_unknown_fields_are_refused() {
    assert_eq!(parse_request(r#"{"id":9,"op":"click","hwnd":1}"#).unwrap_err().0, 9);
    // An action smuggled into a read operation is not silently ignored.
    assert_eq!(
        parse_request(r#"{"id":5,"op":"snapshot","hwnd":1,"setValue":"x"}"#)
            .unwrap_err()
            .0,
        5
    );
    assert_eq!(parse_request("not json").unwrap_err().0, 0);
}

#[test]
fn responses_carry_either_a_result_or_an_error() {
    let ok = serde_json::to_value(Response::ok(1, serde_json::json!({"pong": true}))).unwrap();
    assert_eq!(ok, serde_json::json!({"id": 1, "ok": true, "result": {"pong": true}}));
    let error = serde_json::to_value(Response::error(2, "WINDOW_GONE", "gone")).unwrap();
    assert_eq!(
        error,
        serde_json::json!({"id": 2, "ok": false, "error": {"code": "WINDOW_GONE", "message": "gone"}})
    );
}
