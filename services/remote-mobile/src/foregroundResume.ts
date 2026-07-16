export interface ForegroundResumeEligibility {
  documentHidden: boolean;
  paired: boolean;
  connectable: boolean;
}

/**
 * Coalesces the cluster of browser lifecycle events emitted when a PWA returns
 * from the background. A paired device can safely resume its existing secure
 * session; it must never fall back to the QR ceremony merely because iOS
 * suspended the page.
 */
export class ForegroundResumeCoordinator {
  private resumeRequired = false;
  private resumeQueued = false;

  markBackgrounded(): void {
    this.resumeRequired = true;
  }

  requestResume(eligibility: ForegroundResumeEligibility): boolean {
    if (
      !this.resumeRequired ||
      this.resumeQueued ||
      eligibility.documentHidden ||
      !eligibility.paired ||
      !eligibility.connectable
    ) {
      return false;
    }
    this.resumeQueued = true;
    return true;
  }

  cancelQueuedResume(): void {
    this.resumeQueued = false;
  }

  completeResume(options: {
    documentHidden: boolean;
    connected: boolean;
    synchronized: boolean;
  }): void {
    this.resumeQueued = false;
    if (!options.documentHidden && options.connected && options.synchronized) {
      this.resumeRequired = false;
    }
  }
}
