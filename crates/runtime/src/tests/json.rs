use super::{render_string, JsonValue};
use std::collections::BTreeMap;

#[test]
fn renders_and_parses_json_values() {
    let mut object = BTreeMap::new();
    object.insert("flag".to_string(), JsonValue::Bool(true));
    object.insert(
        "items".to_string(),
        JsonValue::Array(vec![
            JsonValue::Number(4),
            JsonValue::String("ok".to_string()),
        ]),
    );

    let rendered = JsonValue::Object(object).render();
    let parsed = JsonValue::parse(&rendered).expect("json should parse");

    assert_eq!(parsed.as_object().expect("object").len(), 2);
}

#[test]
fn escapes_control_characters() {
    assert_eq!(render_string("a\n\t\"b"), "\"a\\n\\t\\\"b\"");
}
