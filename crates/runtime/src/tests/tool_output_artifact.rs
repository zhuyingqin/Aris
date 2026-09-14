use super::*;

#[test]
fn large_output_is_persisted_and_projected_as_a_retrievable_reference() {
    let directory = tempfile::tempdir().expect("temporary project");
    let context = crate::ProjectExecutionContext::new(directory.path());
    let output = format!("begin\n{}\nend", "evidence\n".repeat(8_000));

    let artifact = crate::with_project_execution_context(&context, || {
        ensure_tool_output_artifact(
            "call-1",
            "read_file",
            &output,
            &output,
            TOOL_OUTPUT_ARTIFACT_THRESHOLD_CHARS,
        )
        .expect("large output artifact")
    });
    let projected = project_tool_output(
        output.clone(),
        &artifact,
        TOOL_OUTPUT_ARTIFACT_THRESHOLD_CHARS,
    );
    let value: Value = serde_json::from_str(&projected).expect("reference envelope");

    assert_eq!(
        fs::read_to_string(&artifact.path).expect("full output"),
        output
    );
    assert_eq!(value["status"], "referenced");
    assert_eq!(value["persistedOutputPath"], artifact.path);
    assert_eq!(
        value["sha256"].as_str(),
        artifact.sha256.as_deref()
    );
    assert!(value["preview"].as_str().unwrap().contains("begin"));
    assert!(value["preview"].as_str().unwrap().contains("end"));
    assert!(projected.chars().count() < TOOL_OUTPUT_ARTIFACT_THRESHOLD_CHARS);

    let low_budget = project_tool_output(
        output,
        &artifact,
        MIN_TOOL_OUTPUT_ARTIFACT_THRESHOLD_CHARS,
    );
    let low_budget: Value = serde_json::from_str(&low_budget).expect("low-budget envelope");
    assert!(
        low_budget["preview"]
            .as_str()
            .unwrap()
            .chars()
            .count()
            <= MIN_TOOL_OUTPUT_ARTIFACT_THRESHOLD_CHARS
    );
}

#[test]
fn small_output_stays_inline_and_creates_no_artifact() {
    let directory = tempfile::tempdir().expect("temporary project");
    let context = crate::ProjectExecutionContext::new(directory.path());
    let artifact = crate::with_project_execution_context(&context, || {
        ensure_tool_output_artifact(
            "call-1",
            "read_file",
            "small",
            "small",
            TOOL_OUTPUT_ARTIFACT_THRESHOLD_CHARS,
        )
    });

    assert!(artifact.is_none());
    assert!(!directory.path().join(".somniq/tmp/tool-output").exists());
}

#[test]
fn an_existing_project_local_artifact_is_reused_but_an_external_path_is_not() {
    let directory = tempfile::tempdir().expect("temporary project");
    let context = crate::ProjectExecutionContext::new(directory.path());
    let root = directory.path().join(".somniq/tmp/tool-output");
    fs::create_dir_all(&root).expect("artifact root");
    let existing = root.join("existing.txt");
    let pristine = "evidence".repeat(8_000);
    fs::write(&existing, &pristine).expect("existing artifact");
    let rendered = serde_json::json!({
        "preview": "short",
        "persistedOutputPath": existing,
        "persistedOutputSize": pristine.len()
    })
    .to_string();

    let reused = crate::with_project_execution_context(&context, || {
        ensure_tool_output_artifact(
            "call-1",
            "read_file",
            &pristine,
            &rendered,
            TOOL_OUTPUT_ARTIFACT_THRESHOLD_CHARS,
        )
        .expect("reused artifact")
    });
    assert!(reused.path.ends_with("existing.txt"));
    assert!(reused.sha256.is_some());

    let outside = directory.path().join("outside.txt");
    fs::write(&outside, &pristine).expect("outside file");
    let untrusted = serde_json::json!({ "persistedOutputPath": outside }).to_string();
    let replaced = crate::with_project_execution_context(&context, || {
        ensure_tool_output_artifact(
            "call-2",
            "read_file",
            &pristine,
            &untrusted,
            TOOL_OUTPUT_ARTIFACT_THRESHOLD_CHARS,
        )
        .expect("safe replacement artifact")
    });
    assert!(Path::new(&replaced.path).starts_with(root.canonicalize().unwrap()));
    assert_ne!(Path::new(&replaced.path), outside.as_path());
}
