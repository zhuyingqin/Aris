use super::*;

#[test]
fn system_desktop_names_are_safe_for_signed_device_descriptors() {
    assert_eq!(
        normalized_system_desktop_name("  LAB-WORKSTATION  "),
        Some("LAB-WORKSTATION".to_string())
    );
    assert_eq!(normalized_system_desktop_name(""), None);
    assert_eq!(normalized_system_desktop_name("bad\nname"), None);
    assert_eq!(
        normalized_system_desktop_name(&"x".repeat(MAX_DEFAULT_REMOTE_DESKTOP_NAME_BYTES + 1)),
        None
    );
}

fn temp_state(name: &str) -> (RemoteAgentState, std::path::PathBuf) {
    let root = std::env::temp_dir().join(format!(
        "somniq-remote-{name}-{}",
        remote_protocol::DeviceId::new()
    ));
    let state = RemoteAgentState::at_path(root.join("agent.json"));
    (state, root)
}

fn grant(state: &RemoteAgentState, id: &str, scopes: &[RemoteScope]) {
    with_store(state, |store| {
        store.enabled = true;
        store.devices.push(RemoteDevice {
            id: id.to_string(),
            label: format!("device-{id}"),
            fingerprint: "f".repeat(32),
            scopes: scopes.iter().copied().collect(),
            paired_at: 1,
            last_seen_at: None,
            revoked_at: None,
            descriptor: None,
            session_id: None,
        });
        Ok(())
    })
    .expect("grant test device");
}

#[test]
fn gateway_urls_require_tls_except_local_development() {
    assert_eq!(
        normalize_gateway_url("https://remote.example.test/").expect("https accepted"),
        "https://remote.example.test"
    );
    assert!(normalize_gateway_url("http://remote.example.test").is_err());
    assert!(normalize_gateway_url("file:///tmp/agent").is_err());
    assert!(normalize_gateway_url("http://localhost.evil.test").is_err());
    assert!(normalize_gateway_url("http://localhost@evil.test").is_err());
    assert!(normalize_gateway_url("http://127.0.0.1.evil.test").is_err());
    assert!(normalize_gateway_url("http://127.0.0.1:8787").is_ok());
    assert!(normalize_gateway_url("http://[::1]:8787").is_ok());
}

#[test]
fn gateway_pairing_expiry_replaces_the_provisional_qr_expiry() {
    let signing = DeviceSigningKey::generate();
    let agreement = KeyAgreementSecret::generate();
    let mut invitation = PairingInvitation::new(
        DeviceDescriptor::new(
            DeviceId::new(),
            DeviceKind::Desktop,
            "SomniQ desktop",
            signing.public_key(),
            agreement.public_key(),
        )
        .expect("valid desktop descriptor"),
        "https://gateway.example.test",
        1_300,
    )
    .expect("valid provisional invitation");
    let response = GatewayStartPairingResponse {
        pairing_id: invitation.pairing_id.to_string(),
        // This deliberately differs from the desktop's proposed expiry: the
        // gateway is the authority after it has accepted the pairing.
        expires_at_unix_ms: 1_100,
        desktop_token: None,
    };

    apply_gateway_pairing_expiry(&mut invitation, &response)
        .expect("future gateway expiry is accepted");

    assert_eq!(invitation.expires_at_unix_ms, 1_100);
    let deep_link = pairing_qr_deep_link(&invitation).expect("QR deep link");
    let encoded = deep_link.split_once("#p=").expect("QR has fragment").1;
    let payload =
        base64::Engine::decode(&base64::engine::general_purpose::URL_SAFE_NO_PAD, encoded)
            .expect("QR payload is base64url");
    let qr_invitation: PairingInvitation =
        serde_json::from_slice(&payload).expect("QR payload restores invitation");
    assert_eq!(
        qr_invitation.expires_at_unix_ms,
        response.expires_at_unix_ms
    );
}

#[test]
fn gateway_pairing_expiry_rejects_mismatched_or_invalid_responses() {
    let signing = DeviceSigningKey::generate();
    let agreement = KeyAgreementSecret::generate();
    let mut invitation = PairingInvitation::new(
        DeviceDescriptor::new(
            DeviceId::new(),
            DeviceKind::Desktop,
            "SomniQ desktop",
            signing.public_key(),
            agreement.public_key(),
        )
        .expect("valid desktop descriptor"),
        "https://gateway.example.test",
        1_300,
    )
    .expect("valid provisional invitation");
    let provisional_expiry = invitation.expires_at_unix_ms;

    let mismatched = GatewayStartPairingResponse {
        pairing_id: PairingId::new().to_string(),
        expires_at_unix_ms: 1_900,
        desktop_token: None,
    };
    assert!(apply_gateway_pairing_expiry(&mut invitation, &mismatched)
        .expect_err("mismatched response is rejected")
        .contains("mismatched pairing identifier"));
    assert_eq!(invitation.expires_at_unix_ms, provisional_expiry);

    let invalid_expiry = GatewayStartPairingResponse {
        pairing_id: invitation.pairing_id.to_string(),
        expires_at_unix_ms: 0,
        desktop_token: None,
    };
    assert!(
        apply_gateway_pairing_expiry(&mut invitation, &invalid_expiry)
            .expect_err("invalid response is rejected")
            .contains("invalid pairing expiry")
    );
    assert_eq!(invitation.expires_at_unix_ms, provisional_expiry);
}

#[test]
fn direct_p2p_uses_explicit_stun_only_and_preserves_tcp_relay_fallback() {
    assert_eq!(
        normalize_ice_servers(vec![
            "stun:stun.example.test:3478".to_string(),
            "STUN:stun.example.test:3478".to_string(),
            "stuns:stun.example.test:5349".to_string(),
        ])
        .expect("valid STUN configuration"),
        vec![
            "stun:stun.example.test:3478".to_string(),
            "stuns:stun.example.test:5349".to_string(),
        ]
    );
    assert!(normalize_ice_servers(vec!["turn:relay.example.test:3478".to_string()]).is_err());
    assert!(normalize_ice_servers(vec!["stun:user@relay.example.test:3478".to_string()]).is_err());
    assert!(normalize_ice_servers(vec!["https://relay.example.test".to_string()]).is_err());
}

