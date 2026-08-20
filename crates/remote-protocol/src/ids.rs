use serde::{Deserialize, Serialize};
use std::fmt;
use std::str::FromStr;
use uuid::Uuid;

macro_rules! uuid_id {
    ($name:ident, $description:literal) => {
        #[doc = $description]
        #[derive(
            Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize,
        )]
        #[serde(transparent)]
        pub struct $name(Uuid);

        impl $name {
            /// Creates a new random identifier.
            #[must_use]
            pub fn new() -> Self {
                Self(Uuid::new_v4())
            }

            /// Wraps a UUID received from a trusted local store.
            #[must_use]
            pub const fn from_uuid(value: Uuid) -> Self {
                Self(value)
            }

            /// Returns the underlying UUID for storage integrations.
            #[must_use]
            pub const fn as_uuid(self) -> Uuid {
                self.0
            }
        }

        impl Default for $name {
            fn default() -> Self {
                Self::new()
            }
        }

        impl fmt::Display for $name {
            fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
                self.0.fmt(formatter)
            }
        }

        impl FromStr for $name {
            type Err = uuid::Error;

            fn from_str(value: &str) -> Result<Self, Self::Err> {
                value.parse().map(Self)
            }
        }
    };
}

uuid_id!(
    DeviceId,
    "Stable identifier for a paired desktop or mobile device."
);
uuid_id!(
    PairingId,
    "Identifier for one short-lived pairing ceremony."
);
uuid_id!(
    SessionId,
    "Identifier for one authenticated remote-control session."
);
uuid_id!(
    RequestId,
    "Identifier used to correlate an idempotent control request and response."
);
uuid_id!(
    ComputeJobId,
    "Identifier for one durable local or remote compute job."
);
uuid_id!(
    MatchId,
    "Identifier for one brokered Image Assist match between two unpaired devices."
);
