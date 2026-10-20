# Account allowance refresh

The account menu displays the gateway's confirmed subscription allowance (or
wallet allowance when no subscription exists). Consumption is never deducted
optimistically from local token counts.

Previously, App and Settings kept independent account state. Writing a new
snapshot to localStorage did not update the menu in the same window. Opening
the menu also used a 15-second throttle, and chat completion was discarded if
an older account request was already pending. Drawing completion and failed
chats with partial usage did not trigger a refresh. Non-authentication failures
were silent, leaving the cached amount looking current.

`useAccountRefresh` now owns the shell's account refresh:

- Opening the menu and explicit refresh bypass the background throttle.
- Chat completion, chat failure and completed drawing requests refresh the
  allowance. Completion events received during a request coalesce into a
  subsequent read, rather than sharing the older result indefinitely.
- The existing 60-second polling and throttled window-focus refresh remain.
- Account-cache subscribers synchronize Settings and the menu in this window;
  storage events synchronize snapshots received from other windows.
- Failed reads retain the last confirmed allowance and expose a retry action
  and a failure message. The refresh button shows the pending state. Keyboard
  navigation skips this button while it is disabled.
- Clearing the account advances its session revision. Late account reads and
  failures cannot restore a signed-out account or sign out the next account.
  Startup request coalescing is scoped to this revision. Unmounted views do
  not publish account responses.

Regression coverage exercises actual allowance rendering, immediate reopening,
overlapping reads and consumption, Settings synchronization, failed reads and
retry, drawings, polling, focus, logout, account replacement, other windows,
unmounting and keyboard access during refresh. This fix does not change the
gateway's settlement behavior; a successful response reflects the allowance
reported by the server at that moment.
