# LlmReview as an independent child

Desktop Chat's `LlmReview` tool now uses a fresh controller-owned Reviewer
child by default. This lets a skill request an independent review of project
files without relying entirely on the Executor's description of those files.
It uses the configured Reviewer connection and model, including the existing
explicit model override rules. It never inherits the Executor's connection.

The automatic Chat Reviewer remains `/root/~reviewer`, retaining its own
conversation across revision rounds. Each tool review is a separate
`/root/~llm_review_<sequence>` child with an empty conversation. It receives
only the self-contained request through controller mail. Its final report is
returned as the tool result in the format requested by the skill; the formal
Chat verdict JSON schema does not apply. Later calls must restate their context.

Both review paths reuse `review_thread.rs`'s restricted tools and runtime:
`read_file`, `grep_search`, and `glob_search`. Paths are confined to the bound
project workspace; existing secret, binary, size and output limits still apply.
The Reviewer cannot edit, execute commands, browse, contact anyone, delegate,
or claim to have run tests. It may inspect saved test output as evidence.

The child has a 14-iteration, 10-minute budget. It watches the owning Chat
turn's cancellation flag and its own tree cancellation flag. It is closed on
success, failure, setup error and cancellation, releasing child capacity.
On the next review after a process restart, abandoned tool review children are
closed without replaying their original requests; their audit evidence remains.
Reserved controller children cannot be listed, addressed or influenced through
the Executor's collaboration tools. Agent task, mail, lifecycle and review
events record lineage and the configured model; wire events record the request,
actual tool calls and report when wire logging is enabled.

Compatibility routes remain explicit: `review_mode=oneshot` keeps the
single-request API path, ChatGPT web Reviewer keeps its browser path, and
execution without a bound Chat agent tree uses the shared single-request path.
These routes do not expose project read tools, so the caller must include the
material in its prompt. An API sub-agent failure is reported without silently
submitting another paid request or replacing independent review with Executor
judgement. Reviewers that cannot accept tool schemas can use `oneshot`.

Validation covers real file evidence passed back to the Reviewer, arbitrary
report formats, fresh contexts between calls, coexistence with the resident
Reviewer, cancellation, stale turns and child cleanup after errors. Tests use
scripted or local mock endpoints rather than a paid service.

Verified on Windows on 2026-10-28: the desktop backend's full library suite
passed (985 passed, 15 ignored), and `cargo test --workspace -- --test-threads=1`
passed. The workspace run used the installed Git Bash on its process PATH and
ran outside the execution sandbox so the Jupyter test processes could start.
