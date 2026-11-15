//! Test driver for tools/docx/run_acceptance.py; uses the production tool path.
use std::{
    io::{self, Read},
    path::PathBuf,
};
fn main() -> Result<(), Box<dyn std::error::Error>> {
    let root = PathBuf::from(std::env::args().nth(1).ok_or("workspace root required")?);
    let mut request = String::new();
    io::stdin().read_to_string(&mut request)?;
    let request: serde_json::Value = serde_json::from_str(&request)?;
    let context = runtime::ProjectExecutionContext::new(&root)
        .with_env("ARIS_WORKSPACE_ROOT", &root)
        .with_env("ARIS_SESSION_ID", "docx-acceptance");
    let result = runtime::with_project_execution_context(&context, || {
        tools::execute_tool(
            request["tool"].as_str().unwrap_or_default(),
            &request["input"],
        )
    });
    match result {
        Ok(output) => println!("{output}"),
        Err(error) => {
            eprintln!("{error}");
            std::process::exit(1);
        }
    }
    Ok(())
}