#[test]
fn current_desktop_advertises_optional_workspace_commands() {
    assert_eq!(
        REMOTE_WORKSPACE_CAPABILITIES,
        &[
            remote_protocol::RemoteCapability::SetActiveProject,
            remote_protocol::RemoteCapability::CreateChatSession,
            remote_protocol::RemoteCapability::GetChatModelOptions,
            remote_protocol::RemoteCapability::SetChatSessionModel,
            remote_protocol::RemoteCapability::StopChatMessage,
            remote_protocol::RemoteCapability::RichChatProgress,
            remote_protocol::RemoteCapability::ChatEventSync,
            remote_protocol::RemoteCapability::AnswerChatQuestion,
        ]
    );
}

#[test]
fn pairing_qr_uses_a_same_origin_deep_link_with_a_fragment_payload() {
    let signing = DeviceSigningKey::generate();
    let agreement = KeyAgreementSecret::generate();
    let desktop = DeviceDescriptor::new(
        DeviceId::new(),
        DeviceKind::Desktop,
        "SomniQ desktop",
        signing.public_key(),
        agreement.public_key(),
    )
    .expect("valid desktop descriptor");
    let invitation = PairingInvitation::new(desktop, "https://gateway.example.test", i64::MAX)
        .expect("valid invitation");

    let deep_link = pairing_qr_deep_link(&invitation).expect("deep link");
    let (route, fragment) = deep_link
        .split_once('#')
        .expect("deep link carries fragment payload");
    assert_eq!(route, "https://gateway.example.test/pair");
    let encoded = fragment
        .strip_prefix("p=")
        .expect("fragment has invitation parameter");
    let decoded =
        base64::Engine::decode(&base64::engine::general_purpose::URL_SAFE_NO_PAD, encoded)
            .expect("fragment is base64url");
    let restored: PairingInvitation =
        serde_json::from_slice(&decoded).expect("fragment restores invitation");
    assert_eq!(restored, invitation);
}

#[test]
fn transport_session_history_never_evicts_an_existing_pairing_context() {
    let mut store = RemoteStore::default();
    let first_phone = DeviceId::new().to_string();
    for index in 0..MAX_USED_TRANSPORT_SESSIONS_PER_DEVICE {
        record_transport_session(&mut store, &first_phone, &format!("first-{index}"))
            .expect("reserve bounded session history");
    }

    assert!(
        record_transport_session(&mut store, &first_phone, "one-too-many").is_err(),
        "a full device history fails closed rather than evicting a session ID"
    );
    assert!(
        record_transport_session(&mut store, &first_phone, "first-0").is_err(),
        "the oldest session ID remains permanently non-reusable"
    );

    let second_phone = DeviceId::new().to_string();
    record_transport_session(&mut store, &second_phone, "second-phone-first")
        .expect("one phone cannot exhaust another phone's replay history");
    assert_eq!(
        store
            .used_transport_sessions
            .iter()
            .filter(|used| used.device_id == first_phone)
            .count(),
        MAX_USED_TRANSPORT_SESSIONS_PER_DEVICE
    );
}

#[test]
fn full_legacy_transport_history_forces_repair_before_p2() {
    let phone = DeviceId::new().to_string();
    let mut store = RemoteStore {
        version: 1,
        enabled: true,
        ..RemoteStore::default()
    };
    store.devices.push(RemoteDevice {
        id: phone.clone(),
        label: "legacy phone".to_string(),
        fingerprint: "f".repeat(32),
        scopes: [RemoteScope::ReadProjectState].into_iter().collect(),
        paired_at: 1,
        last_seen_at: None,
        revoked_at: None,
        descriptor: None,
        session_id: None,
    });
    store.used_transport_sessions = (0..LEGACY_EVICTING_TRANSPORT_HISTORY_CAP)
        .map(|index| UsedTransportSession {
            session_id: format!("legacy-{index}"),
            device_id: phone.clone(),
            used_at: index as u64,
        })
        .collect();

    migrate_store(&mut store);

    assert_eq!(store.version, STORE_VERSION);
    assert!(store.devices[0].revoked_at.is_some());
    assert_eq!(store.pending_gateway_revocations, vec![phone]);
}

