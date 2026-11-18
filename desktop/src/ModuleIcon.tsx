import type { ReactNode } from "react";

/** The 24px outline glyph every module uses in the navigation rail. */
export const ModuleIcon = ({ children }: { children: ReactNode }) => (
  <svg width="24" height="24" viewBox="0 0 24 24" fill="none"
    stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"
    aria-hidden="true">
    {children}
  </svg>
);
