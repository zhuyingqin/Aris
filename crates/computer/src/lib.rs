//! Desktop observation for `SomniQ` computer use.
//!
//! R0 scope (see `docs/development-logic/computer-use-rollout-plan.md`): a
//! probe that answers "what can a text-only model see in a window, how long
//! does reading it take, and which background actions does it expose" on
//! real Windows apps. Nothing here is wired into the desktop app or offered
//! to a model yet; the only action path is limited to the R0 fixture window.
//!
//! - [`snapshot`]: platform-independent tree model, element numbering, and
//!   the text rendering a text-only model would receive.
//! - [`policy`]: app tiers as adjusted by the rollout plan.
//! - `platform::windows` (Windows only): window enumeration and UI
//!   Automation, with every `unsafe` call confined to one audited module.

pub mod image;
pub mod platform;
pub mod policy;
pub mod protocol;
pub mod snapshot;
