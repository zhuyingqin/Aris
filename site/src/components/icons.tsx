import type { SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement>;

function Base({ children, ...rest }: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      {children}
    </svg>
  );
}

export const LiteratureIcon = (p: IconProps) => (
  <Base {...p}>
    <path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H19v15H6.5A2.5 2.5 0 0 0 4 20.5V5.5Z" />
    <path d="M8 7.5h7M8 11h5" />
  </Base>
);

export const LabIcon = (p: IconProps) => (
  <Base {...p}>
    <path d="M10 3v6.2L4.8 18a2 2 0 0 0 1.7 3h11a2 2 0 0 0 1.7-3L14 9.2V3" />
    <path d="M8.5 3h7M7.6 14.5h8.8" />
  </Base>
);

export const TypesetIcon = (p: IconProps) => (
  <Base {...p}>
    <path d="M5 4h14v16H5z" />
    <path d="M8.5 8.5h7M8.5 12h7M8.5 15.5h4" />
  </Base>
);

export const ReviewIcon = (p: IconProps) => (
  <Base {...p}>
    <circle cx="10.5" cy="10.5" r="6.5" />
    <path d="m15.4 15.4 4.1 4.1" />
    <path d="M7.8 10.6l1.9 1.9 3.4-3.6" />
  </Base>
);

/* Memory pyramid tiers, base → apex. */

export const FactsIcon = (p: IconProps) => (
  <Base {...p}>
    <path d="M7 4h10a1 1 0 0 1 1 1v15a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1Z" />
    <path d="M9.5 3h5v2.6h-5z" />
    <path d="m8.9 10.6 1.2 1.2 2.4-2.5M8.9 15.4l1.2 1.2 2.4-2.5M15 10h1.2M15 15h1.2" />
  </Base>
);

export const EpisodeIcon = (p: IconProps) => (
  <Base {...p}>
    <path d="M5.5 3.5h9L18.5 7v13.5h-13z" />
    <path d="M14 3.5V7h4" />
    <path d="M8.5 11.5h7M8.5 15h4.5" />
  </Base>
);

export const CoreIcon = (p: IconProps) => (
  <Base {...p}>
    <path d="M12 3.4c2 0 3.3 1.2 3.5 2.7 1.7.3 2.8 1.6 2.8 3.2 0 .8-.3 1.5-.7 2 .6.6 1 1.4 1 2.4 0 1.9-1.5 3.4-3.4 3.4-.4 0-.8-.1-1.2-.2-.3 1.2-1.3 2-2.6 2s-2.3-.8-2.6-2c-.4.1-.8.2-1.2.2-1.9 0-3.4-1.5-3.4-3.4 0-1 .4-1.8 1-2.4-.4-.5-.7-1.2-.7-2 0-1.6 1.1-2.9 2.8-3.2.2-1.5 1.5-2.7 3.5-2.7Z" />
    <path d="M12 6.2v12" />
  </Base>
);

/* Benefit cards. */

export const LoopIcon = (p: IconProps) => (
  <Base {...p}>
    <path d="M4.6 12a7.4 7.4 0 0 1 12.6-5.3l2.2 2.1" />
    <path d="M19.4 12a7.4 7.4 0 0 1-12.6 5.3l-2.2-2.1" />
    <path d="M19.6 4.6v4.2h-4.2M4.4 19.4v-4.2h4.2" />
  </Base>
);

export const TraceIcon = (p: IconProps) => (
  <Base {...p}>
    <circle cx="12" cy="12" r="8.4" />
    <circle cx="12" cy="12" r="3.4" />
    <path d="M12 1.9v2.6M12 19.5v2.6M1.9 12h2.6M19.5 12h2.6" />
  </Base>
);

export const DiskIcon = (p: IconProps) => (
  <Base {...p}>
    <ellipse cx="12" cy="6.3" rx="7.2" ry="2.9" />
    <path d="M4.8 6.3v11.4c0 1.6 3.2 2.9 7.2 2.9s7.2-1.3 7.2-2.9V6.3" />
    <path d="M4.8 12c0 1.6 3.2 2.9 7.2 2.9s7.2-1.3 7.2-2.9" />
  </Base>
);

export const CheckIcon = (p: IconProps) => (
  <Base {...p}>
    <path d="m5 12.5 4.5 4.5L19 7" />
  </Base>
);

