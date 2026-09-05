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

/* ── Frontier Model Official Logos (Authentic Official Vector Paths) ───── */

export const OpenAILogo = ({ className, width = 24, height = 24, ...rest }: IconProps) => (
  <svg
    viewBox="0 0 24 24"
    fill="currentColor"
    fillRule="evenodd"
    width={width}
    height={height}
    className={className}
    aria-hidden="true"
    focusable="false"
    {...rest}
  >
    <path d="M9.205 8.658v-2.26c0-.19.072-.333.238-.428l4.543-2.616c.619-.357 1.356-.523 2.117-.523 2.854 0 4.662 2.212 4.662 4.566 0 .167 0 .357-.024.547l-4.71-2.759a.797.797 0 00-.856 0l-5.97 3.473zm10.609 8.8V12.06c0-.333-.143-.57-.429-.737l-5.97-3.473 1.95-1.118a.433.433 0 01.476 0l4.543 2.617c1.309.76 2.189 2.378 2.189 3.948 0 1.808-1.07 3.473-2.76 4.163zM7.802 12.703l-1.95-1.142c-.167-.095-.239-.238-.239-.428V5.899c0-2.545 1.95-4.472 4.591-4.472 1 0 1.927.333 2.712.928L8.23 5.067c-.285.166-.428.404-.428.737v6.898zM12 15.128l-2.795-1.57v-3.33L12 8.658l2.795 1.57v3.33L12 15.128zm1.796 7.23c-1 0-1.927-.332-2.712-.927l4.686-2.712c.285-.166.428-.404.428-.737v-6.898l1.974 1.142c.167.095.238.238.238.428v5.233c0 2.545-1.974 4.472-4.614 4.472zm-5.637-5.303l-4.544-2.617c-1.308-.761-2.188-2.378-2.188-3.948A4.482 4.482 0 014.21 6.327v5.423c0 .333.143.571.428.738l5.947 3.449-1.95 1.118a.432.432 0 01-.476 0zm-.262 3.9c-2.688 0-4.662-2.021-4.662-4.519 0-.19.024-.38.047-.57l4.686 2.71c.286.167.571.167.856 0l5.97-3.448v2.26c0 .19-.07.333-.237.428l-4.543 2.616c-.619.357-1.356.523-2.117.523zm5.899 2.83a5.947 5.947 0 005.827-4.756C22.287 18.339 24 15.84 24 13.296c0-1.665-.713-3.282-1.998-4.448.119-.5.19-.999.19-1.498 0-3.401-2.759-5.947-5.946-5.947-.642 0-1.26.095-1.88.31A5.962 5.962 0 0010.205 0a5.947 5.947 0 00-5.827 4.757C1.713 5.447 0 7.945 0 10.49c0 1.666.713 3.283 1.998 4.448-.119.5-.19 1-.19 1.499 0 3.401 2.759 5.946 5.946 5.946.642 0 1.26-.095 1.88-.309a5.96 5.96 0 004.162 1.713z" />
  </svg>
);

export const MiniMaxLogo = ({ className, width = 24, height = 24, ...rest }: IconProps) => (
  <svg
    viewBox="0 0 24 24"
    width={width}
    height={height}
    className={className}
    aria-hidden="true"
    focusable="false"
    {...rest}
  >
    <defs>
      <linearGradient id="minimax-official-grad" x1="0%" x2="100%" y1="50%" y2="50%">
        <stop offset="0%" stopColor="#E2167E" />
        <stop offset="100%" stopColor="#FE603C" />
      </linearGradient>
    </defs>
    <path
      d="M16.278 2c1.156 0 2.093.927 2.093 2.07v12.501a.74.74 0 00.744.709.74.74 0 00.743-.709V9.099a2.06 2.06 0 012.071-2.049A2.06 2.06 0 0124 9.1v6.561a.649.649 0 01-.652.645.649.649 0 01-.653-.645V9.1a.762.762 0 00-.766-.758.762.762 0 00-.766.758v7.472a2.037 2.037 0 01-2.048 2.026 2.037 2.037 0 01-2.048-2.026v-12.5a.785.785 0 00-.788-.753.785.785 0 00-.789.752l-.001 15.904A2.037 2.037 0 0113.441 22a2.037 2.037 0 01-2.048-2.026V18.04c0-.356.292-.645.652-.645.36 0 .652.289.652.645v1.934c0 .263.142.506.372.638.23.131.514.131.744 0a.734.734 0 00.372-.638V4.07c0-1.143.937-2.07 2.093-2.07zm-5.674 0c1.156 0 2.093.927 2.093 2.07v11.523a.648.648 0 01-.652.645.648.648 0 01-.652-.645V4.07a.785.785 0 00-.789-.78.785.785 0 00-.789.78v14.013a2.06 2.06 0 01-2.07 2.048 2.06 2.06 0 01-2.071-2.048V9.1a.762.762 0 00-.766-.758.762.762 0 00-.766.758v3.8a2.06 2.06 0 01-2.071 2.049A2.06 2.06 0 010 12.9v-1.378c0-.357.292-.646.652-.646.36 0 .653.29.653.646V12.9c0 .418.343.757.766.757s.766-.339.766-.757V9.099a2.06 2.06 0 012.07-2.048 2.06 2.06 0 012.071 2.048v8.984c0 .419.343.758.767.758.423 0 .766-.339.766-.758V4.07c0-1.143.937-2.07 2.093-2.07z"
      fill="url(#minimax-official-grad)"
      fillRule="nonzero"
    />
  </svg>
);

