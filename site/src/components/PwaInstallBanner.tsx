import { useCallback, useEffect, useState } from "react";
import type { Copy } from "../i18n";
import { CheckIcon, CloseIcon, ShareIcon, SmartphoneIcon, SparklesIcon } from "./icons";
import { useAuth } from "../context/AuthContext";

type Props = {
  copy: Copy;
};

interface BeforeInstallPromptEvent extends Event {
  readonly platforms: Array<string>;
  readonly userChoice: Promise<{
    outcome: "accepted" | "dismissed";
    platform: string;
  }>;
  prompt(): Promise<void>;
}

export const PWA_STORAGE_KEY_PREFIX = "somniq_pwa_installed_or_dismissed_";

export function getPwaStorageKey(userId: number | string): string {
  return `${PWA_STORAGE_KEY_PREFIX}${userId}`;
}

export function isPwaPromptHandled(userId?: number | string): boolean {
  if (!userId) return false;
  try {
    return typeof window !== "undefined" && window.localStorage?.getItem(getPwaStorageKey(userId)) === "true";
  } catch {
    return false;
  }
}

export function setPwaPromptHandled(userId?: number | string): void {
  if (!userId) return;
  try {
    if (typeof window !== "undefined" && window.localStorage) {
      window.localStorage.setItem(getPwaStorageKey(userId), "true");
    }
  } catch {
    // ignore storage restrictions
  }
}

export default function PwaInstallBanner({ copy }: Props) {
  const { user, isAuthenticated } = useAuth();
  const [deferredPrompt, setDeferredPrompt] = useState<BeforeInstallPromptEvent | null>(null);
  const [isMobile, setIsMobile] = useState<boolean>(false);
  const [isStandalone, setIsStandalone] = useState<boolean>(false);
  const [isIos, setIsIos] = useState<boolean>(false);
  const [showIosGuide, setShowIosGuide] = useState<boolean>(false);
  const [dismissed, setDismissed] = useState<boolean>(false);
  const [installed, setInstalled] = useState<boolean>(false);

  const { pwa } = copy;
  const userId = user?.id;

  useEffect(() => {
    // Strictly verify if device is a mobile device (phone / tablet)
    const userAgent = window.navigator.userAgent.toLowerCase();
    const mobileRegex = /android|iphone|ipad|ipod|mobile|phone|silk|blackberry|bb10|rim|touch/i;
    const isTouchMobile =
      mobileRegex.test(userAgent) ||
      (window.innerWidth <= 768 && ("ontouchstart" in window || navigator.maxTouchPoints > 0));

    setIsMobile(isTouchMobile);

    // Check if already in standalone PWA mode
    const standalone =
      window.matchMedia("(display-mode: standalone)").matches ||
      (window.navigator as any).standalone === true ||
      document.referrer.includes("android-app://");

    setIsStandalone(standalone);

    // Check iOS device
    const isIosDevice = /iphone|ipad|ipod/.test(userAgent);
    setIsIos(isIosDevice);

    // Listen for native install prompt on Android/Chrome
    const handleBeforeInstallPrompt = (e: Event) => {
      e.preventDefault();
      setDeferredPrompt(e as BeforeInstallPromptEvent);
    };

    window.addEventListener("beforeinstallprompt", handleBeforeInstallPrompt);

    window.addEventListener("appinstalled", () => {
      setInstalled(true);
      setDeferredPrompt(null);
      if (userId) {
        setPwaPromptHandled(userId);
      }
      setTimeout(() => setDismissed(true), 3000);
    });

    return () => {
      window.removeEventListener("beforeinstallprompt", handleBeforeInstallPrompt);
    };
  }, [userId]);

  const markHandled = useCallback(() => {
    setDismissed(true);
    if (userId) {
      setPwaPromptHandled(userId);
    }
  }, [userId]);

  // Requirement: Only show when logged in (isAuthenticated === true and user.id is present)
  if (!isAuthenticated || !userId) {
    return null;
  }

  // Requirement: Check if previously prompted/dismissed/installed for this user
  if (isPwaPromptHandled(userId)) {
    return null;
  }

  // Only render on mobile devices and when not standalone / dismissed
  if (!isMobile || isStandalone || dismissed) {
    return null;
  }

  const handleInstallClick = async () => {
    markHandled();
    if (deferredPrompt) {
      try {
        await deferredPrompt.prompt();
        const choice = await deferredPrompt.userChoice;
        if (choice.outcome === "accepted") {
          setInstalled(true);
        }
        setDeferredPrompt(null);
      } catch {
        // fallback
      }
    } else if (isIos) {
      setShowIosGuide(true);
    } else {
      // Generic browser guidance
      setShowIosGuide(true);
    }
  };

  const handleDismiss = () => {
    markHandled();
  };

  const handleCloseIosGuide = () => {
    setShowIosGuide(false);
    markHandled();
  };

  return (
    <>
      <aside className="pwa-banner" aria-label={pwa.bannerTitle} data-reveal>
        <div className="container pwa-banner-inner">
          <div className="pwa-banner-content">
            <div className="pwa-banner-icon">
              <SmartphoneIcon width={22} height={22} />
            </div>
            <div className="pwa-banner-text">
              <p className="pwa-banner-title">
                <SparklesIcon width={14} height={14} className="pwa-sparkle" />
                {pwa.bannerTitle}
              </p>
              <p className="pwa-banner-desc">{pwa.bannerDesc}</p>
            </div>
          </div>

          <div className="pwa-banner-actions">
            <button
              type="button"
              className="btn btn--primary btn--sm pwa-install-btn"
              onClick={handleInstallClick}
            >
              {installed ? (
                <>
                  <CheckIcon width={15} height={15} />
                  <span>{pwa.installed}</span>
                </>
              ) : (
                <>
                  <SmartphoneIcon width={15} height={15} />
                  <span>{pwa.installBtn}</span>
                </>
              )}
            </button>
            <button
              type="button"
              className="pwa-dismiss-btn"
              onClick={handleDismiss}
              aria-label="Dismiss"
            >
              <CloseIcon width={16} height={16} />
            </button>
          </div>
        </div>
      </aside>

      {/* iOS & Mobile Add-to-Homescreen Guide Modal */}
      {showIosGuide && (
        <div className="ios-guide-overlay" onClick={handleCloseIosGuide}>
          <div
            className="ios-guide-modal"
            role="dialog"
            aria-modal="true"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              type="button"
              className="ios-guide-close"
              onClick={handleCloseIosGuide}
            >
              <CloseIcon width={18} height={18} />
            </button>

            <div className="ios-guide-header">
              <div className="ios-guide-badge">
                <SmartphoneIcon width={20} height={20} />
              </div>
              <h3>{pwa.iosTitle}</h3>
            </div>

            <ol className="ios-guide-steps">
              <li>
                <div className="step-icon-wrap">
                  <ShareIcon width={18} height={18} />
                </div>
                <span>{pwa.iosStep1}</span>
              </li>
              <li>
                <div className="step-icon-wrap">
                  <span className="step-symbol">⊞</span>
                </div>
                <span>{pwa.iosStep2}</span>
              </li>
              <li>
                <div className="step-icon-wrap">
                  <CheckIcon width={18} height={18} />
                </div>
                <span>{pwa.iosStep3}</span>
              </li>
            </ol>

            <button
              type="button"
              className="btn btn--primary btn--block ios-guide-confirm"
              onClick={handleCloseIosGuide}
            >
              {pwa.iosGotIt}
            </button>
          </div>
        </div>
      )}
    </>
  );
}