export const ArrowIcon = (p: IconProps) => (
  <Base {...p}>
    <path d="M5 12h13M13 6.5 18.5 12 13 17.5" />
  </Base>
);

export const GithubIcon = (p: IconProps) => (
  <svg
    viewBox="0 0 24 24"
    fill="currentColor"
    aria-hidden="true"
    focusable="false"
    {...p}
  >
    <path d="M12 1.8a10.2 10.2 0 0 0-3.23 19.88c.51.09.7-.22.7-.5v-1.9c-2.84.62-3.44-1.2-3.44-1.2-.47-1.18-1.14-1.5-1.14-1.5-.93-.63.07-.62.07-.62 1.03.07 1.57 1.06 1.57 1.06.91 1.57 2.4 1.12 2.98.86.09-.66.36-1.12.65-1.38-2.27-.26-4.65-1.13-4.65-5.04 0-1.11.4-2.02 1.05-2.74-.1-.26-.46-1.3.1-2.7 0 0 .86-.28 2.81 1.05a9.7 9.7 0 0 1 5.12 0c1.95-1.33 2.8-1.05 2.8-1.05.57 1.4.21 2.44.11 2.7.65.72 1.05 1.63 1.05 2.74 0 3.92-2.39 4.78-4.66 5.03.37.32.7.94.7 1.9v2.8c0 .28.18.6.7.5A10.2 10.2 0 0 0 12 1.8Z" />
  </svg>
);

export const WindowsIcon = (p: IconProps) => (
  <svg
    viewBox="0 0 24 24"
    fill="currentColor"
    aria-hidden="true"
    focusable="false"
    {...p}
  >
    <path d="M3 5.6 10.4 4.6v7.1H3V5.6Zm8.6-1.2L21 3v8.7h-9.4V4.4ZM3 12.9h7.4V20L3 18.6v-5.7Zm8.6 0H21V21l-9.4-1.3v-6.8Z" />
  </svg>
);

export const SunIcon = (p: IconProps) => (
  <Base {...p}>
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" />
  </Base>
);

export const MoonIcon = (p: IconProps) => (
  <Base {...p}>
    <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
  </Base>
);

export const ChartBarIcon = (p: IconProps) => (
  <Base {...p}>
    <path d="M18 20V10M12 20V4M6 20v-6" />
  </Base>
);

export const TableIcon = (p: IconProps) => (
  <Base {...p}>
    <rect x="3" y="3" width="18" height="18" rx="2" />
    <path d="M3 9h18M3 15h18M9 3v18M15 3v18" />
  </Base>
);

export const UserIcon = (p: IconProps) => (
  <Base {...p}>
    <path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2" />
    <circle cx="12" cy="7" r="4" />
  </Base>
);

export const LockIcon = (p: IconProps) => (
  <Base {...p}>
    <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
    <path d="M7 11V7a5 5 0 0 1 10 0v4" />
  </Base>
);

export const KeyIcon = (p: IconProps) => (
  <Base {...p}>
    <path d="m21 2-2 2m-1.5 1.5L19 7l-2 2-1.5-1.5M15 9l-2 2-6.5 6.5a2.12 2.12 0 0 1-3 0 2.12 2.12 0 0 1 0-3L10 8l1-1" />
    <circle cx="18" cy="6" r="3" />
  </Base>
);

export const CloseIcon = (p: IconProps) => (
  <Base {...p}>
    <path d="M18 6 6 18M6 6l12 12" />
  </Base>
);


export const SmartphoneIcon = (p: IconProps) => (
  <Base {...p}>
    <rect x="5" y="2" width="14" height="20" rx="2" ry="2" />
    <path d="M12 18h.01" />
  </Base>
);

export const RefreshIcon = (p: IconProps) => (
  <Base {...p}>
    <path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-1.19" />
  </Base>
);

export const CopyIcon = (p: IconProps) => (
  <Base {...p}>
    <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
  </Base>
);

export const SparklesIcon = (p: IconProps) => (
  <Base {...p}>
    <path d="m12 3-1.9 5.8a2 2 0 0 1-1.3 1.3L3 12l5.8 1.9a2 2 0 0 1 1.3 1.3L12 21l1.9-5.8a2 2 0 0 1 1.3-1.3L21 12l-5.8-1.9a2 2 0 0 1-1.3-1.3L12 3z" />
  </Base>
);

export const ShareIcon = (p: IconProps) => (
  <Base {...p}>
    <path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8" />
    <polyline points="16 6 12 2 8 6" />
    <line x1="12" y1="2" x2="12" y2="15" />
  </Base>
);

