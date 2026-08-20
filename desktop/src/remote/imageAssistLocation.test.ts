// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearImageAssistLocation,
  requestImageAssistLocation,
  storedImageAssistLocation,
} from "./imageAssistLocation";

describe("image assist approximate location", () => {
  beforeEach(() => {
    clearImageAssistLocation();
  });

  it("discards precise coordinates before persisting or returning a location", async () => {
    const getCurrentPosition = vi.fn((success: PositionCallback) => success({
      coords: {
        latitude: 19.432608,
        longitude: -99.133209,
        accuracy: 4,
        altitude: null,
        altitudeAccuracy: null,
        heading: null,
        speed: null,
        toJSON: () => ({}),
      },
      timestamp: Date.now(),
      toJSON: () => ({}),
    }));
    Object.defineProperty(navigator, "geolocation", {
      configurable: true,
      value: { getCurrentPosition },
    });

    const location = await requestImageAssistLocation();

    expect(location.latitude).toBe(19.4);
    expect(location.longitude).toBe(-99.1);
    expect(storedImageAssistLocation()).toEqual(location);
    expect(window.localStorage.getItem("somniq.image-assist.approximate-location.v1"))
      .not.toContain("19.432608");
  });
});
