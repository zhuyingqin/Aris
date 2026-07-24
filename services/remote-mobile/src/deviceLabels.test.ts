import { describe, expect, it } from "vitest";

import { desktopDisplayLabel, desktopShortCode } from "./deviceLabels";
import type { DeviceDescriptor } from "./types";

const first: DeviceDescriptor = {
  device_id: "11111111-1111-4111-8111-111111abcdef",
  kind: "desktop",
  display_name: "SomniQ Desktop",
  signing_public_key: "first-signing-key",
  key_agreement_public_key: "first-agreement-key",
};

const second: DeviceDescriptor = {
  ...first,
  device_id: "22222222-2222-4222-8222-222222123456",
  signing_public_key: "second-signing-key",
  key_agreement_public_key: "second-agreement-key",
};

describe("desktop device labels", () => {
  it("keeps a unique desktop name unchanged", () => {
    expect(desktopDisplayLabel(first, [first])).toBe("SomniQ Desktop");
  });

  it("adds stable short codes when paired desktops have the same name", () => {
    expect(desktopDisplayLabel(first, [first, second])).toBe("SomniQ Desktop · ABCDEF");
    expect(desktopDisplayLabel(second, [first, second])).toBe("SomniQ Desktop · 123456");
  });

  it("normalizes UUID separators and casing for the short code", () => {
    expect(desktopShortCode("AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEfedcba")).toBe("FEDCBA");
  });
});