#[test]
fn paired_device_scopes_are_checked_and_revocation_is_immediate() {
    let (state, root) = temp_state("authorization");
    let phone = DeviceId::new().to_string();
    grant(&state, &phone, &[RemoteScope::ReadProjectState]);

    let scopes = authenticated_device_scopes(&state, &phone).expect("paired phone is allowed");
    assert!(scopes.contains(RemoteScope::ReadProjectState));
    assert!(!scopes.contains(RemoteScope::SendChatMessages));

    with_store(&state, |store| {
        let device = store
            .devices
            .iter_mut()
            .find(|device| device.id == phone)
            .expect("device exists");
        device.revoked_at = Some(42);
        Ok(())
    })
    .expect("revoke test device");
    assert!(authenticated_device_scopes(&state, &phone).is_err());
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn gateway_revocation_drops_live_p2p_and_relay_state() {
    let (state, root) = temp_state("gateway-revocation");
    let phone = DeviceId::new();
    let phone_id = phone.to_string();
    let desktop = DeviceId::new();
    grant(&state, &phone_id, &[RemoteScope::ReadProjectState]);

    let session_id = SessionId::new();
    let session_id_text = session_id.to_string();
    let route = SessionRoute::new(session_id.clone(), phone.clone(), desktop);
    let wire = Arc::new(
        RemoteWireSession::new(
            phone_id.clone(),
            TransportKind::P2p,
            SessionKey::from_bytes([7_u8; 32]),
            route,
        )
        .expect("matching P2P session route"),
    );
    state
        .active_p2p_sessions
        .lock()
        .expect("P2P state lock")
        .insert(
            session_id_text.clone(),
            Arc::new(ReservedP2pSession {
                device_id: phone_id.clone(),
                session_id,
                wire,
                established: AtomicBool::new(true),
                received_ice_candidates: AtomicUsize::new(0),
            }),
        );
    state
        .active_relay_sessions
        .lock()
        .expect("relay state lock")
        .insert(format!("{phone_id}:{}", SessionId::new()));

    let events = mark_gateway_revoked_device(&state, &phone_id);

    assert_eq!(
        events
            .iter()
            .map(|event| (&event.device_id, &event.session_id))
            .collect::<Vec<_>>(),
        vec![(&phone_id, &session_id_text)]
    );
    assert!(state
        .active_p2p_sessions
        .lock()
        .expect("P2P state lock")
        .is_empty());
    assert!(state
        .active_relay_sessions
        .lock()
        .expect("relay state lock")
        .is_empty());
    assert!(authenticated_device_scopes(&state, &phone_id).is_err());
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn p2_pairing_allows_chat_execution_but_not_direct_run_control() {
    assert!(is_supported_remote_scope(RemoteScope::ReadProjectState));
    assert!(is_supported_remote_scope(RemoteScope::ReadTaskTimeline));
    assert!(is_supported_remote_scope(
        RemoteScope::ReadReviewConclusions
    ));
    assert!(is_supported_remote_scope(RemoteScope::SendChatMessages));
    assert!(!is_supported_remote_scope(RemoteScope::StopRuns));
}

#[test]
fn pairing_approval_grants_every_supported_requested_scope() {
    let requested = DeviceScopes::from([
        RemoteScope::ReadProjectState,
        RemoteScope::SendChatMessages,
        RemoteScope::StopRuns,
        RemoteScope::ReadReviewConclusions,
    ]);

    let granted = supported_requested_scopes(&requested);
    assert!(granted.contains(RemoteScope::ReadProjectState));
    assert!(granted.contains(RemoteScope::SendChatMessages));
    assert!(granted.contains(RemoteScope::ReadReviewConclusions));
    assert!(!granted.contains(RemoteScope::StopRuns));
    assert!(granted.is_subset_of(&requested));
}

#[test]
fn stale_gateway_credential_recovery_accepts_only_the_known_restart_outcome() {
    assert!(gateway_credential_was_rejected(
        "remote gateway request failed (401 Unauthorized): unauthorized"
    ));
    assert!(gateway_credential_was_rejected(
        "remote gateway request failed (404 Not Found): resource not found"
    ));
    assert!(!gateway_credential_was_rejected(
        "remote gateway request failed (404 Not Found): route missing"
    ));
    assert!(!gateway_credential_was_rejected(
        "remote gateway request failed (500 Internal Server Error): resource not found"
    ));
}

#[test]
fn remote_chat_idempotency_replays_only_the_same_completed_request() {
    let (state, root) = temp_state("remote-chat-idempotency");
    let first = reserve_remote_chat_idempotency(
        &state,
        "phone-a",
        "project-a",
        "chat-a",
        "retry-key",
        "digest-a",
    )
    .expect("first request reserves a turn");
    let message_id = match first {
        RemoteChatReservation::New { message_id, .. } => message_id,
        RemoteChatReservation::Completed { .. } => panic!("first request must be new"),
    };
    assert!(matches!(
        reserve_remote_chat_idempotency(
            &state,
            "phone-a",
            "project-a",
            "chat-a",
            "retry-key",
            "digest-a",
        ),
        Err(ControlError::TemporarilyUnavailable { .. })
    ));
    assert_eq!(
        complete_remote_chat_idempotency(
            &state,
            "phone-a",
            "project-a",
            "retry-key",
            "digest-a",
            "assistant reply".to_string(),
        )
        .expect("completed result is cached in memory"),
        RemoteChatTerminalDecision::Completed,
    );
    match reserve_remote_chat_idempotency(
        &state,
        "phone-a",
        "project-a",
        "chat-a",
        "retry-key",
        "digest-a",
    )
    .expect("same retry reads the completed result")
    {
        RemoteChatReservation::Completed {
            message_id: replayed_id,
            text,
        } => {
            assert_eq!(replayed_id, message_id);
            assert_eq!(text, "assistant reply");
        }
        RemoteChatReservation::New { .. } => panic!("completed retry must not run again"),
    }
    assert!(matches!(
        reserve_remote_chat_idempotency(
            &state,
            "phone-a",
            "project-a",
            "chat-a",
            "retry-key",
            "digest-b",
        ),
        Err(ControlError::Conflict)
    ));
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn remote_chat_cancellation_is_bound_to_its_device_project_and_session() {
    let (state, root) = temp_state("remote-chat-cancellation");
    let reservation = reserve_remote_chat_idempotency(
        &state,
        "phone-a",
        "project-a",
        "chat-a",
        "retry-key",
        "digest-a",
    )
    .expect("first request reserves a turn");
    let (message_id, cancelled) = match reservation {
        RemoteChatReservation::New {
            message_id,
            cancelled,
        } => (message_id, cancelled),
        RemoteChatReservation::Completed { .. } => panic!("first request must be new"),
    };

    assert!(matches!(
        request_remote_chat_cancellation(&state, "phone-b", "project-a", "chat-a", &message_id,),
        Err(ControlError::NotFound)
    ));
    assert!(matches!(
        request_remote_chat_cancellation(&state, "phone-a", "project-a", "chat-b", &message_id,),
        Err(ControlError::NotFound)
    ));
    assert!(!cancelled.load(Ordering::SeqCst));
    assert!(request_remote_chat_cancellation(
        &state,
        "phone-a",
        "project-a",
        "chat-a",
        &message_id,
    )
    .expect("owner can cancel active turn"));
    assert!(cancelled.load(Ordering::SeqCst));
    assert_eq!(
        complete_remote_chat_idempotency(
            &state,
            "phone-a",
            "project-a",
            "retry-key",
            "digest-a",
            "late completion".to_string(),
        )
        .expect("terminal arbitration succeeds"),
        RemoteChatTerminalDecision::Cancelled,
    );
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn project_pause_cancels_every_incomplete_paired_chat_turn() {
    let (state, root) = temp_state("project-pause-chat-cancellation");
    let first = reserve_remote_chat_idempotency(
        &state,
        "phone-a",
        "project-a",
        "chat-a",
        "retry-a",
        "digest-a",
    )
    .expect("first request reserves a turn");
    let second = reserve_remote_chat_idempotency(
        &state,
        "phone-b",
        "project-b",
        "chat-b",
        "retry-b",
        "digest-b",
    )
    .expect("second request reserves a turn");
    let first_cancelled = match first {
        RemoteChatReservation::New { cancelled, .. } => cancelled,
        RemoteChatReservation::Completed { .. } => panic!("first request must be new"),
    };
    let second_cancelled = match second {
        RemoteChatReservation::New { cancelled, .. } => cancelled,
        RemoteChatReservation::Completed { .. } => panic!("second request must be new"),
    };

    cancel_all_active_chat_messages(&state);

    assert!(first_cancelled.load(Ordering::SeqCst));
    assert!(second_cancelled.load(Ordering::SeqCst));
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn remote_chat_response_is_bounded_on_utf8_boundaries() {
    let text = "中".repeat(MAX_REMOTE_CHAT_RESPONSE_BYTES);
    let truncated = truncate_remote_chat_response(text);
    assert!(truncated.contains("SomniQ truncated"));
    assert!(truncated.is_char_boundary(truncated.len()));
    assert!(truncated.len() <= MAX_REMOTE_CHAT_RESPONSE_BYTES);
    assert!(truncated.len() < MAX_RELAY_FRAME_BYTES);
}

#[test]
fn remote_chat_delta_streams_long_answers_in_ordered_safe_fragments() {
    let input = "abc".repeat(MAX_REMOTE_CHAT_DELTA_BYTES);
    let mut delivered = 0;
    let fragments = bounded_remote_chat_delta(input.clone(), &mut delivered);

    assert!(fragments.len() > 1);
    assert_eq!(fragments.concat(), input);
    assert_eq!(delivered, input.len());
    assert!(fragments
        .iter()
        .all(|fragment| fragment.len() <= MAX_REMOTE_CHAT_DELTA_BYTES));
}

#[test]
fn remote_chat_delta_has_a_generous_total_stream_guard() {
    let mut delivered = MAX_REMOTE_CHAT_STREAM_BYTES.saturating_sub(2);
    let fragments = bounded_remote_chat_delta("abcd".to_string(), &mut delivered);

    assert_eq!(fragments.concat(), "ab");
    assert_eq!(delivered, MAX_REMOTE_CHAT_STREAM_BYTES);
}

#[test]
fn remote_chat_delta_accepts_only_the_target_session() {
    let payload = serde_json::json!({
        "sessionId": "chat-live",
        "text": "partial reply",
    })
    .to_string();

    assert_eq!(
        remote_chat_delta_text(&payload, "chat-live"),
        Some("partial reply".to_string())
    );
    assert_eq!(remote_chat_delta_text(&payload, "another-chat"), None);
    assert_eq!(
        remote_chat_delta_text(r#"{"sessionId":"chat-live","text":""}"#, "chat-live"),
        None
    );
}

#[test]
fn remote_chat_render_event_keeps_sanitized_tool_progress_for_the_target_session() {
    let payload = serde_json::json!({
        "sessionId": "chat-live",
        "kind": "tool_progress",
        "payload": {
            "sessionId": "chat-live",
            "id": "tool-1",
            "name": "shell_command",
            "elapsedMs": 250,
            "timeoutMs": 30_000,
            "pid": 42,
            "stdoutTail": "checking",
            "stderrTail": null,
            "nearTimeout": false,
            "message": "running"
        }
    })
    .to_string();

    assert!(matches!(
        remote_chat_render_event(&payload, "chat-live"),
        Some(ChatMessageEvent::ToolProgress {
            tool_use_id: Some(tool_use_id),
            name,
            progress: ChatToolProgress {
                elapsed_ms: 250,
                pid: Some(42),
                ..
            },
        }) if tool_use_id == "tool-1" && name == "shell_command"
    ));
    assert_eq!(remote_chat_render_event(&payload, "another-chat"), None);
}

#[test]
fn desktop_chat_event_snapshot_reconciles_the_latest_visible_turn() {
    let entry = |seq: u64, kind: &str, payload: Value| crate::chat_events::ChatEventLogEntry {
        version: 1,
        seq,
        ts: seq,
        session_id: "chat-live".to_string(),
        kind: kind.to_string(),
        payload,
    };
    let mut entries = vec![
        entry(1, "done", serde_json::json!({ "sessionId": "chat-live" })),
        entry(
            2,
            "user_message",
            serde_json::json!({
                "message": { "blocks": [{ "type": "text", "text": "desktop question" }] }
            }),
        ),
        entry(
            3,
            "assistant_thinking_delta",
            serde_json::json!({ "sessionId": "chat-live", "thinking": "checking" }),
        ),
        // Permission controls remain desktop-only but still advance the cursor.
        entry(
            4,
            "approval_request",
            serde_json::json!({ "sessionId": "chat-live", "input": "private" }),
        ),
    ];

    let (events, next_seq) = remote_chat_event_batch(&entries, "chat-live", None, 200);
    assert_eq!(next_seq, 4);
    assert_eq!(
        events,
        vec![
            ChatSessionEvent::UserMessage {
                seq: 2,
                text: "desktop question".to_string(),
            },
            ChatSessionEvent::Assistant {
                seq: 3,
                event: ChatMessageEvent::ThinkingDelta {
                    delta: "checking".to_string(),
                },
            },
        ]
    );

    entries.push(entry(
        5,
        "done",
        serde_json::json!({ "sessionId": "chat-live", "text": "desktop answer" }),
    ));
    let (idle_events, idle_cursor) = remote_chat_event_batch(&entries, "chat-live", None, 200);
    assert_eq!(
        idle_events,
        vec![
            ChatSessionEvent::UserMessage {
                seq: 2,
                text: "desktop question".to_string(),
            },
            ChatSessionEvent::Assistant {
                seq: 3,
                event: ChatMessageEvent::ThinkingDelta {
                    delta: "checking".to_string(),
                },
            },
            ChatSessionEvent::Done {
                seq: 5,
                text: "desktop answer".to_string(),
            },
        ]
    );
    assert_eq!(idle_cursor, 5);

    entries.push(entry(
        6,
        "reset",
        serde_json::json!({ "sessionId": "chat-live" }),
    ));
    let (reset_events, reset_cursor) = remote_chat_event_batch(&entries, "chat-live", None, 200);
    assert!(reset_events.is_empty());
    assert_eq!(reset_cursor, 6);
}

#[test]
fn desktop_chat_event_batches_stop_before_the_encrypted_frame_budget() {
    let entry = |seq: u64, kind: &str, payload: Value| crate::chat_events::ChatEventLogEntry {
        version: 1,
        seq,
        ts: seq,
        session_id: "chat-live".to_string(),
        kind: kind.to_string(),
        payload,
    };
    let mut entries = vec![entry(
        1,
        "user_message",
        serde_json::json!({
            "message": { "blocks": [{ "type": "text", "text": "desktop question" }] }
        }),
    )];
    for seq in 2..=5 {
        entries.push(entry(
            seq,
            "assistant_delta",
            serde_json::json!({
                "sessionId": "chat-live",
                "text": "x".repeat(60 * 1024),
            }),
        ));
    }

    let (events, next_seq) = remote_chat_event_batch(&entries, "chat-live", None, 200);
    let serialized_bytes = events
        .iter()
        .map(|event| serde_json::to_vec(event).expect("event serializes").len())
        .sum::<usize>();

    assert_eq!(events.len(), 3);
    assert_eq!(next_seq, 3);
    assert!(serialized_bytes <= MAX_REMOTE_CHAT_EVENT_BATCH_BYTES);

    let (remaining, remaining_cursor) =
        remote_chat_event_batch(&entries, "chat-live", Some(next_seq), 200);
    assert_eq!(remaining.len(), 2);
    assert_eq!(remaining_cursor, 5);
}

#[test]
fn desktop_chat_event_batches_do_not_spend_the_visible_limit_on_session_persistence() {
    let entry = |seq: u64, kind: &str, payload: Value| crate::chat_events::ChatEventLogEntry {
        version: 1,
        seq,
        ts: seq,
        session_id: "chat-live".to_string(),
        kind: kind.to_string(),
        payload,
    };
    let entries = vec![
        entry(
            1,
            "user_message",
            serde_json::json!({
                "message": { "blocks": [{ "type": "text", "text": "desktop question" }] }
            }),
        ),
        entry(
            2,
            "session_reset",
            serde_json::json!({ "reason": "initial" }),
        ),
        entry(3, "session_message", serde_json::json!({ "index": 0 })),
        entry(
            4,
            "session_checkpoint",
            serde_json::json!({ "messageCount": 1 }),
        ),
        entry(5, "usage", serde_json::json!({ "promptTokens": 1 })),
        entry(
            6,
            "done",
            serde_json::json!({ "sessionId": "chat-live", "text": "desktop answer" }),
        ),
    ];

    let (events, next_seq) = remote_chat_event_batch(&entries, "chat-live", Some(1), 1);

    assert_eq!(next_seq, 6);
    assert_eq!(
        events,
        vec![ChatSessionEvent::Done {
            seq: 6,
            text: "desktop answer".to_string(),
        }]
    );
}

#[test]
fn desktop_chat_event_preview_bounds_large_tool_results_and_reports_review_activity() {
    let event = bounded_remote_chat_session_message_event(ChatMessageEvent::ToolResult {
        tool_use_id: Some("fetch-1".to_string()),
        name: "WebFetch".to_string(),
        output: "x".repeat(MAX_REMOTE_CHAT_TOOL_OUTPUT_BYTES + 100),
        is_error: false,
    });
    assert!(matches!(
        event,
        ChatMessageEvent::ToolResult { output, .. }
            if output.len() <= MAX_REMOTE_CHAT_TOOL_OUTPUT_BYTES
                && output.ends_with(REMOTE_CHAT_TOOL_OUTPUT_TRUNCATION_NOTICE)
    ));

    assert_eq!(
        remote_chat_review_status(&serde_json::json!({
            "phase": "reviewing",
            "attempt": 2,
            "maxRevisions": 2,
        })),
        Some("Independent review in progress (round 2/2).".to_string())
    );
}

#[test]
fn remote_chat_rich_events_use_separate_bounded_text_and_detail_budgets() {
    let mut text_bytes = MAX_REMOTE_CHAT_STREAM_BYTES - 2;
    let mut rich_bytes = MAX_REMOTE_CHAT_RICH_STREAM_BYTES - 2;
    let text = bounded_remote_chat_render_events(
        ChatMessageEvent::TextDelta {
            delta: "abcd".to_string(),
        },
        &mut text_bytes,
        &mut rich_bytes,
    );
    assert_eq!(
        text,
        vec![ChatMessageEvent::TextDelta {
            delta: "ab".to_string()
        }]
    );
    assert_eq!(rich_bytes, MAX_REMOTE_CHAT_RICH_STREAM_BYTES - 2);

    let thinking = bounded_remote_chat_render_events(
        ChatMessageEvent::ThinkingDelta {
            delta: "abcd".to_string(),
        },
        &mut text_bytes,
        &mut rich_bytes,
    );
    assert_eq!(
        thinking,
        vec![ChatMessageEvent::ThinkingDelta {
            delta: "ab".to_string()
        }]
    );
    assert_eq!(rich_bytes, MAX_REMOTE_CHAT_RICH_STREAM_BYTES);
}

#[test]
fn fresh_approval_can_replace_a_revoked_phone_but_not_an_active_one() {
    let phone = DeviceId::new().to_string();
    let mut store = RemoteStore {
        enabled: true,
        ..RemoteStore::default()
    };
    store.devices.push(RemoteDevice {
        id: phone.clone(),
        label: "old phone".to_string(),
        fingerprint: "a".repeat(32),
        scopes: [RemoteScope::ReadProjectState].into_iter().collect(),
        paired_at: 1,
        last_seen_at: None,
        revoked_at: Some(2),
        descriptor: None,
        session_id: Some(SessionId::new().to_string()),
    });
    store.pending_gateway_revocations.push(phone.clone());
    let refreshed = RemoteDevice {
        id: phone,
        label: "repaired phone".to_string(),
        fingerprint: "b".repeat(32),
        scopes: [RemoteScope::ReadTaskTimeline].into_iter().collect(),
        paired_at: 3,
        last_seen_at: None,
        revoked_at: None,
        descriptor: None,
        session_id: Some(SessionId::new().to_string()),
    };

    record_approved_device(&mut store, refreshed.clone()).expect("fresh approval replaces revoke");
    assert_eq!(store.devices.len(), 1);
    assert_eq!(store.devices[0].label, "repaired phone");
    assert!(store.devices[0].revoked_at.is_none());
    assert!(store.pending_gateway_revocations.is_empty());
    assert!(record_approved_device(&mut store, refreshed).is_err());
}

#[test]
fn removing_a_pairing_drops_the_local_device_and_queues_gateway_revocation() {
    let phone = DeviceId::new().to_string();
    let mut store = RemoteStore::default();
    store.devices.push(RemoteDevice {
        id: phone.clone(),
        label: "phone".to_string(),
        fingerprint: "f".repeat(32),
        scopes: [RemoteScope::ReadProjectState].into_iter().collect(),
        paired_at: 1,
        last_seen_at: None,
        revoked_at: None,
        descriptor: None,
        session_id: None,
    });

    remove_paired_device(&mut store, &phone).expect("pairing is removed");

    assert!(store.devices.is_empty());
    assert_eq!(store.pending_gateway_revocations, vec![phone.clone()]);
    assert!(remove_paired_device(&mut store, &phone).is_err());
}

#[test]
fn phone_inventory_and_status_exclude_paired_compute_nodes() {
    let paired_endpoint = |kind: DeviceKind, label: &str, scopes: &[RemoteScope]| {
        let signing = DeviceSigningKey::generate();
        let agreement = KeyAgreementSecret::generate();
        let descriptor = DeviceDescriptor::new(
            DeviceId::new(),
            kind,
            label,
            signing.public_key(),
            agreement.public_key(),
        )
        .expect("valid paired endpoint");
        RemoteDevice {
            id: descriptor.device_id.to_string(),
            label: label.to_string(),
            fingerprint: "f".repeat(32),
            scopes: scopes.iter().copied().collect(),
            paired_at: 1,
            last_seen_at: None,
            revoked_at: None,
            descriptor: Some(descriptor),
            session_id: Some(SessionId::new().to_string()),
        }
    };
    let mut store = RemoteStore {
        enabled: true,
        ..RemoteStore::default()
    };
    store.devices.push(paired_endpoint(
        DeviceKind::Mobile,
        "Trusted phone",
        &[RemoteScope::ReadProjectState],
    ));
    store.devices.push(paired_endpoint(
        DeviceKind::ComputeNode,
        "Research Mac",
        &[RemoteScope::ComputeJobs, RemoteScope::ReadProjectState],
    ));

    let phones = mobile_device_views(&store);
    let status = status_from_store(&store);

    assert_eq!(phones.len(), 1);
    assert_eq!(phones[0].label, "Trusted phone");
    assert_eq!(phones[0].kind, DeviceKind::Mobile);
    assert_eq!(status.paired_device_count, 1);
    assert_eq!(status.active_device_count, 1);
}

#[test]
fn renderer_device_view_omits_protocol_pairing_metadata() {
    let device = RemoteDevice {
        id: DeviceId::new().to_string(),
        label: "phone".to_string(),
        fingerprint: "f".repeat(32),
        scopes: [RemoteScope::ReadProjectState].into_iter().collect(),
        paired_at: 1,
        last_seen_at: None,
        revoked_at: None,
        descriptor: None,
        session_id: Some(SessionId::new().to_string()),
    };
    let value = serde_json::to_value(RemoteDeviceView::from(&device)).expect("serialize view");
    assert_eq!(value.get("kind"), Some(&serde_json::json!("mobile")));
    assert!(value.get("descriptor").is_none());
    assert!(value.get("sessionId").is_none());
}

#[test]
fn audit_entries_are_metadata_only() {
    let (state, root) = temp_state("audit");
    let entry = RemoteAuditEntry {
        timestamp: 5,
        device_id: DeviceId::new().to_string(),
        request_id: "request-1".to_string(),
        action: "send_chat".to_string(),
        transport: "tcp_relay".to_string(),
        project_id: Some("project-a".to_string()),
        outcome: "allowed".to_string(),
        error_code: None,
    };
    append_audit(&state, &entry).expect("write audit");
    let raw = std::fs::read_to_string(&state.audit_path).expect("read audit");
    assert!(raw.contains("send_chat"));
    assert!(!raw.contains("do not persist this prompt"));
    assert_eq!(
        read_audit(&state.audit_path, 10)
            .expect("read entries")
            .len(),
        1
    );
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn encrypted_wire_session_binds_the_grant_to_the_route_sender() {
    let desktop = remote_protocol::DeviceId::new();
    let phone = remote_protocol::DeviceId::new();
    let incoming =
        remote_protocol::SessionRoute::new(remote_protocol::SessionId::new(), phone, desktop);
    let key = remote_protocol::SessionKey::from_bytes([9_u8; 32]);
    let session = RemoteWireSession::new(
        phone.to_string(),
        remote_protocol::TransportKind::P2p,
        key.clone(),
        incoming.clone(),
    )
    .expect("matching route identity should build a session");
    assert_eq!(session.outgoing_route, incoming.reversed());
    assert!(RemoteWireSession::new(
        "another-device".to_string(),
        remote_protocol::TransportKind::TcpRelay,
        key,
        incoming,
    )
    .is_err());
}

/// Builds two ends of one encrypted session so a frame sealed by the peer can
/// be opened by the local side under the real replay and route rules.
fn wire_session_pair(
    local: remote_protocol::DeviceId,
    peer: remote_protocol::DeviceId,
) -> (RemoteWireSession, RemoteWireSession) {
    let session = remote_protocol::SessionId::new();
    let key = remote_protocol::SessionKey::from_bytes([7_u8; 32]);
    let local_side = RemoteWireSession::new(
        peer.to_string(),
        remote_protocol::TransportKind::P2p,
        key.clone(),
        remote_protocol::SessionRoute::new(session, peer, local),
    )
    .expect("local wire session");
    let peer_side = RemoteWireSession::new(
        local.to_string(),
        remote_protocol::TransportKind::P2p,
        key,
        remote_protocol::SessionRoute::new(session, local, peer),
    )
    .expect("peer wire session");
    (local_side, peer_side)
}

#[test]
fn a_brokered_session_routes_to_image_assist_before_any_general_path() {
    let (state, _root) = temp_state("image-assist-route");
    let peer = remote_protocol::DeviceId::new().to_string();
    let session_id = remote_protocol::SessionId::new().to_string();

    // Without a registered brokered session an unknown peer falls through to
    // the Agent control path, which is precisely the hazard being closed.
    assert_eq!(
        classify_p2p_frame(&state, &peer, &session_id).expect("classify"),
        P2pFrameRoute::Control
    );

    register_image_assist_session(
        &state,
        &session_id,
        ImageAssistSession {
            device_id: peer.clone(),
            match_id: remote_protocol::RequestId::new().to_string(),
            peer: brokered_descriptor(DeviceId::from_str(&peer).expect("device id"), "a stranger"),
        },
    )
    .expect("register brokered session");

    assert_eq!(
        classify_p2p_frame(&state, &peer, &session_id).expect("classify"),
        P2pFrameRoute::ImageAssist
    );

    remove_image_assist_session(&state, &session_id);
    assert_eq!(
        classify_p2p_frame(&state, &peer, &session_id).expect("classify"),
        P2pFrameRoute::Control
    );
}

#[test]
fn a_brokered_session_id_cannot_be_replayed_by_another_device() {
    let (state, _root) = temp_state("image-assist-device-bind");
    let peer = remote_protocol::DeviceId::new().to_string();
    let impostor = remote_protocol::DeviceId::new().to_string();
    let session_id = remote_protocol::SessionId::new().to_string();
    register_image_assist_session(
        &state,
        &session_id,
        ImageAssistSession {
            device_id: peer.clone(),
            match_id: remote_protocol::RequestId::new().to_string(),
            peer: brokered_descriptor(DeviceId::from_str(&peer).expect("device id"), "a stranger"),
        },
    )
    .expect("register brokered session");

    assert!(classify_p2p_frame(&state, &impostor, &session_id).is_err());
}

#[test]
fn a_paired_compute_device_cannot_be_brokered_as_an_image_assist_peer() {
    let (state, _root) = temp_state("image-assist-no-compute-overlap");
    let peer = remote_protocol::DeviceId::new().to_string();
    grant(&state, &peer, &[RemoteScope::ComputeJobs]);
    with_store(&state, |store| {
        let device = store
            .devices
            .iter_mut()
            .find(|device| device.id == peer)
            .expect("granted device");
        device.descriptor = Some(
            DeviceDescriptor::new(
                DeviceId::from_str(&peer).expect("device id"),
                DeviceKind::ComputeNode,
                "paired compute node",
                DeviceSigningKey::generate().public_key(),
                KeyAgreementSecret::generate().public_key(),
            )
            .expect("valid compute descriptor"),
        );
        Ok(())
    })
    .expect("attach compute descriptor");

    assert!(register_image_assist_session(
        &state,
        &remote_protocol::SessionId::new().to_string(),
        ImageAssistSession {
            device_id: peer.clone(),
            match_id: remote_protocol::RequestId::new().to_string(),
            peer: brokered_descriptor(DeviceId::from_str(&peer).expect("device id"), "a stranger",),
        },
    )
    .is_err());
}

#[test]
fn an_image_assist_session_cannot_decode_a_compute_frame() {
    let local = remote_protocol::DeviceId::new();
    let peer = remote_protocol::DeviceId::new();
    let (local_side, peer_side) = wire_session_pair(local, peer);

    let compute = peer_side
        .seal_compute(&remote_protocol::ComputeWireMessage::Cancel {
            job_id: remote_protocol::ComputeJobId::new(),
        })
        .expect("peer seals a compute frame");

    // The brokered decoder is the only one an Image Assist session ever uses,
    // so a compute payload from a stranger cannot become a value the compute
    // dispatcher accepts.
    assert!(local_side.open_image_assist(&compute).is_err());
}

#[test]
fn an_image_assist_session_decodes_its_own_frames() {
    let local = remote_protocol::DeviceId::new();
    let peer = remote_protocol::DeviceId::new();
    let (local_side, peer_side) = wire_session_pair(local, peer);

    let request_id = remote_protocol::RequestId::new();
    let sealed = peer_side
        .seal_image_assist(&remote_protocol::ImageAssistWireMessage::Request {
            request_id,
            prompt: "a wind turbine at dusk".to_string(),
            aspect_ratio: Some("16:9".to_string()),
        })
        .expect("peer seals a brokered frame");

    match local_side
        .open_image_assist(&sealed)
        .expect("brokered frame opens")
    {
        remote_protocol::ImageAssistWireMessage::Request { request_id: id, .. } => {
            assert_eq!(id, request_id);
        }
        other => panic!("unexpected brokered frame: {other:?}"),
    }
}

#[test]
fn a_match_transcript_travels_on_the_brokered_session() {
    // The transcript is the first frame on every Image Assist channel, so it
    // must survive the same sealed transport as the request it precedes.
    let local = remote_protocol::DeviceId::new();
    let peer = remote_protocol::DeviceId::new();
    let (local_side, peer_side) = wire_session_pair(local, peer);

    let signing = DeviceSigningKey::generate();
    let helper = DeviceDescriptor::new(
        peer,
        DeviceKind::Desktop,
        "helper workstation",
        signing.public_key(),
        KeyAgreementSecret::generate().public_key(),
    )
    .expect("valid helper descriptor");
    let transcript = remote_protocol::ImageAssistTranscript {
        protocol_version: remote_protocol::CURRENT_PROTOCOL_VERSION,
        match_id: remote_protocol::MatchId::new(),
        requester: brokered_descriptor(local, "requester laptop"),
        helper: helper.clone(),
        offerer: peer,
        session_id: remote_protocol::SessionId::new(),
        ice_servers: vec!["stun:stun.example.test:3478".to_string()],
        expires_at_unix_ms: 1_800_000_000_000,
        request_digest: [7_u8; 32],
    };
    let proof = transcript.sign(&signing).expect("helper signs");

    let sealed = peer_side
        .seal_image_assist(&remote_protocol::ImageAssistWireMessage::Transcript {
            transcript: Box::new(transcript.clone()),
            proof: proof.clone(),
        })
        .expect("peer seals its transcript");

    match local_side
        .open_image_assist(&sealed)
        .expect("transcript opens")
    {
        remote_protocol::ImageAssistWireMessage::Transcript {
            transcript: received,
            proof: received_proof,
        } => {
            assert_eq!(*received, transcript);
            assert!(received.verify(peer, &received_proof).is_ok());
        }
        other => panic!("unexpected brokered frame: {other:?}"),
    }
}

#[test]
fn an_oversized_brokered_prompt_is_rejected_at_the_decoder() {
    let local = remote_protocol::DeviceId::new();
    let peer = remote_protocol::DeviceId::new();
    let (local_side, peer_side) = wire_session_pair(local, peer);

    let sealed = peer_side
        .seal_image_assist(&remote_protocol::ImageAssistWireMessage::Request {
            request_id: remote_protocol::RequestId::new(),
            prompt: "字".repeat(3_000),
            aspect_ratio: None,
        })
        .expect("peer seals an oversized frame");

    assert!(local_side.open_image_assist(&sealed).is_err());
}

fn brokered_descriptor(device_id: DeviceId, name: &str) -> DeviceDescriptor {
    DeviceDescriptor::new(
        device_id,
        DeviceKind::Desktop,
        name,
        DeviceSigningKey::generate().public_key(),
        KeyAgreementSecret::generate().public_key(),
    )
    .expect("valid brokered descriptor")
}

#[test]
fn a_brokered_registration_writes_nothing_to_the_paired_device_store() {
    let (state, _root) = temp_state("image-assist-no-persistence");
    let peer = remote_protocol::DeviceId::new();
    let session_id = remote_protocol::SessionId::new().to_string();

    register_image_assist_session(
        &state,
        &session_id,
        ImageAssistSession {
            device_id: peer.to_string(),
            match_id: remote_protocol::RequestId::new().to_string(),
            peer: brokered_descriptor(peer, "a stranger"),
        },
    )
    .expect("brokered session registers");

    // The stranger is routable, but it is not a paired device and never
    // becomes one.
    assert_eq!(
        classify_p2p_frame(&state, &peer.to_string(), &session_id).expect("classify"),
        P2pFrameRoute::ImageAssist
    );
    with_store(&state, |store| {
        assert!(
            store.devices.is_empty(),
            "a brokered peer must never enter the paired device store"
        );
        assert!(store.pending_pairings.is_empty());
        Ok(())
    })
    .expect("inspect store");
}

#[test]
fn a_brokered_descriptor_must_match_its_device_identity() {
    let (state, _root) = temp_state("image-assist-descriptor-bind");
    let claimed = remote_protocol::DeviceId::new();
    let actual = remote_protocol::DeviceId::new();

    assert!(register_image_assist_session(
        &state,
        &remote_protocol::SessionId::new().to_string(),
        ImageAssistSession {
            device_id: claimed.to_string(),
            match_id: remote_protocol::RequestId::new().to_string(),
            peer: brokered_descriptor(actual, "mismatched"),
        },
    )
    .is_err());
}

#[test]
fn an_already_paired_device_is_refused_as_a_brokered_peer() {
    let (state, _root) = temp_state("image-assist-paired-refused");
    let peer = remote_protocol::DeviceId::new();
    grant(&state, &peer.to_string(), &[RemoteScope::SendChatMessages]);

    // The guard runs before any keyring or identity work, so a paired device
    // can never be re-introduced as a stranger.
    let result = reserve_image_assist_p2p_session(
        &state,
        &remote_protocol::RequestId::new().to_string(),
        brokered_descriptor(peer, "already paired"),
        remote_protocol::SessionId::new(),
    );
    let Err(error) = result else {
        panic!("a paired device must be refused as a brokered peer");
    };
    assert!(error.contains("paired"), "unexpected error: {error}");
}

#[test]
fn releasing_a_brokered_session_forgets_both_registrations() {
    let (state, _root) = temp_state("image-assist-release");
    let peer = remote_protocol::DeviceId::new();
    let session_id = remote_protocol::SessionId::new().to_string();
    register_image_assist_session(
        &state,
        &session_id,
        ImageAssistSession {
            device_id: peer.to_string(),
            match_id: remote_protocol::RequestId::new().to_string(),
            peer: brokered_descriptor(peer, "a stranger"),
        },
    )
    .expect("register");

    release_image_assist_p2p_session(&state, &session_id);

    assert_eq!(
        classify_p2p_frame(&state, &peer.to_string(), &session_id).expect("classify"),
        P2pFrameRoute::Control,
        "a released brokered session must no longer be routable as Image Assist"
    );
}