export const DesktopIcon = (p: IconProps) => (
  <Base {...p}>
    <rect x="2" y="3" width="20" height="14" rx="2" ry="2" />
    <line x1="8" y1="21" x2="16" y2="21" />
    <line x1="12" y1="17" x2="12" y2="21" />
  </Base>
);

export const ShieldCheckIcon = (p: IconProps) => (
  <Base {...p}>
    <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
    <path d="m9 12 2 2 4-4" />
  </Base>
);

export const ExternalLinkIcon = (p: IconProps) => (
  <Base {...p}>
    <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
    <polyline points="15 3 21 3 21 9" />
    <line x1="10" y1="14" x2="21" y2="3" />
  </Base>
);

export const AlertCircleIcon = (p: IconProps) => (
  <Base {...p}>
    <circle cx="12" cy="12" r="10" />
    <line x1="12" y1="8" x2="12" y2="12" />
    <line x1="12" y1="16" x2="12.01" y2="16" />
  </Base>
);

export const LinkIcon = (p: IconProps) => (
  <Base {...p}>
    <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
    <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
  </Base>
);

export const HomeIcon = (p: IconProps) => (
  <Base {...p}>
    <path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
    <polyline points="9 22 9 12 15 12 15 22" />
  </Base>
);

export const LogoutIcon = (p: IconProps) => (
  <Base {...p}>
    <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
    <polyline points="16 17 21 12 16 7" />
    <line x1="21" y1="12" x2="9" y2="12" />
  </Base>
);

export const GlobeIcon = (p: IconProps) => (
  <Base {...p}>
    <circle cx="12" cy="12" r="10" />
    <path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20M2 12h20" />
  </Base>
);

export const ChevronDownIcon = (p: IconProps) => (
  <Base {...p}>
    <path d="m6 9 6 6 6-6" />
  </Base>
);

export const NetworkIcon = (p: IconProps) => (
  <Base {...p}>
    <rect x="2" y="3" width="6" height="6" rx="1.5" />
    <rect x="16" y="3" width="6" height="6" rx="1.5" />
    <rect x="9" y="15" width="6" height="6" rx="1.5" />
    <path d="M5 9v3a2 2 0 0 0 2 2h5M19 9v3a2 2 0 0 1-2 2h-5M12 14v1" />
  </Base>
);

export const PaletteIcon = (p: IconProps) => (
  <Base {...p}>
    <circle cx="13.5" cy="6.5" r=".5" fill="currentColor" />
    <circle cx="17.5" cy="10.5" r=".5" fill="currentColor" />
    <circle cx="8.5" cy="7.5" r=".5" fill="currentColor" />
    <circle cx="6.5" cy="12.5" r=".5" fill="currentColor" />
    <path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.926 0 1.648-.746 1.648-1.688 0-.437-.18-.835-.437-1.125-.29-.289-.438-.652-.438-1.125a1.64 1.64 0 0 1 1.668-1.668h1.996c3.051 0 5.563-2.512 5.563-5.563C21.996 6.5 17.5 2 12 2z" />
  </Base>
);

export const CpuIcon = (p: IconProps) => (
  <Base {...p}>
    <rect x="4" y="4" width="16" height="16" rx="2" />
    <rect x="9" y="9" width="6" height="6" />
    <path d="M9 1v3M15 1v3M9 20v3M15 20v3M20 9h3M20 14h3M1 9h3M1 14h3" />
  </Base>
);

export const WorkflowIcon = (p: IconProps) => (
  <Base {...p}>
    <rect x="3" y="3" width="6" height="6" rx="1" />
    <rect x="15" y="15" width="6" height="6" rx="1" />
    <path d="M6 9v3a3 3 0 0 0 3 3h6M18 9v6" />
  </Base>
);

export const HandshakeIcon = (p: IconProps) => (
  <Base {...p}>
    <path d="m11 17 2 2a1 1 0 0 0 1.4 0l4.3-4.3a1 1 0 0 0 0-1.4l-1.4-1.4a1 1 0 0 0-1.4 0L14 13.8M13 7l-2-2a1 1 0 0 0-1.4 0L5.3 9.3a1 1 0 0 0 0 1.4l1.4 1.4a1 1 0 0 0 1.4 0L10 10.2" />
    <path d="M2 17l4-4M18 7l4 4" />
  </Base>
);
