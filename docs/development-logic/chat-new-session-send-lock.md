# Sending another new chat while a turn is running

The empty Chat home uses the shared `chat-home` ID. Its first submission creates
a persistent session with a distinct ID before starting asynchronous command,
attachment, and turn preparation.

Previously `Chat.send` acquired a lock for `chat-home`, materialized the session,
and held the home lock until the entire turn finished. Opening another new chat
returned to `chat-home`. Its composer was ready and idle, but submission exited
silently because the first turn still held that shared lock. Two existing chats
with different IDs were unaffected.

After materialization, submission acquires the actual session's lock and releases
the home lock before asynchronous preparation. The final cleanup releases that
same session ID and lock generation. This keeps new chats independent and lets
Stop invalidate the actual session's lock without stale cleanup releasing a
later request.

Regression coverage in `desktop/src/chat/tests/Chat.test.tsx` includes:

- First submission from home remains pending while a second new chat in the same
  project sends with another session ID. Completing the first leaves the second
  busy and keeps replies in their owning conversations.
- Two existing chats in the same project, with different pinned models, send
  concurrently. Completing one does not release the other's send protection;
  each saved reply stays with its session and project.
- A new home chat in First stays pending while the real store project-switch
  action selects an empty Second workspace. Second's home chat sends using a
  different model; both requests and saved replies retain their owning
  project/session IDs, and returning through the sidebar restores First alone.

Before the fix, the first regression failed with one backend send instead of
two while the second composer's `busy` was false and `ready` was true. The
existing-session regression already passed, which distinguishes this bug from
a project-level concurrency restriction. The backend's global concurrent-turn
limit remains five.

These tests simulate backend replies. They do not constitute a live-model or
packaged desktop verification. The running desktop executable is not updated by
the frontend source change or production frontend build.
