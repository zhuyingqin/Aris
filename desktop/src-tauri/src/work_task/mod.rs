//! Work tasks: a board of queued jobs, each executed by an agent in its own
//! git worktree, reviewed as a diff, and merged back on acceptance.
//!
//! Lifecycle: `todo → queued → preparing → running → review → merging → done`.
//!
//! Three things make this different from Chat and from the review workflow,
//! and each is why a piece of it exists:
//!
//! - **The user is not there.** A task runs after they queued it and moved on,
//!   so nothing in its path may block on a human. That rules out the desktop
//!   permission prompt, and [`permission`] replaces it with an immediate
//!   decision.
//! - **It has to be able to write.** Which is why the decision above can be
//!   "yes": [`worktree`] gives every task a throwaway checkout on a throwaway
//!   branch, so an autonomous write reaches nothing the user has not accepted.
//! - **It can be cancelled mid-flight.** Every launch claims a fresh `run_seq`
//!   and every settle is conditioned on it, so a cancel racing a completing
//!   turn settles nothing instead of resurrecting a card the user just dropped.

pub(crate) mod commands;
pub(crate) mod engine;
pub(crate) mod model;
pub(crate) mod permission;
pub(crate) mod store;
pub(crate) mod worktree;
