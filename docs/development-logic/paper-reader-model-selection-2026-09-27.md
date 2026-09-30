# Paper reader model selection

The paper reader exposes a generation model selector before generation and in the teaching reader toolbar. Options come from Somni Chat's existing model-options API. Selection applies to the paper generation request without changing global Chat settings. The selector is locked while preparation or generation is active.

The prepare request accepts an optional model; legacy callers retain the configured default. The backend resolves it through the shared Chat executor and its existing vision validation. Each saved run remains identified by document revision, model, executor configuration, language, and protocol. Changing models creates or retrieves that model's independent run, preserving previous results. A completed matching run is reused without another model call. Updates from another run cannot replace the selected run.

Verification covers model selection, completed-run reuse, stale-event isolation, legacy request deserialization, and independently persisted model runs. Frontend type checking is included. No release build or EXE packaging is required for this change. Live model generation remains a separate acceptance check.