export const DeepSeekLogo = ({ className, width = 24, height = 24, ...rest }: IconProps) => (
  <svg
    viewBox="0 0 24 24"
    width={width}
    height={height}
    className={className}
    aria-hidden="true"
    focusable="false"
    {...rest}
  >
    <path
      d="M23.748 4.482c-.254-.124-.364.113-.512.234-.051.039-.094.09-.137.136-.372.397-.806.657-1.373.626-.829-.046-1.537.214-2.163.848-.133-.782-.575-1.248-1.247-1.548-.352-.156-.708-.311-.955-.65-.172-.241-.219-.51-.305-.774-.055-.16-.11-.323-.293-.35-.2-.031-.278.136-.356.276-.313.572-.434 1.202-.422 1.84.027 1.436.633 2.58 1.838 3.393.137.093.172.187.129.323-.082.28-.18.552-.266.833-.055.179-.137.217-.329.14a5.526 5.526 0 01-1.736-1.18c-.857-.828-1.631-1.742-2.597-2.458a11.365 11.365 0 00-.689-.471c-.985-.957.13-1.743.388-1.836.27-.098.093-.432-.779-.428-.872.004-1.67.295-2.687.684a3.055 3.055 0 01-.465.137 9.597 9.597 0 00-2.883-.102c-1.885.21-3.39 1.102-4.497 2.623C.082 8.606-.231 10.684.152 12.85c.403 2.284 1.569 4.175 3.36 5.653 1.858 1.533 3.997 2.284 6.438 2.14 1.482-.085 3.133-.284 4.994-1.86.47.234.962.327 1.78.397.63.059 1.236-.03 1.705-.128.735-.156.684-.837.419-.961-2.155-1.004-1.682-.595-2.113-.926 1.096-1.296 2.746-2.642 3.392-7.003.05-.347.007-.565 0-.845-.004-.17.035-.237.23-.256a4.173 4.173 0 001.545-.475c1.396-.763 1.96-2.015 2.093-3.517.02-.23-.004-.467-.247-.588zM11.581 18c-2.089-1.642-3.102-2.183-3.52-2.16-.392.024-.321.471-.235.763.09.288.207.486.371.739.114.167.192.416-.113.603-.673.416-1.842-.14-1.897-.167-1.361-.802-2.5-1.86-3.301-3.307-.774-1.393-1.224-2.887-1.298-4.482-.02-.386.093-.522.477-.592a4.696 4.696 0 011.529-.039c2.132.312 3.946 1.265 5.468 2.774.868.86 1.525 1.887 2.202 2.891.72 1.066 1.494 2.082 2.48 2.914.348.292.625.514.891.677-.802.09-2.14.11-3.054-.614zm1-6.44a.306.306 0 01.415-.287.302.302 0 01.2.288.306.306 0 01-.31.307.303.303 0 01-.304-.308zm3.11 1.596c-.2.081-.399.151-.59.16a1.245 1.245 0 01-.798-.254c-.274-.23-.47-.358-.552-.758a1.73 1.73 0 01.016-.588c.07-.327-.008-.537-.239-.727-.187-.156-.426-.199-.688-.199a.559.559 0 01-.254-.078c-.11-.054-.2-.19-.114-.358.028-.054.16-.186.192-.21.356-.202.767-.136 1.146.016.352.144.618.408 1.001.782.391.451.462.576.685.914.176.265.336.537.445.848.067.195-.019.354-.25.452z"
      fill="#4D6BFE"
    />
  </svg>
);
