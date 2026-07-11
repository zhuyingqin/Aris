use super::{timeline_from_session, TimelineNodeKind};
use runtime::{ContentBlock, ConversationMessage, MessageRole, Session};
use serde_json::json;
use std::collections::BTreeSet;

#[test]
fn builds_timeline_nodes_for_turn_tool_call_and_file_diff() {
    let tool_output = json!({
        "filePath": "demo.txt",
        "structuredPatch": [
            {
                "oldStart": 1,
                "oldLines": 1,
                "newStart": 1,
                "newLines": 2,
                "lines": ["-old", "+new", "+more"]
            }
        ]
    })
    .to_string();
    let session = Session {
        version: 1,
        messages: vec![
            ConversationMessage::user_text("change the file"),
            ConversationMessage::assistant(vec![
                ContentBlock::Text {
                    text: "I will edit it.".to_string(),
                },
                ContentBlock::ToolUse {
                    id: "tool-1".to_string(),
                    name: "edit_file".to_string(),
                    input: json!({
                        "path": "demo.txt",
                        "old_string": "old",
                        "new_string": "new\nmore"
                    })
                    .to_string(),
                },
            ]),
            ConversationMessage {
                role: MessageRole::Tool,
                blocks: vec![ContentBlock::ToolResult {
                    tool_use_id: "tool-1".to_string(),
                    tool_name: "edit_file".to_string(),
                    output: tool_output,
                    is_error: false,
                }],
                usage: None,
            },
            ConversationMessage::assistant(vec![ContentBlock::Text {
                text: "Done.".to_string(),
            }]),
        ],
        compactions: Vec::new(),
    };

    let timeline = timeline_from_session("session-test", &session);
    let kinds = timeline
        .nodes
        .iter()
        .map(|node| node.kind.clone())
        .collect::<Vec<_>>();
    assert!(kinds.contains(&TimelineNodeKind::UserTurn));
    assert!(kinds.contains(&TimelineNodeKind::AssistantReply));
    assert!(kinds.contains(&TimelineNodeKind::ToolCall));
    assert!(kinds.contains(&TimelineNodeKind::ToolResult));
    assert!(kinds.contains(&TimelineNodeKind::FileDiff));

    let ids = timeline
        .nodes
        .iter()
        .map(|node| node.id.clone())
        .collect::<BTreeSet<_>>();
    assert_eq!(ids.len(), timeline.nodes.len());

    let diff_node = timeline
        .nodes
        .iter()
        .find(|node| node.kind == TimelineNodeKind::FileDiff)
        .expect("file diff node");
    assert_eq!(diff_node.file_paths, vec!["demo.txt".to_string()]);
    assert_eq!(diff_node.diff.as_ref().expect("diff").added_lines, 2);
    assert_eq!(diff_node.diff.as_ref().expect("diff").removed_lines, 1);
}

#[test]
fn records_child_edges_for_linear_timeline() {
    let session = Session {
        version: 1,
        messages: vec![
            ConversationMessage::user_text("hello"),
            ConversationMessage::assistant(vec![ContentBlock::Text {
                text: "hi".to_string(),
            }]),
        ],
        compactions: Vec::new(),
    };

    let timeline = timeline_from_session("session-test", &session);
    assert_eq!(timeline.branches[0].name, "main");
    assert_eq!(timeline.nodes[0].children.len(), 1);
    assert_eq!(
        timeline.nodes[0].children[0], timeline.nodes[1].id,
        "root should point to first message node"
    );
    assert_eq!(
        timeline.active_head_id.as_deref(),
        Some(timeline.nodes.last().expect("last node").id.as_str())
    );
}

#[test]
fn builds_file_diff_from_codex_style_changes() {
    let tool_output = json!({
        "changes": {
            "demo.txt": {
                "type": "update",
                "unified_diff": "--- demo.txt\n+++ demo.txt\n@@ -1 +1,2 @@\n-old\n+new\n+more"
            }
        }
    })
    .to_string();
    let session = Session {
        version: 1,
        messages: vec![
            ConversationMessage::user_text("change the file"),
            ConversationMessage {
                role: MessageRole::Tool,
                blocks: vec![ContentBlock::ToolResult {
                    tool_use_id: "tool-1".to_string(),
                    tool_name: "edit_file".to_string(),
                    output: tool_output,
                    is_error: false,
                }],
                usage: None,
            },
        ],
        compactions: Vec::new(),
    };

    let timeline = timeline_from_session("session-test", &session);
    let diff_node = timeline
        .nodes
        .iter()
        .find(|node| node.kind == TimelineNodeKind::FileDiff)
        .expect("file diff node");
    assert_eq!(diff_node.file_paths, vec!["demo.txt".to_string()]);
    assert_eq!(diff_node.diff.as_ref().expect("diff").added_lines, 2);
    assert_eq!(diff_node.diff.as_ref().expect("diff").removed_lines, 1);
}
