use super::*;
use serde_json::json;

fn read(input: &str) -> QuestionInput {
    read_question_input(input).unwrap_or_else(|error| panic!("{error}\ninput: {input}"))
}

fn read_err(input: &str) -> String {
    read_question_input(input).expect_err("input should be rejected")
}

const FLAT: &str = r#"{"question":"Pick one","options":[{"label":"A"},{"label":"B"}]}"#;

#[test]
fn a_well_formed_question_reads_unchanged() {
    let read = read(FLAT);
    assert_eq!(
        read.question,
        json!({"question": "Pick one", "options": [{"label": "A"}, {"label": "B"}]})
    );
    assert!(read.unasked.is_empty());
}

#[test]
fn closers_of_a_wrapper_that_was_never_opened_are_dropped() {
    // The commonest failure: the flat object followed by the `]}` that would
    // close `{"questions": [`, or a lone extra `}`.
    for input in [
        format!("{FLAT}]}}"),
        format!("{FLAT}}}"),
        format!("{FLAT} ] }}\n"),
    ] {
        assert_eq!(read(&input).question, read(FLAT).question, "input: {input}");
    }
}

#[test]
fn a_stray_close_part_way_through_keeps_the_members_after_it() {
    // `...]}], "question": ...}`: the root closed after `options`, but the
    // question itself (or `multiSelect`) follows.
    let question_after = r#"{"header":"Next","options":[{"label":"A","description":"first"},{"label":"B"}]}], "question":"Which?"}"#;
    assert_eq!(
        read(question_after).question,
        json!({
            "question": "Which?",
            "header": "Next",
            "options": [{"label": "A", "description": "first"}, {"label": "B"}],
        })
    );

    let flag_after = r#"{"question":"Which?","options":[{"label":"A"}]}], "multiSelect": true}"#;
    assert_eq!(read(flag_after).question["multiSelect"], json!(true));
}

#[test]
fn brackets_and_escapes_inside_strings_are_left_alone() {
    let input = r#"{"question":"Keep \"]}\" and [x] literal?","options":[{"label":"{a}"},{"label":"b\\"}]}]}"#;
    let read = read(input);
    assert_eq!(
        read.question["question"],
        json!("Keep \"]}\" and [x] literal?")
    );
    assert_eq!(
        read.question["options"],
        json!([{"label": "{a}"}, {"label": "b\\"}])
    );
}

#[test]
fn the_questions_array_shape_is_unwrapped() {
    let wrapped = format!(r#"{{"questions":[{FLAT}]}}"#);
    let read = read(&wrapped);
    assert_eq!(read.question, read_question_input(FLAT).unwrap().question);
    assert!(read.unasked.is_empty());

    let bare_array = format!("[{FLAT}]");
    assert_eq!(
        read_question_input(&bare_array).unwrap().question["question"],
        json!("Pick one")
    );
}

#[test]
fn xml_style_item_lists_and_string_booleans_are_read() {
    let input = r#"{"questions":{"item":[
        {"header":"Model","multiSelect":"false","allowCustom":"true",
         "options":{"item":[{"label":"small","description":"fast"},{"label":"large"}]},
         "question":"Which model?"},
        {"header":"Size","options":{"item":[{"label":"1"},{"label":"5"}]},"question":"How many samples?"},
        {"options":{"item":[{"label":"yes"}]},"question":"Write a report?"}
    ]}}"#;
    let read = read(input);
    assert_eq!(
        read.question,
        json!({
            "question": "Which model?",
            "header": "Model",
            "options": [{"label": "small", "description": "fast"}, {"label": "large"}],
            "multiSelect": false,
            "allowCustom": true,
        })
    );
    assert_eq!(read.unasked, ["How many samples?", "Write a report?"]);
}

#[test]
fn back_to_back_objects_ask_the_first_and_report_the_rest() {
    let second = r#"{"question":"And then?","options":[{"label":"C"}]}"#;
    for input in [
        format!("{FLAT}{second}"),
        format!("{FLAT}\n{second}"),
        format!("{FLAT}, {second}"),
    ] {
        let read = read(&input);
        assert_eq!(
            read.question["question"],
            json!("Pick one"),
            "input: {input}"
        );
        assert_eq!(read.unasked, ["And then?"], "input: {input}");
    }
}

#[test]
fn bare_string_options_become_labels_and_unknown_keys_are_dropped() {
    let input = r#"{"question":"  Ship it?  ","options":["Yes"," ",{"label":"No","extra":1},{"description":"no label"}],"priority":"high","multiSelect":"maybe"}"#;
    assert_eq!(
        read(input).question,
        json!({"question": "Ship it?", "options": [{"label": "Yes"}, {"label": "No"}]})
    );
}

#[test]
fn input_without_a_recoverable_question_is_still_rejected() {
    assert!(read_err(r#"{"question":"Pick one"}"#).contains("`options`"));
    assert!(read_err(r#"{"question":"Pick one","options":[{"label":"  "}]}"#).contains("`label`"));
    assert!(read_err(r#"{"options":[{"label":"A"}]}"#).contains("`question`"));
    assert!(read_err(r#"{"questions":[]}"#).contains("`question`"));
    assert!(read_err(r#""Pick one""#).contains("an object"));
}

#[test]
fn unparseable_input_reports_the_original_position_and_the_expected_shape() {
    // Truncated mid-string: nothing is ever added, so this stays an error.
    let message = read_err(r#"{"question":"Pick one","options":[{"label":"A"#);
    assert!(message.contains("must be valid JSON"), "{message}");
    assert!(message.contains("line 1"), "{message}");
    assert!(message.contains("not an array of questions"), "{message}");

    // Trailing prose after the object is not a question either.
    assert!(read_err(&format!("{FLAT} thanks")).contains("must be valid JSON"));
}
