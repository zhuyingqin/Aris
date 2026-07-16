import { describe, expect, it } from "vitest";

import { ForegroundResumeCoordinator } from "./foregroundResume";

const connectedAndPaired = {
  documentHidden: false,
  paired: true,
  connectable: true,
};

describe("ForegroundResumeCoordinator", () => {
  it("requests one recovery after a paired PWA returns from the background", () => {
    const coordinator = new ForegroundResumeCoordinator();

    coordinator.markBackgrounded();

    expect(coordinator.requestResume(connectedAndPaired)).toBe(true);
    expect(coordinator.requestResume(connectedAndPaired)).toBe(false);

    coordinator.completeResume({
      documentHidden: false,
      connected: true,
      synchronized: true,
    });

    expect(coordinator.requestResume(connectedAndPaired)).toBe(false);
  });

  it("does not run a resume flow for an unpaired or still-hidden page", () => {
    const coordinator = new ForegroundResumeCoordinator();
    coordinator.markBackgrounded();

    expect(coordinator.requestResume({
      ...connectedAndPaired,
      paired: false,
    })).toBe(false);
    expect(coordinator.requestResume({
      ...connectedAndPaired,
      documentHidden: true,
    })).toBe(false);
    expect(coordinator.requestResume({
      ...connectedAndPaired,
      connectable: false,
    })).toBe(false);
  });

  it("keeps recovery eligible for a later retry when the connection is still unavailable", () => {
    const coordinator = new ForegroundResumeCoordinator();
    coordinator.markBackgrounded();

    expect(coordinator.requestResume(connectedAndPaired)).toBe(true);
    coordinator.completeResume({
      documentHidden: false,
      connected: false,
      synchronized: false,
    });

    expect(coordinator.requestResume(connectedAndPaired)).toBe(true);
  });

  it("keeps recovery pending when a connection survives but its workspace sync did not", () => {
    const coordinator = new ForegroundResumeCoordinator();
    coordinator.markBackgrounded();

    expect(coordinator.requestResume(connectedAndPaired)).toBe(true);
    coordinator.completeResume({
      documentHidden: false,
      connected: true,
      synchronized: false,
    });

    expect(coordinator.requestResume(connectedAndPaired)).toBe(true);
  });

  it("allows a fresh visible event after a queued timer is cancelled in the background", () => {
    const coordinator = new ForegroundResumeCoordinator();
    coordinator.markBackgrounded();

    expect(coordinator.requestResume(connectedAndPaired)).toBe(true);
    coordinator.cancelQueuedResume();

    expect(coordinator.requestResume(connectedAndPaired)).toBe(true);
  });
});
