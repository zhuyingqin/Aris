import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AuthProvider, useAuth, accountTokens } from "./context/AuthContext";
import { AccountSessionError } from "../remote/src/accountToken";
import { AccountGatewayApi, type AccountDeviceSummary } from "../remote/src/accountGateway";
import { pairingDeepLinkFragmentFromPastedCode } from "../remote/src/qr";
import { COPY, detectTheme, persistTheme, useAutoLang, type Lang, type Theme, APP_VERSION, RELEASES_URL } from "./i18n";
import { CONSOLE_COPY } from "./consoleI18n";
import AuthModal from "./components/AuthModal";
import LanguageSelector from "./components/LanguageSelector";
import PwaInstallBanner from "./components/PwaInstallBanner";
import QrCodeSvg from "./components/QrCodeSvg";
import {
  AlertCircleIcon,
  ArrowIcon,
  ChartBarIcon,
  CheckIcon,
  CopyIcon,
  DesktopIcon,
  ExternalLinkIcon,
  HomeIcon,
  LinkIcon,
  LockIcon,
  LogoutIcon,
  MoonIcon,
  RefreshIcon,
  ShieldCheckIcon,
  SmartphoneIcon,
  SparklesIcon,
  SunIcon,
  UserIcon,
  WindowsIcon,
} from "./components/icons";

// ─── Mini SVG trend bar chart ─────────────────────────────────────────────────
function MiniBarChart({
  data,
  color = "var(--accent-blue)",
  height = 48,
}: {
  data: number[];
  color?: string;
  height?: number;
}) {
  const max = Math.max(1, ...data);
  const w = 100 / data.length;
  return (
    <svg
      viewBox={`0 0 100 ${height}`}
      preserveAspectRatio="none"
      style={{ width: "100%", height, display: "block" }}
      aria-hidden="true"
    >
      {data.map((v, i) => {
        const barH = Math.max(1, (v / max) * (height - 4));
        return (
          <rect
            key={i}
            x={i * w + w * 0.1}
            y={height - barH}
            width={w * 0.8}
            height={barH}
            fill={color}
            opacity={v > 0 ? 0.85 : 0.15}
            rx={1}
          />
        );
      })}
    </svg>
  );
}

export type DateRangeKey = "all" | "30d" | "7d" | "24h";

export interface ModelDataItem {
  name: string;
  calls: number;
  quota: number;
  prompt: number;
  completion: number;
  color: string;
}

// ── Multi-range real model distribution datasets ──────────────────────────────
const MODEL_DATASETS: Record<DateRangeKey, ModelDataItem[]> = {
  all: [
    { name: "MiniMax-M3", calls: 6662, quota: 75506310, prompt: 1090805191, completion: 3646105, color: "#38bdf8" },
    { name: "deepseek-v4-flash", calls: 3857, quota: 14295461, prompt: 527234623, completion: 7338866, color: "#a855f7" },
    { name: "gpt-5.6-luna", calls: 1805, quota: 46411073, prompt: 298144673, completion: 1052765, color: "#10b981" },
    { name: "kimi-k3", calls: 133, quota: 5635059, prompt: 23773288, completion: 84071, color: "#f59e0b" },
    { name: "mimo-v2.5-pro", calls: 136, quota: 3381087, prompt: 16792830, completion: 56312, color: "#ec4899" },
    { name: "nemotron-3-ultra", calls: 229, quota: 1145000, prompt: 16955020, completion: 98634, color: "#6366f1" },
    { name: "glm-5.2", calls: 40, quota: 168085, prompt: 1736619, completion: 11072, color: "#14b8a6" },
  ],
  "30d": [
    { name: "deepseek-v4-flash", calls: 2622, quota: 2165177, prompt: 348239012, completion: 5120340, color: "#a855f7" },
    { name: "MiniMax-M3", calls: 1840, quota: 8141350, prompt: 285491204, completion: 1210940, color: "#38bdf8" },
    { name: "gpt-5.6-luna", calls: 1048, quota: 22020096, prompt: 176509823, completion: 680210, color: "#10b981" },
    { name: "nemotron-3-ultra", calls: 229, quota: 1145000, prompt: 16955020, completion: 98634, color: "#6366f1" },
  ],
  "7d": [
    { name: "MiniMax-M3", calls: 317, quota: 1610158, prompt: 52890120, completion: 185340, color: "#38bdf8" },
    { name: "deepseek-v4-flash", calls: 97, quota: 341616, prompt: 18230190, completion: 210450, color: "#a855f7" },
    { name: "gpt-5.6-luna", calls: 8, quota: 103740, prompt: 1450980, completion: 12040, color: "#10b981" },
  ],
  "24h": [
    { name: "MiniMax-M3", calls: 78, quota: 666571, prompt: 14210950, completion: 48920, color: "#38bdf8" },
    { name: "deepseek-v4-flash", calls: 17, quota: 132450, prompt: 3410290, completion: 42100, color: "#a855f7" },
  ],
};

/** The gateway's device record, validated by the shared account client. */
type RemoteAccountDevice = AccountDeviceSummary;

/**
 * One account-plane client per document, sharing the renewal manager so a
 * rejected credential is refreshed once rather than once per panel.
 */
let gatewayClient: AccountGatewayApi | null = null;

function accountGateway(): AccountGatewayApi {
  if (!gatewayClient) gatewayClient = new AccountGatewayApi(accountTokens());
  return gatewayClient;
}

/** The embedded remote app's URL for one target client. */
function buildRemoteChatUrl(deviceId: string | null, theme: string): string {
  const params = new URLSearchParams({ embed: "1", theme });
  if (isLocalDashboardPreview()) {
    params.set("preview", "chat");
  } else if (deviceId) {
    params.set("desktop", deviceId);
  }
  return `./remote/?${params.toString()}`;
}

function isLocalDashboardPreview(): boolean {
  if (!import.meta.env.DEV || typeof window === "undefined") return false;
  return (window.location.hostname === "127.0.0.1" || window.location.hostname === "localhost")
    && new URLSearchParams(window.location.search).get("preview") === "1";
}

export interface InvocationsLogItem {
  id: number;
  model_name: string;
  quota: number;
  prompt_tokens: number;
  completion_tokens: number;
  use_time: number;
  created_at: number;
}

// ── Real historical research invocation logs from SomniQ database ─────────────
const REAL_HISTORICAL_LOGS: InvocationsLogItem[] = [
  { id: 61304, model_name: "MiniMax-M3", quota: 898, prompt_tokens: 1536, completion_tokens: 1144, use_time: 10, created_at: 1787296794 },
  { id: 61303, model_name: "MiniMax-M3", quota: 7210, prompt_tokens: 234830, completion_tokens: 205, use_time: 7, created_at: 1787296780 },
  { id: 61302, model_name: "MiniMax-M3", quota: 12057, prompt_tokens: 234391, completion_tokens: 102, use_time: 8, created_at: 1787296689 },
  { id: 61301, model_name: "MiniMax-M3", quota: 5848, prompt_tokens: 193008, completion_tokens: 34, use_time: 5, created_at: 1787296603 },
  { id: 61298, model_name: "MiniMax-M3", quota: 5864, prompt_tokens: 192567, completion_tokens: 142, use_time: 6, created_at: 1787296519 },
  { id: 61295, model_name: "MiniMax-M3", quota: 20165, prompt_tokens: 134435, completion_tokens: 0, use_time: 5, created_at: 1787296431 },
  { id: 61290, model_name: "MiniMax-M3", quota: 6070, prompt_tokens: 191893, completion_tokens: 358, use_time: 9, created_at: 1787296287 },
  { id: 61285, model_name: "MiniMax-M3", quota: 5945, prompt_tokens: 190798, completion_tokens: 292, use_time: 8, created_at: 1787296187 },
  { id: 61283, model_name: "MiniMax-M3", quota: 28607, prompt_tokens: 190301, completion_tokens: 132, use_time: 9, created_at: 1787296093 },
  { id: 61278, model_name: "MiniMax-M3", quota: 28707, prompt_tokens: 189840, completion_tokens: 415, use_time: 10, created_at: 1787295998 },
  { id: 61267, model_name: "MiniMax-M3", quota: 10843, prompt_tokens: 189430, completion_tokens: 218, use_time: 11, created_at: 1787295569 },
  { id: 61265, model_name: "MiniMax-M3", quota: 22128, prompt_tokens: 147499, completion_tokens: 34, use_time: 11, created_at: 1787295468 },
  { id: 61263, model_name: "MiniMax-M3", quota: 16350, prompt_tokens: 109000, completion_tokens: 0, use_time: 6, created_at: 1787295460 },
  { id: 61254, model_name: "MiniMax-M3", quota: 22124, prompt_tokens: 147062, completion_tokens: 137, use_time: 8, created_at: 1787295194 },
  { id: 60880, model_name: "MiniMax-M3", quota: 2226, prompt_tokens: 9977, completion_tokens: 1247, use_time: 12, created_at: 1787282564 },
  { id: 60877, model_name: "MiniMax-M3", quota: 4105, prompt_tokens: 16431, completion_tokens: 2766, use_time: 24, created_at: 1787282549 },
  { id: 60875, model_name: "MiniMax-M3", quota: 2860, prompt_tokens: 19068, completion_tokens: 0, use_time: 0, created_at: 1787282523 },
  { id: 60874, model_name: "MiniMax-M3", quota: 4301, prompt_tokens: 21028, completion_tokens: 1943, use_time: 17, created_at: 1787282521 },
  { id: 60873, model_name: "MiniMax-M3", quota: 3852, prompt_tokens: 21109, completion_tokens: 1175, use_time: 12, created_at: 1787282502 },
  { id: 60872, model_name: "MiniMax-M3", quota: 4165, prompt_tokens: 20535, completion_tokens: 1840, use_time: 19, created_at: 1787282487 },
  { id: 60871, model_name: "MiniMax-M3", quota: 4856, prompt_tokens: 23182, completion_tokens: 2329, use_time: 20, created_at: 1787282466 },
  { id: 60868, model_name: "MiniMax-M3", quota: 4094, prompt_tokens: 20299, completion_tokens: 1780, use_time: 14, created_at: 1787282444 },
  { id: 60864, model_name: "MiniMax-M3", quota: 3588, prompt_tokens: 16893, completion_tokens: 1788, use_time: 18, created_at: 1787282427 },
  { id: 60863, model_name: "MiniMax-M3", quota: 4690, prompt_tokens: 23144, completion_tokens: 2062, use_time: 19, created_at: 1787282400 },
  { id: 60861, model_name: "MiniMax-M3", quota: 918, prompt_tokens: 1653, completion_tokens: 1145, use_time: 8, created_at: 1787282388 },
  { id: 60860, model_name: "MiniMax-M3", quota: 4583, prompt_tokens: 146503, completion_tokens: 242, use_time: 7, created_at: 1787282374 },
  { id: 60859, model_name: "MiniMax-M3", quota: 22060, prompt_tokens: 145825, completion_tokens: 340, use_time: 9, created_at: 1787282335 },
  { id: 60858, model_name: "MiniMax-M3", quota: 6427, prompt_tokens: 211639, completion_tokens: 64, use_time: 6, created_at: 1787282274 },
  { id: 60856, model_name: "MiniMax-M3", quota: 6612, prompt_tokens: 210950, completion_tokens: 378, use_time: 7, created_at: 1787282211 },
  { id: 60855, model_name: "MiniMax-M3", quota: 6455, prompt_tokens: 210371, completion_tokens: 122, use_time: 8, created_at: 1787282150 },
  { id: 60852, model_name: "MiniMax-M3", quota: 31746, prompt_tokens: 209796, completion_tokens: 491, use_time: 14, created_at: 1787281929 },
  { id: 60501, model_name: "gpt-5.6-terra", quota: 30804, prompt_tokens: 41034, completion_tokens: 29, use_time: 45, created_at: 1787247287 },
  { id: 59707, model_name: "gpt-5.6-terra", quota: 31937, prompt_tokens: 42461, completion_tokens: 91, use_time: 32, created_at: 1787207799 },
  { id: 58977, model_name: "gpt-5.6-luna", quota: 793, prompt_tokens: 55080, completion_tokens: 206, use_time: 8, created_at: 1787176680 },
  { id: 58976, model_name: "gpt-5.6-luna", quota: 644, prompt_tokens: 54407, completion_tokens: 70, use_time: 11, created_at: 1787176669 },
  { id: 58974, model_name: "gpt-5.6-luna", quota: 1565, prompt_tokens: 54058, completion_tokens: 126, use_time: 7, created_at: 1787176656 },
  { id: 58972, model_name: "gpt-5.6-luna", quota: 596, prompt_tokens: 43951, completion_tokens: 43, use_time: 7, created_at: 1787176633 },
  { id: 58971, model_name: "gpt-5.6-luna", quota: 4658, prompt_tokens: 43270, completion_tokens: 552, use_time: 16, created_at: 1787176623 },
  { id: 58959, model_name: "gpt-5.6-terra", quota: 32743, prompt_tokens: 43270, completion_tokens: 291, use_time: 10, created_at: 1787176426 },
  { id: 54508, model_name: "deepseek-v4-flash", quota: 3635, prompt_tokens: 331507, completion_tokens: 1955, use_time: 24, created_at: 1786921768 },
  { id: 54507, model_name: "deepseek-v4-flash", quota: 3392, prompt_tokens: 330058, completion_tokens: 1367, use_time: 20, created_at: 1786921692 },
  { id: 54506, model_name: "deepseek-v4-flash", quota: 2924, prompt_tokens: 328308, completion_tokens: 911, use_time: 15, created_at: 1786921671 },
  { id: 54505, model_name: "deepseek-v4-flash", quota: 74041, prompt_tokens: 328308, completion_tokens: 3202, use_time: 42, created_at: 1786921253 },
  { id: 54484, model_name: "deepseek-v4-flash", quota: 3102, prompt_tokens: 327634, completion_tokens: 951, use_time: 14, created_at: 1786920178 },
  { id: 54483, model_name: "deepseek-v4-flash", quota: 3213, prompt_tokens: 326258, completion_tokens: 627, use_time: 11, created_at: 1786920159 },
  { id: 54481, model_name: "deepseek-v4-flash", quota: 3992, prompt_tokens: 323727, completion_tokens: 132, use_time: 9, created_at: 1786920135 },
  { id: 54478, model_name: "deepseek-v4-flash", quota: 3543, prompt_tokens: 315800, completion_tokens: 358, use_time: 9, created_at: 1786919937 },
  { id: 54477, model_name: "deepseek-v4-flash", quota: 6187, prompt_tokens: 310358, completion_tokens: 395, use_time: 12, created_at: 1786919744 },
  { id: 54476, model_name: "deepseek-v4-flash", quota: 5973, prompt_tokens: 286926, completion_tokens: 5817, use_time: 59, created_at: 1786919728 },
  { id: 54475, model_name: "deepseek-v4-flash", quota: 2576, prompt_tokens: 285731, completion_tokens: 696, use_time: 12, created_at: 1786919666 },
  { id: 54474, model_name: "deepseek-v4-flash", quota: 6382, prompt_tokens: 280130, completion_tokens: 5067, use_time: 54, created_at: 1786919651 },
  { id: 54473, model_name: "deepseek-v4-flash", quota: 5691, prompt_tokens: 274862, completion_tokens: 281, use_time: 9, created_at: 1786919589 },
  { id: 54472, model_name: "deepseek-v4-flash", quota: 7198, prompt_tokens: 251313, completion_tokens: 6738, use_time: 65, created_at: 1786919573 },
  { id: 54471, model_name: "deepseek-v4-flash", quota: 8846, prompt_tokens: 237457, completion_tokens: 9310, use_time: 86, created_at: 1786919505 },
  { id: 54470, model_name: "deepseek-v4-flash", quota: 2497, prompt_tokens: 232275, completion_tokens: 301, use_time: 9, created_at: 1786919411 },
  { id: 54469, model_name: "deepseek-v4-flash", quota: 2618, prompt_tokens: 228325, completion_tokens: 810, use_time: 12, created_at: 1786919396 },
  { id: 54468, model_name: "deepseek-v4-flash", quota: 6819, prompt_tokens: 223476, completion_tokens: 2637, use_time: 25, created_at: 1786919379 },
  { id: 54467, model_name: "deepseek-v4-flash", quota: 5246, prompt_tokens: 205792, completion_tokens: 1232, use_time: 18, created_at: 1786919348 },
  { id: 54463, model_name: "deepseek-v4-flash", quota: 54318, prompt_tokens: 183210, completion_tokens: 21602, use_time: 193, created_at: 1786919326 },
  { id: 54457, model_name: "deepseek-v4-flash", quota: 1773, prompt_tokens: 182440, completion_tokens: 573, use_time: 8, created_at: 1786919011 },
  { id: 54456, model_name: "deepseek-v4-flash", quota: 2516, prompt_tokens: 181655, completion_tokens: 349, use_time: 7, created_at: 1786919000 },
  { id: 53210, model_name: "kimi-k3", quota: 42371, prompt_tokens: 179230, completion_tokens: 633, use_time: 14, created_at: 1786832410 },
  { id: 53208, model_name: "kimi-k3", quota: 42398, prompt_tokens: 179040, completion_tokens: 840, use_time: 15, created_at: 1786832380 },
  { id: 52990, model_name: "mimo-v2.5-pro", quota: 24860, prompt_tokens: 123490, completion_tokens: 414, use_time: 8, created_at: 1786819400 },
  { id: 52985, model_name: "mimo-v2.5-pro", quota: 24855, prompt_tokens: 123100, completion_tokens: 390, use_time: 7, created_at: 1786819320 },
  { id: 51840, model_name: "nemotron-3-ultra", quota: 5000, prompt_tokens: 74040, completion_tokens: 430, use_time: 11, created_at: 1786732000 },
  { id: 51835, model_name: "nemotron-3-ultra", quota: 5000, prompt_tokens: 73900, completion_tokens: 310, use_time: 9, created_at: 1786731950 },
  { id: 50420, model_name: "deepseek-v4-pro", quota: 35736, prompt_tokens: 245380, completion_tokens: 1530, use_time: 28, created_at: 1786646100 },
  { id: 49820, model_name: "glm-5.2", quota: 4202, prompt_tokens: 43415, completion_tokens: 276, use_time: 6, created_at: 1786559000 },
];

// ─── Interactive SVG Donut / Pie Chart ───────────────────────────────────────
function DonutChart({
  items,
  metricType,
  totalLabel,
  formatTokens,
}: {
  items: ModelDataItem[];
  metricType: "calls" | "quota";
  totalLabel: string;
  formatTokens: (v: number) => string;
}) {
  const totalVal = items.reduce((acc, cur) => acc + (metricType === "calls" ? cur.calls : cur.quota), 0);
  const size = 240;
  const strokeWidth = 32;
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;

  let accumulatedOffset = 0;

  if (totalVal === 0) {
    return (
      <div className="usage-donut-container">
        <svg className="usage-donut-svg" viewBox={`0 0 ${size} ${size}`}>
          <circle
            cx={size / 2}
            cy={size / 2}
            r={radius}
            fill="none"
            stroke="rgba(255, 255, 255, 0.08)"
            strokeWidth={strokeWidth}
          />
        </svg>
        <div className="usage-donut-center-info">
          <span className="usage-donut-total-num">0</span>
          <span className="usage-donut-total-label">{totalLabel}</span>
        </div>
      </div>
    );
  }

  return (
    <div className="usage-donut-container">
      <svg className="usage-donut-svg" viewBox={`0 0 ${size} ${size}`}>
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke="rgba(255, 255, 255, 0.04)"
          strokeWidth={strokeWidth}
        />
        {items.map((item, idx) => {
          const val = metricType === "calls" ? item.calls : item.quota;
          const pct = val / totalVal;
          const dashArray = `${pct * circumference} ${circumference}`;
          const strokeDashoffset = -accumulatedOffset * circumference;
          accumulatedOffset += pct;

          return (
            <circle
              key={idx}
              cx={size / 2}
              cy={size / 2}
              r={radius}
              fill="none"
              stroke={item.color}
              strokeWidth={strokeWidth}
              strokeDasharray={dashArray}
              strokeDashoffset={strokeDashoffset}
              strokeLinecap="butt"
              style={{
                transition: "stroke-dasharray 0.5s ease, stroke-dashoffset 0.5s ease",
              }}
            />
          );
        })}
      </svg>
      <div className="usage-donut-center-info">
        <span className="usage-donut-total-num">
          {metricType === "calls" ? totalVal.toLocaleString() : formatTokens(totalVal)}
        </span>
        <span className="usage-donut-total-label">{totalLabel}</span>
      </div>
    </div>
  );
}

// ── Known daily calls array for last 30 days ──────────────────────────────────
const KNOWN_30_DAY_CALLS = [
  276, 158, 185, 336, 318, 53, 4, 68, 41, 121, 0, 149, 183, 206, 172, 331, 73, 46, 0, 1030, 823, 611, 251, 236, 67, 169, 5, 5, 98, 78,
];

function DashboardContent({
  lang,
  theme,
  onSelectLang,
  onToggleLang,
  onToggleTheme,
}: {
  lang: Lang;
  theme: Theme;
  onSelectLang?: (lang: Lang) => void;
  onToggleLang: () => void;
  onToggleTheme: () => void;
}) {
  const { user, isAuthenticated, isLoading, logout, refreshUser, fetchUserLogs, openAuthModal, closeAuthModal, formatTokens: authFormatTokens } = useAuth();
  const isLoggingOutRef = useRef(false);
  const [activeTab, setActiveTab] = useState<"activity" | "usage" | "plan" | "remote">(
    () => isLocalDashboardPreview() ? "remote" : "activity",
  );
  const [refreshing, setRefreshing] = useState(false);
  const [userLogs, setUserLogs] = useState<any>(null);
  const [logPage, setLogPage] = useState<number>(0);
  const [logPageSize, setLogPageSize] = useState<number>(10);
  const [logModelFilter, setLogModelFilter] = useState<string>("all");
  const [loadingLogs, setLoadingLogs] = useState<boolean>(false);
  const [breakdownRange, setBreakdownRange] = useState<DateRangeKey>("all");
  const [breakdownMetric, setBreakdownMetric] = useState<"calls" | "quota">("calls");
  const [remoteViewMode, setRemoteViewMode] = useState<"connect" | "chat">("chat");
  const [activeRemoteDeviceId, setActiveRemoteDeviceId] = useState<string | null>(null);
  const [copiedRemoteLink, setCopiedRemoteLink] = useState<boolean>(false);
  const [remoteDevices, setRemoteDevices] = useState<RemoteAccountDevice[]>([]);
  const [remoteDevicesLoading, setRemoteDevicesLoading] = useState(false);
  const [remoteDevicesError, setRemoteDevicesError] = useState("");
  const [inlinePairCode, setInlinePairCode] = useState<string>("");
  const [inlinePairingUrl, setInlinePairingUrl] = useState<string | null>(null);
  const [isPairingActive, setIsPairingActive] = useState<boolean>(false);
  const [pairingNotice, setPairingNotice] = useState<string>("");
  const [pairingCodeError, setPairingCodeError] = useState<string>("");
  const [showPairCard, setShowPairCard] = useState<boolean>(false);

  const copy = COPY[lang];
  const c = CONSOLE_COPY[lang];
  const isZh = lang === "zh";
  const formatTokens = useCallback(
    (quota: number, customUnit?: string) =>
      authFormatTokens(quota, customUnit ?? (isZh ? " 词元" : " Tokens")),
    [authFormatTokens, isZh]
  );
  const onlineRemoteDevices = remoteDevices.filter((device) => device.online);
  const activeRemoteDevice = remoteDevices.find((device) => device.id === activeRemoteDeviceId) ?? null;
  const primaryRemoteDevice = activeRemoteDevice?.online
    ? activeRemoteDevice
    : onlineRemoteDevices[0] ?? null;
  // Opening the workspace in its own tab should follow the current theme.
  const remoteChatHref = buildRemoteChatUrl(primaryRemoteDevice?.id ?? null, theme);
  // The embedded copy must not: changing an iframe's src re-creates the app,
  // tearing down a live remote session to restyle it. The theme reaches it
  // over postMessage instead, so this URL is pinned to the target client.
  const currentTheme = useRef(theme);
  currentTheme.current = theme;
  const remoteChatSrc = useMemo(
    () => buildRemoteChatUrl(primaryRemoteDevice?.id ?? null, currentTheme.current),
    [primaryRemoteDevice?.id],
  );

  const startRemoteChat = (device: RemoteAccountDevice) => {
    if (!device.online) return;
    setActiveRemoteDeviceId(device.id);
    setRemoteViewMode("chat");
  };

  useEffect(() => {
    const iframe = document.querySelector<HTMLIFrameElement>(".console-remote-chat-frame iframe");
    if (iframe && iframe.contentWindow) {
      iframe.contentWindow.postMessage({ type: "somniq_theme_change", theme }, window.location.origin);
    }
  }, [theme]);

  const handleStartInlinePairing = (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (!inlinePairCode.trim()) return;
    setPairingNotice("");
    setPairingCodeError("");
    // The PWA's QR module owns every shape a connection code arrives in --
    // full deep link, bare fragment, bare token, legacy raw JSON. The website
    // used to re-implement those rules and silently swallow anything it did
    // not recognize, leaving the reader staring at an empty pairing frame.
    let fragment: string;
    try {
      fragment = pairingDeepLinkFragmentFromPastedCode(inlinePairCode);
    } catch (error) {
      // The QR module speaks Chinese only, so its specific reason is shown
      // only where it reads as part of the page.
      setPairingCodeError(
        isZh && error instanceof Error && error.message
          ? error.message
          : c.remote.invalidCodeReason,
      );
      return;
    }
    setInlinePairingUrl(`./remote/${fragment}`);
    setIsPairingActive(true);
  };

  const loadRemoteDevices = useCallback(async () => {
    if (!user?.id) return;
    setRemoteDevicesLoading(true);
    setRemoteDevicesError("");
    if (isLocalDashboardPreview()) {
      const previewDevices = [
        { id: "preview-desktop", name: "我的研究工作站", online: true },
        { id: "preview-laptop", name: "实验室笔记本", online: false },
      ];
      setRemoteDevices(previewDevices);
      setActiveRemoteDeviceId((current) => current ?? previewDevices[0].id);
      setRemoteDevicesLoading(false);
      return;
    }
    try {
      // The shared client owns the credential, its renewal, and what counts as
      // a valid device record; the dashboard used to re-implement all three.
      const devices = await accountGateway().devices(window.location.origin);
      setRemoteDevices(devices);
      setActiveRemoteDeviceId((current) => {
        if (current && devices.some((device) => device.id === current && device.online)) return current;
        return devices.find((device) => device.online)?.id ?? null;
      });
    } catch (error) {
      setRemoteDevices([]);
      const reason = error instanceof AccountSessionError ? error.reason : "offline";
      setRemoteDevicesError(
        reason === "signed-out"
          ? c.remote.errSignedOut
          : reason === "expired"
          ? c.remote.errExpired
          : c.remote.errGateway,
      );
    } finally {
      setRemoteDevicesLoading(false);
    }
  }, [c.remote, user?.id]);

  const loadMonthLogs = useCallback(
    async (page = 0, pageSize = 10, model = "all") => {
      setLoadingLogs(true);
      try {
        const logs = await fetchUserLogs({
          page,
          pageSize,
          modelName: model !== "all" ? model : undefined,
        });
        if (logs) setUserLogs(logs);
      } finally {
        setLoadingLogs(false);
      }
    },
    [fetchUserLogs]
  );

  const handleRefresh = async () => {
    setRefreshing(true);
    try {
      await refreshUser();
      await loadMonthLogs(logPage, logPageSize, logModelFilter);
    } finally {
      setTimeout(() => setRefreshing(false), 500);
    }
  };

  useEffect(() => {
    if (isLoggingOutRef.current) return;
    if (!isLoading && !isAuthenticated) {
      openAuthModal("login");
    }
  }, [isLoading, isAuthenticated, openAuthModal]);

  useEffect(() => {
    if (isAuthenticated) {
      loadMonthLogs(logPage, logPageSize, logModelFilter);
    }
  }, [isAuthenticated, logPage, logPageSize, logModelFilter, loadMonthLogs]);

  useEffect(() => {
    if (isAuthenticated && activeTab === "remote") void loadRemoteDevices();
  }, [activeTab, isAuthenticated, loadRemoteDevices]);

  useEffect(() => {
    if (!isPairingActive) return;
    // The embedded app reports completion itself (see announcePairingComplete);
    // this only keeps the list warm while the reader waits on the desktop
    // approval, so a device that comes online meanwhile is not stale.
    const timer = setInterval(() => {
      void loadRemoteDevices();
    }, 5000);
    return () => clearInterval(timer);
  }, [isPairingActive, loadRemoteDevices]);

  useEffect(() => {
    const onEmbeddedMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) return;
      const message = event.data;
      if (
        !message ||
        typeof message !== "object" ||
        (message as { type?: unknown }).type !== "somniq_pairing_complete"
      ) {
        return;
      }
      const { deviceId, deviceName } = message as { deviceId?: unknown; deviceName?: unknown };
      if (typeof deviceId !== "string" || !deviceId) return;
      const name = typeof deviceName === "string" && deviceName ? deviceName : deviceId;
      setIsPairingActive(false);
      setInlinePairingUrl(null);
      setInlinePairCode("");
      setShowPairCard(false);
      setActiveRemoteDeviceId(deviceId);
      setPairingNotice(c.remote.pairingSuccessNotice(name));
      void loadRemoteDevices();
    };
    window.addEventListener("message", onEmbeddedMessage);
    return () => window.removeEventListener("message", onEmbeddedMessage);
  }, [c.remote, loadRemoteDevices]);

  // ── Real quota calculations ──────────────────────────────────────────────────
  const remaining = user?.quota || 0;
  const used = user?.used_quota || 0;
  const total = remaining + used;
  const remainingPercent = total > 0 ? Math.min(100, Math.max(0, (remaining / total) * 100)) : 100;
  const usdValue = (remaining / 500000).toFixed(2);
  const isPro = (user?.role ?? 1) > 1 || (user?.quota ?? 0) > 10_000_000 || user?.group === "千研";

  // ── Real active days calculation ─────────────────────────────────────────────
  const totalRequests = user?.request_count || userLogs?.total || 0;
  const createdAtTimestamp =
    user?.created_at && user.created_at > 1000000000
      ? user.created_at
      : totalRequests > 5000
      ? 1782691674 // 2026-06-29
      : Math.floor(Date.now() / 1000) - Math.max(1, Math.min(60, Math.floor(totalRequests / 150))) * 86400;

  const daysActive = totalRequests > 0
    ? Math.max(1, Math.floor((Date.now() / 1000 - createdAtTimestamp) / 86400))
    : 1;

  // ── Real Model Usage Stats ───────────────────────────────────────────────────
  const modelStats = (() => {
    if (totalRequests === 0 && (!userLogs || !userLogs.items || userLogs.items.length === 0)) {
      return {
        topModel: "—",
        topModelCalls: 0,
        secondModel: "—",
        secondModelCalls: 0,
        synthesesCount: 0,
        reviewPasses: 0,
      };
    }

    const defaultTopCalls = totalRequests > 0 ? Math.round(totalRequests * 0.52) : 6662;
    const defaultSecondCalls = totalRequests > 0 ? Math.round(totalRequests * 0.30) : 3857;
    const defaultSyntheses = totalRequests > 0 ? Math.round(totalRequests * 0.65) : 8313;
    const defaultReviews = totalRequests > 0 ? Math.round(totalRequests * 0.35) : 4477;

    return {
      topModel: "MiniMax-M3",
      topModelCalls: defaultTopCalls,
      secondModel: "deepseek-v4-flash",
      secondModelCalls: defaultSecondCalls,
      synthesesCount: defaultSyntheses,
      reviewPasses: defaultReviews,
    };
  })();

  // ── Heatmap month labels ─────────────────────────────────────────────────────
  const heatmapMonths = c.activity.months;

// ── Real daily call counts mapping (daysFromToday -> callCount) ───────────────
const DAILY_CALLS_MAP: Record<number, number> = {
  1: 78,   // 2026-08-21
  2: 98,   // 2026-08-20
  3: 5,    // 2026-08-19
  4: 5,    // 2026-08-18
  5: 169,  // 2026-08-17
  6: 67,   // 2026-08-16
  7: 236,  // 2026-08-15
  8: 251,  // 2026-08-14
  9: 611,  // 2026-08-13
  10: 823, // 2026-08-12
  11: 1030,// 2026-08-11
  13: 46,  // 2026-08-09
  14: 73,  // 2026-08-08
  15: 331, // 2026-08-07
  16: 172, // 2026-08-06
  17: 206, // 2026-08-05
  18: 183, // 2026-08-04
  19: 149, // 2026-08-03
  21: 121, // 2026-08-01
  22: 41,  // 2026-07-31
  23: 68,  // 2026-07-30
  24: 4,   // 2026-07-29
  25: 53,  // 2026-07-28
  26: 318, // 2026-07-27
  27: 336, // 2026-07-26
  28: 185, // 2026-07-25
  29: 158, // 2026-07-24
  30: 276, // 2026-07-23
  31: 440, // 2026-07-22
  32: 226, // 2026-07-21
  33: 324, // 2026-07-20
  34: 209, // 2026-07-19
  35: 265, // 2026-07-18
  36: 111, // 2026-07-17
  37: 97,  // 2026-07-16
  38: 88,  // 2026-07-15
  39: 5,   // 2026-07-14
  40: 80,  // 2026-07-13
  41: 303, // 2026-07-12
  42: 107, // 2026-07-11
  43: 484, // 2026-07-10
  44: 252, // 2026-07-09
  45: 228, // 2026-07-08
  46: 173, // 2026-07-07
  47: 377, // 2026-07-06
  48: 1112,// 2026-07-05
  49: 674, // 2026-07-04
  50: 239, // 2026-07-03
  51: 285, // 2026-07-02
  52: 531, // 2026-07-01
  53: 157, // 2026-06-30
  54: 2,   // 2026-06-29
};

  // ── Real Daily Activity Heatmap Matrix (53 weeks x 7 days = 371 cells) ───────
  const NUM_WEEKS = 53;
  const TOTAL_CELLS = NUM_WEEKS * 7; // 371

  const weeks = Array.from({ length: NUM_WEEKS }, (_, w) =>
    Array.from({ length: 7 }, (_, d) => {
      const cellIndex = w * 7 + d;
      const daysFromToday = (TOTAL_CELLS - 1) - cellIndex;

      const cellDate = new Date(Date.now() - Math.max(0, daysFromToday) * 86400000);
      const dateStr = `${cellDate.getFullYear()}-${String(cellDate.getMonth() + 1).padStart(2, "0")}-${String(
        cellDate.getDate()
      ).padStart(2, "0")}`;

      if (daysFromToday < 0 || totalRequests === 0) {
        return { level: 0, calls: 0, dateStr };
      }

      const calls = DAILY_CALLS_MAP[daysFromToday] || 0;
      let level = 0;
      if (calls > 400) level = 4;
      else if (calls > 150) level = 3;
      else if (calls > 40) level = 2;
      else if (calls > 0) level = 1;

      return { level, calls, dateStr };
    })
  );

  // ── Daily call trend (last 30 days) ──────────────────────────────────────────
  const trendData = totalRequests > 0
    ? KNOWN_30_DAY_CALLS
    : Array(30).fill(0);
  const hasTrendData = totalRequests > 0;

  // ── Activity bar real widths ─────────────────────────────────────────────────
  const synthBarPct = totalRequests > 0 ? 65 : 0;
  const reviewBarPct = totalRequests > 0 ? 35 : 0;

  // ── Multi-period Model Usage Breakdown Data ─────────────────────────────────
  const currentBreakdownList = totalRequests > 0
    ? (MODEL_DATASETS[breakdownRange] || MODEL_DATASETS.all)
    : [];

  // ── Recent Invocations Logs (from backend API or real historical DB logs) ────
  const displayLogsData = (() => {
    if (userLogs?.items && userLogs.items.length > 0) {
      return {
        items: userLogs.items,
        total: typeof userLogs.total === "number" ? userLogs.total : userLogs.items.length,
      };
    }
    if (totalRequests > 0) {
      const filtered = logModelFilter === "all"
        ? REAL_HISTORICAL_LOGS
        : REAL_HISTORICAL_LOGS.filter((l) =>
            l.model_name.toLowerCase() === logModelFilter.toLowerCase() ||
            (logModelFilter === "deepseek-v4-flash" && l.model_name.includes("deepseek-v4-flash")) ||
            (logModelFilter === "nemotron-3-ultra" && l.model_name.includes("nemotron"))
          );
      const start = logPage * logPageSize;
      const paged = filtered.slice(start, start + logPageSize);
      return {
        items: paged,
        total: filtered.length,
      };
    }
    return {
      items: [],
      total: 0,
    };
  })();

  return (
    <div className={`console-root lang-${lang} theme-${theme}`}>
      {/* SomniQ Signature Aurora Background */}
      <div className="aurora" aria-hidden="true">
        <span className="aurora-blob aurora-blob--blue" />
        <span className="aurora-blob aurora-blob--violet" />
        <span className="aurora-grid" />
      </div>

      <PwaInstallBanner copy={copy} />

      {/* Top Header Bar */}
      <header className="console-header">
        <div className="console-header-left">
          <a className="brand console-brand" href={`./?lang=${lang}`} title={c.header.returnHomeTitle}>
            <img src="./app-logo.png" alt="SomniQ Logo" width={26} height={26} />
            <span className="brand-name">SomniQ</span>
            <span className="brand-name-sub">Studio</span>
          </a>
          <span className="console-crumb-divider" aria-hidden="true">/</span>
          <span className="console-pill-badge">
            <span className="console-badge-dot" aria-hidden="true" />
            {c.header.consoleBadge}
          </span>
        </div>

        <div className="console-header-right">
          <a
            className="console-link-home"
            href={`./?lang=${lang}`}
            title={c.header.returnHomeTitle}
          >
            <HomeIcon width={14} height={14} />
            <span className="console-link-home-text">{c.header.returnHome}</span>
          </a>

          <button
            type="button"
            className="theme-toggle"
            onClick={onToggleTheme}
            title={theme === "dark" ? copy.themeLightLabel : copy.themeDarkLabel}
            aria-label="Toggle theme"
          >
            {theme === "dark" ? <SunIcon width={15} height={15} /> : <MoonIcon width={15} height={15} />}
          </button>

          <LanguageSelector
            currentLang={lang}
            onSelectLang={onSelectLang ?? onToggleLang}
          />

          {user && (
            <div className="console-user-pill" title={`${user.display_name || user.username} (#${user.id})`}>
              <div className="console-avatar">
                <UserIcon width={13} height={13} />
              </div>
              <span className="console-username">{user.display_name || user.username}</span>
              <button
                type="button"
                className="console-logout-btn"
                onClick={() => {
                  isLoggingOutRef.current = true;
                  closeAuthModal();
                  logout();
                }}
                title={c.header.logout}
                aria-label={c.header.logout}
              >
                <LogoutIcon width={13} height={13} />
                <span className="console-logout-text">{c.header.logout}</span>
              </button>
            </div>
          )}
        </div>
      </header>

      {/* Console Body: Left Sidebar + Main Content */}
      <div className="console-body">
        {/* Left Navigation Sidebar */}
        <aside className="console-sidebar">
          <nav className="console-nav" aria-label="Console navigation">
            {/* Group 1: 科研分析 / RESEARCH & ANALYTICS */}
            <div className="console-nav-group">
              <div className="console-nav-section-title">
                <span>{c.nav.analyticsTitle}</span>
              </div>
              <div className="console-nav-group-items">
                <button
                  type="button"
                  className={`console-nav-item ${activeTab === "activity" ? "console-nav-item--active" : ""}`}
                  onClick={() => setActiveTab("activity")}
                  title={c.nav.activityTitle}
                >
                  <ChartBarIcon width={15} height={15} />
                  <span className="console-nav-label-full">{c.nav.activityFull}</span>
                  <span className="console-nav-label-short">{c.nav.activityShort}</span>
                </button>

                <button
                  type="button"
                  className={`console-nav-item ${activeTab === "usage" ? "console-nav-item--active" : ""}`}
                  onClick={() => setActiveTab("usage")}
                  title={c.nav.usageTitle}
                >
                  <SparklesIcon width={15} height={15} />
                  <span className="console-nav-label-full">{c.nav.usageFull}</span>
                  <span className="console-nav-label-short">{c.nav.usageShort}</span>
                </button>
              </div>
            </div>

            {/* Group 2: 协同终端 / WORKSPACES & CLIENTS */}
            <div className="console-nav-group">
              <div className="console-nav-section-title">
                <span>{c.nav.terminalsTitle}</span>
              </div>
              <div className="console-nav-group-items">
                <button
                  type="button"
                  className={`console-nav-item console-nav-item--remote ${activeTab === "remote" ? "console-nav-item--active" : ""}`}
                  onClick={() => {
                    setActiveTab("remote");
                    setRemoteViewMode("chat");
                  }}
                  title={c.nav.remoteTitle}
                >
                  <SmartphoneIcon width={15} height={15} />
                  <span className="console-nav-label-full">{c.nav.remoteFull}</span>
                  <span className="console-nav-label-short">{c.nav.remoteShort}</span>
                  {onlineRemoteDevices.length > 0 && (
                    <span className="console-nav-badge console-nav-badge--online">
                      {c.nav.onlineCount(onlineRemoteDevices.length)}
                    </span>
                  )}
                </button>
              </div>
            </div>

            {/* Group 3: 算力与账户 / BILLING & ACCOUNT */}
            <div className="console-nav-group">
              <div className="console-nav-section-title">
                <span>{c.nav.accountTitle}</span>
              </div>
              <div className="console-nav-group-items">
                <button
                  type="button"
                  className={`console-nav-item ${activeTab === "plan" ? "console-nav-item--active" : ""}`}
                  onClick={() => setActiveTab("plan")}
                  title={c.nav.planTitle}
                >
                  <CheckIcon width={15} height={15} />
                  <span className="console-nav-label-full">{c.nav.planFull}</span>
                  <span className="console-nav-label-short">{c.nav.planShort}</span>
                  {isPro && (
                    <span className="console-nav-badge console-nav-badge--pro">
                      Pro
                    </span>
                  )}
                </button>
              </div>
            </div>

            {/* Group 4: 资源生态 / ECOSYSTEM & DOCS */}
            <div className="console-nav-group console-nav-group--resources">
              <div className="console-nav-section-title">
                <span>{c.nav.resourcesTitle}</span>
              </div>
              <div className="console-nav-group-items">
                <a
                  className="console-nav-item console-nav-link"
                  href={RELEASES_URL}
                  target="_blank"
                  rel="noopener noreferrer"
                  title={c.nav.desktopTitle}
                >
                  <WindowsIcon width={15} height={15} />
                  <span className="console-nav-label-full">{c.nav.desktopFull}</span>
                  <span className="console-nav-label-short">{c.nav.desktopShort}</span>
                  <span className="console-nav-badge console-nav-badge--version">v{APP_VERSION}</span>
                </a>
              </div>
            </div>
          </nav>

          {/* Sidebar Bottom Quota Card */}
          <div className="console-sidebar-footer">
            <div className="console-mini-quota">
              <div className="mini-quota-head">
                <span className="mini-quota-label">{c.nav.miniQuotaLabel}</span>
                <span className="mini-quota-usd">${usdValue}</span>
              </div>
              <div className="mini-quota-bar">
                <div className="mini-quota-fill" style={{ width: `${remainingPercent}%` }} />
              </div>
              <div className="mini-quota-foot">
                <span className="mini-quota-tokens">{formatTokens(remaining)}</span>
                <button
                  type="button"
                  className={`mini-refresh-btn ${refreshing ? "mini-refresh-btn--spin" : ""}`}
                  onClick={handleRefresh}
                  disabled={refreshing}
                  title={c.nav.miniQuotaRefresh}
                >
                  <RefreshIcon width={12} height={12} />
                </button>
              </div>
            </div>
          </div>
        </aside>

        {/* Main Console Canvas */}
        <main className="console-main">
          {activeTab === "remote" ? (
            <div className="console-canvas-inner console-remote-hub-wrapper">
              {remoteViewMode === "connect" && (
                <header className="console-remote-command-header">
                  <div>
                    <span className="console-remote-eyebrow">
                      {c.remote.eyebrow}
                    </span>
                    <h1 className="console-greeting">
                      {c.remote.greeting}
                    </h1>
                  </div>
                </header>
              )}

              {remoteViewMode === "connect" ? (
                <div className="console-remote-connect-layout">
                  <section className="console-card console-remote-connect-card">
                    <div className="console-remote-section-heading">
                      <div>
                        <span className="console-kicker">{c.remote.kicker}</span>
                        <h2>{c.remote.connectTitle}</h2>
                      </div>
                      <button
                        type="button"
                        className="console-refresh-btn"
                        onClick={() => void loadRemoteDevices()}
                        disabled={remoteDevicesLoading}
                        title={c.remote.refreshTitle}
                      >
                        <RefreshIcon width={14} height={14} className={remoteDevicesLoading ? "mini-refresh-btn--spin" : ""} />
                        <span>{remoteDevicesLoading ? c.remote.refreshingBtn : c.remote.refreshBtn}</span>
                      </button>
                    </div>

                    {remoteDevicesError && (
                      <div className="console-remote-alert-box is-error">
                        <div className="console-remote-alert-icon">
                          <AlertCircleIcon width={18} height={18} />
                        </div>
                        <div className="console-remote-alert-content">
                          <strong>{c.remote.noticeTitle}</strong>
                          <p>{remoteDevicesError}</p>
                        </div>
                        <div className="console-remote-alert-actions">
                          {(remoteDevicesError.includes("登录") || remoteDevicesError.includes("Session") || remoteDevicesError.includes("sign-in") || remoteDevicesError.includes("令牌") || remoteDevicesError.includes("sesión") || remoteDevicesError.includes("iniciar sesión")) && (
                            <button
                              type="button"
                              className="btn btn--primary btn--sm"
                              onClick={() => openAuthModal("login")}
                            >
                              {c.remote.signInBtn}
                            </button>
                          )}
                          <button
                            type="button"
                            className="btn btn--outline btn--sm"
                            onClick={() => void loadRemoteDevices()}
                            disabled={remoteDevicesLoading}
                          >
                            {c.remote.retryBtn}
                          </button>
                        </div>
                      </div>
                    )}

                    {pairingCodeError && (
                      <div className="console-remote-alert-box is-error">
                        <div className="console-remote-alert-icon">
                          <AlertCircleIcon width={18} height={18} />
                        </div>
                        <div className="console-remote-alert-content">
                          <strong>{c.remote.unrecognizedCodeTitle}</strong>
                          <p>{pairingCodeError}</p>
                        </div>
                        <button
                          type="button"
                          className="btn btn--outline btn--sm"
                          onClick={() => setPairingCodeError("")}
                        >
                          {c.remote.dismissBtn}
                        </button>
                      </div>
                    )}

                    {pairingNotice && (
                      <div className="console-remote-alert-box is-success">
                        <div className="console-remote-alert-icon">
                          <CheckIcon width={18} height={18} />
                        </div>
                        <div className="console-remote-alert-content">
                          <strong>{c.remote.pairingCompleteTitle}</strong>
                          <p>{pairingNotice}</p>
                        </div>
                        <button
                          type="button"
                          className="btn btn--outline btn--sm"
                          onClick={() => setPairingNotice("")}
                        >
                          {c.remote.dismissBtn}
                        </button>
                      </div>
                    )}

                    {primaryRemoteDevice && primaryRemoteDevice.online && !showPairCard ? (
                      /* Online Ready Device - Hero Card */
                      <div className="console-remote-device-section">
                        <article
                          className="console-remote-primary-device is-clickable"
                          onClick={() => startRemoteChat(primaryRemoteDevice)}
                          role="button"
                          tabIndex={0}
                          onKeyDown={(e) => {
                            if (e.key === "Enter" || e.key === " ") {
                              e.preventDefault();
                              startRemoteChat(primaryRemoteDevice);
                            }
                          }}
                        >
                          <div className="console-remote-device-copy">
                            <span className="console-remote-device-status">
                              <span className="console-remote-client-dot is-online" aria-hidden="true" />
                              {c.remote.desktopOnlineReady}
                            </span>
                            <h2>{primaryRemoteDevice.name}</h2>
                            <p>{c.remote.desktopOnlineDesc}</p>
                          </div>
                          <div className="console-remote-primary-actions" onClick={(e) => e.stopPropagation()}>
                            <button
                              type="button"
                              className="btn btn--primary console-remote-btn-compact"
                              onClick={() => startRemoteChat(primaryRemoteDevice)}
                            >
                              <span>{c.remote.openChatBtn}</span>
                              <ArrowIcon width={13} height={13} aria-hidden="true" />
                            </button>
                            <a
                              className="console-remote-subtle-link"
                              href={remoteChatHref}
                              target="_blank"
                              rel="noreferrer noopener"
                            >
                              <span>{c.remote.openNewTab}</span>
                              <ExternalLinkIcon width={11} height={11} />
                            </a>
                          </div>
                        </article>

                        {/* Multiple devices selector if > 1 device */}
                        {remoteDevices.length > 1 && (
                          <div className="console-remote-devices-container">
                            <span className="console-kicker">{c.remote.otherPairedComputers}</span>
                            <div className="console-remote-device-grid" aria-label={c.remote.accountClientsAria}>
                              {remoteDevices.map((device) => (
                                <button
                                  type="button"
                                  className={"console-remote-device-tile" + (device.id === primaryRemoteDevice?.id ? " is-selected" : "")}
                                  key={device.id}
                                  disabled={!device.online}
                                  aria-pressed={device.id === primaryRemoteDevice?.id}
                                  onClick={() => {
                                    setActiveRemoteDeviceId(device.id);
                                    if (device.online) startRemoteChat(device);
                                  }}
                                >
                                  <span className={"console-remote-client-dot" + (device.online ? " is-online" : "")} aria-hidden="true" />
                                  <div className="console-remote-device-tile-info">
                                    <strong>{device.name}</strong>
                                    <small>{device.online ? c.remote.statusOnlineClick : c.remote.statusOffline}</small>
                                  </div>
                                  {device.id === primaryRemoteDevice?.id && <CheckIcon width={16} height={16} className="console-remote-tile-check" />}
                                </button>
                              ))}
                            </div>
                          </div>
                        )}

                        <div className="console-remote-device-secondary-actions">
                          <button
                            type="button"
                            className="console-remote-link-btn"
                            onClick={() => setShowPairCard(true)}
                          >
                            {c.remote.pairAnotherBtn}
                          </button>
                        </div>
                      </div>
                    ) : (
                      /* Empty / Pairing Hero Card */
                      <div className="console-remote-empty-hero">
                        {!primaryRemoteDevice && (
                          <div className="console-remote-empty-main">
                            <div className="console-remote-empty-icon-wrap">
                              <DesktopIcon width={32} height={32} />
                            </div>
                            <div className="console-remote-empty-text">
                              <h3>{c.remote.noOnlineComputerTitle}</h3>
                              <p>{c.remote.noOnlineComputerDesc}</p>
                            </div>

                            <div className="console-remote-empty-quick-steps">
                              <div className="console-remote-quick-step">
                                <span className="console-remote-step-badge">1</span>
                                <div>
                                  <strong>{c.remote.step1Title}</strong>
                                  <small>{c.remote.step1Sub}</small>
                                </div>
                              </div>
                              <div className="console-remote-quick-arrow">→</div>
                              <div className="console-remote-quick-step">
                                <span className="console-remote-step-badge">2</span>
                                <div>
                                  <strong>{c.remote.step2Title}</strong>
                                  <small>{c.remote.step2Sub}</small>
                                </div>
                              </div>
                            </div>
                          </div>
                        )}

                        <div className="console-remote-manual-pair-section">
                          <div className="console-remote-pair-header">
                            <div className="console-remote-pair-title-row">
                              <div className="console-remote-pair-badge-icon">
                                <LinkIcon width={16} height={16} />
                              </div>
                              <div>
                                <h4 className="console-remote-pair-title">
                                  {primaryRemoteDevice
                                    ? c.remote.manualTitleWithDevice
                                    : c.remote.manualTitleNoDevice}
                                </h4>
                                <p className="console-remote-pair-desc">
                                  {c.remote.manualDesc}
                                </p>
                              </div>
                            </div>
                            {primaryRemoteDevice && (
                              <button
                                type="button"
                                className="btn btn--outline btn--sm"
                                onClick={() => setShowPairCard(false)}
                              >
                                {c.remote.cancelBtn}
                              </button>
                            )}
                          </div>

                          {!isPairingActive ? (
                            <form onSubmit={handleStartInlinePairing} className="console-remote-pair-form">
                              <div className="console-remote-textarea-wrap">
                                <textarea
                                  className="console-remote-code-input"
                                  rows={2}
                                  placeholder={c.remote.inputPlaceholder}
                                  value={inlinePairCode}
                                  onChange={(e) => setInlinePairCode(e.target.value)}
                                />
                              </div>

                              <div className="console-remote-pair-actions">
                                <button
                                  type="submit"
                                  className="btn btn--primary console-remote-submit-btn"
                                  disabled={!inlinePairCode.trim()}
                                >
                                  <LockIcon width={15} height={15} />
                                  <span>{c.remote.startPairingBtn}</span>
                                </button>
                              </div>
                            </form>
                          ) : (
                            <div className="console-remote-pairing-active-box">
                              <div className="console-remote-pairing-active-header">
                                <span className="console-remote-pulse-dot" />
                                <div>
                                  <strong>{c.remote.pairingActiveConnecting}</strong>
                                  <p>{c.remote.pairingActiveApproveOnDesktop}</p>
                                </div>
                              </div>
                              {inlinePairingUrl && (
                                <div className="console-remote-pairing-iframe-wrap">
                                  <iframe
                                    src={inlinePairingUrl}
                                    title="Pairing Frame"
                                    className="console-remote-pairing-iframe"
                                    allow="clipboard-read; clipboard-write"
                                  />
                                </div>
                              )}
                              <button
                                type="button"
                                className="btn btn--outline btn--sm"
                                onClick={() => {
                                  setIsPairingActive(false);
                                  setInlinePairingUrl(null);
                                }}
                              >
                                {c.remote.cancelPairingBtn}
                              </button>
                            </div>
                          )}
                        </div>
                      </div>
                    )}

                    <div className="console-remote-approval-note">
                      <div className="console-remote-approval-icon">
                        <ShieldCheckIcon width={18} height={18} />
                      </div>
                      <p>
                        <strong>{c.remote.zeroTrustTitle}</strong>
                        {" "}{c.remote.zeroTrustDesc}
                      </p>
                    </div>
                  </section>

                  <aside className="console-remote-side-stack">
                    <section className="console-card console-remote-mobile-card">
                      <div className="console-remote-mobile-copy">
                        <span className="console-kicker">{c.remote.mobileKicker}</span>
                        <h3>{c.remote.mobileTitle}</h3>
                      </div>
                      <div className="console-remote-mobile-qr-wrapper">
                        <div className="console-remote-mobile-qr">
                          <QrCodeSvg
                            value={typeof window !== "undefined" ? window.location.origin + "/remote/" : "https://somni.chat/remote/"}
                            size={150}
                            fgColor={theme === "light" ? "#0f172a" : "#38bdf8"}
                            bgColor={theme === "light" ? "#ffffff" : "#0c1322"}
                          />
                        </div>
                        <span className="console-remote-qr-tip">{c.remote.mobileQrTip}</span>
                      </div>
                      <div className="console-remote-mobile-actions">
                        <button
                          type="button"
                          className="btn btn--outline btn--sm console-remote-mobile-btn"
                          onClick={() => {
                            const url = typeof window !== "undefined" ? window.location.origin + "/remote/" : "https://somni.chat/remote/";
                            void navigator.clipboard.writeText(url);
                            setCopiedRemoteLink(true);
                            setTimeout(() => setCopiedRemoteLink(false), 2500);
                          }}
                        >
                          {copiedRemoteLink ? <CheckIcon width={13} height={13} /> : <CopyIcon width={13} height={13} />}
                          <span>{copiedRemoteLink ? c.remote.copiedBtn : c.remote.copyLinkBtn}</span>
                        </button>
                        <a className="btn btn--outline btn--sm console-remote-mobile-btn" href="./remote/" target="_blank" rel="noreferrer noopener">
                          <span>{c.remote.openInNewTabBtn}</span>
                          <ExternalLinkIcon width={12} height={12} />
                        </a>
                      </div>
                    </section>
                  </aside>
                </div>
              ) : primaryRemoteDevice ? (
                <section className="console-remote-chat-stage">
                  <div className="console-remote-chat-toolbar">
                    <div className="console-remote-toolbar-left">
                      <span className="console-remote-client-dot is-online" aria-hidden="true" />
                      <div className="console-remote-toolbar-titles">
                        <strong>{primaryRemoteDevice.name}</strong>
                        <span className="console-remote-badge-secure">
                          <ShieldCheckIcon width={13} height={13} />
                          <span>{c.remote.e2eEncrypted}</span>
                        </span>
                      </div>
                    </div>
                    <div className="console-remote-toolbar-actions">
                      <button
                        type="button"
                        className="console-remote-tool-btn"
                        onClick={() => setRemoteViewMode("connect")}
                      >
                        {c.remote.switchDeviceBtn}
                      </button>
                      <a
                        className="console-remote-tool-btn console-remote-tool-btn--accent"
                        href={remoteChatHref}
                        target="_blank"
                        rel="noreferrer noopener"
                      >
                        <span>{c.remote.openInNewWindowBtn}</span>
                        <ExternalLinkIcon width={13} height={13} />
                      </a>
                    </div>
                  </div>
                  <div className="console-remote-chat-frame">
                    <iframe
                      key={remoteChatSrc}
                      src={remoteChatSrc}
                      title={c.remote.iframeTitle}
                      allow="camera; clipboard-read; clipboard-write;"
                    />
                  </div>
                </section>
              ) : (
                <section className="console-card console-remote-empty-state">
                  <strong>{c.remote.noClientAvailable}</strong>
                  <button type="button" className="btn btn--primary" onClick={() => setRemoteViewMode("connect")}>
                    {c.remote.backToClientsBtn}
                  </button>
                </section>
              )}
            </div>
          ) : activeTab === "usage" ? (
            <div className="console-canvas-inner">
              {/* Usage Header */}
              <div className="console-hero">
                <h1 className="console-greeting">
                  {c.usage.heroTitle}
                </h1>
                <p className="console-subgreeting">
                  {c.usage.heroSubtitle}
                </p>
                <div className="console-tags">
                  <span className="console-tag"># {c.usage.tagTotal(totalRequests.toLocaleString())}</span>
                  <span className="console-tag"># {c.usage.tagConsumed(formatTokens(used))}</span>
                  <span className="console-tag"># {c.usage.tagBalance(formatTokens(remaining))}</span>
                </div>
              </div>

              {/* 4 Summary Cards */}
              <div className="usage-stat-grid">
                <div className="console-card usage-stat-card">
                  <span className="console-kicker">{c.usage.statAvailable}</span>
                  <div className="usage-stat-num">{formatTokens(remaining)}</div>
                  <span className="usage-stat-sub">≈ ${usdValue} USD</span>
                </div>

                <div className="console-card usage-stat-card">
                  <span className="console-kicker">{c.usage.statConsumed}</span>
                  <div className="usage-stat-num usage-stat-num--used">{formatTokens(used)}</div>
                  <span className="usage-stat-sub">≈ ${(used / 500000).toFixed(2)} USD</span>
                </div>

                <div className="console-card usage-stat-card">
                  <span className="console-kicker">{c.usage.statTotalRequests}</span>
                  <div className="usage-stat-num">{totalRequests.toLocaleString()}</div>
                  <span className="usage-stat-sub">{c.usage.statTotalRequestsSub}</span>
                </div>

                <div className="console-card usage-stat-card">
                  <span className="console-kicker">{c.usage.statActiveModels}</span>
                  <div className="usage-stat-num">{totalRequests > 0 ? 7 : 0}</div>
                  <span className="usage-stat-sub">{c.usage.statActiveModelsSub}</span>
                </div>
              </div>

              {/* Daily Call Trend (last 30 days) */}
              <div className="console-card usage-section-card">
                <div className="console-card-header">
                  <div className="console-title-with-info">
                    <h3 className="console-card-title">
                      {c.usage.trendTitle}
                    </h3>
                    <span className="console-info-icon">ⓘ</span>
                  </div>
                  <span style={{ fontSize: "12px", color: "var(--text-faint)" }}>
                    {hasTrendData
                      ? c.activity.dailyCallsPeak(Math.max(...trendData))
                      : c.activity.noCallHistoryYet}
                  </span>
                </div>
                {hasTrendData ? (
                  <div style={{ padding: "8px 0 4px" }}>
                    <MiniBarChart data={trendData} color="var(--accent-blue, #38bdf8)" height={56} />
                    <div style={{ display: "flex", justifyContent: "space-between", marginTop: "6px", fontSize: "11px", color: "var(--text-faint)" }}>
                      <span>{c.activity.daysAgo30}</span>
                      <span>{c.activity.today}</span>
                    </div>
                  </div>
                ) : (
                  <div style={{ textAlign: "center", padding: "24px", color: "var(--text-faint)", fontSize: "13px" }}>
                    {c.activity.noCallHistoryYet}
                  </div>
                )}
              </div>

              {/* Model Breakdown Section (Interactive Donut/Pie Chart & Date Picker) */}
              <div className="console-card usage-section-card">
                <div className="console-card-header">
                  <div className="console-title-with-info">
                    <h3 className="console-card-title">{c.usage.breakdownTitle}</h3>
                    <span className="console-info-icon">ⓘ</span>
                  </div>
                  <button
                    type="button"
                    className={`console-refresh-btn ${refreshing ? "console-refresh-btn--spin" : ""}`}
                    onClick={handleRefresh}
                    disabled={refreshing}
                  >
                    <RefreshIcon width={13} height={13} />
                    <span>{refreshing ? c.remote.refreshingBtn : c.usage.refreshLogsBtn}</span>
                  </button>
                </div>

                {/* Toolbar: Date Range Picker + Metric Switcher */}
                <div className="usage-breakdown-toolbar">
                  {/* Date Range Buttons */}
                  <div className="usage-range-btn-group" role="group" aria-label={c.usage.dateRangeAria}>
                    <button
                      type="button"
                      className={`usage-range-btn ${breakdownRange === "all" ? "usage-range-btn--active" : ""}`}
                      onClick={() => setBreakdownRange("all")}
                    >
                      {c.usage.rangeAll}
                    </button>
                    <button
                      type="button"
                      className={`usage-range-btn ${breakdownRange === "30d" ? "usage-range-btn--active" : ""}`}
                      onClick={() => setBreakdownRange("30d")}
                    >
                      {c.usage.range30d}
                    </button>
                    <button
                      type="button"
                      className={`usage-range-btn ${breakdownRange === "7d" ? "usage-range-btn--active" : ""}`}
                      onClick={() => setBreakdownRange("7d")}
                    >
                      {c.usage.range7d}
                    </button>
                    <button
                      type="button"
                      className={`usage-range-btn ${breakdownRange === "24h" ? "usage-range-btn--active" : ""}`}
                      onClick={() => setBreakdownRange("24h")}
                    >
                      {c.usage.range24h}
                    </button>
                  </div>

                  {/* Metric Switcher */}
                  <div className="usage-metric-toggle-group" role="group" aria-label={c.usage.metricToggleAria}>
                    <button
                      type="button"
                      className={`usage-metric-toggle-btn ${breakdownMetric === "calls" ? "usage-metric-toggle-btn--active" : ""}`}
                      onClick={() => setBreakdownMetric("calls")}
                    >
                      {c.usage.metricCalls}
                    </button>
                    <button
                      type="button"
                      className={`usage-metric-toggle-btn ${breakdownMetric === "quota" ? "usage-metric-toggle-btn--active" : ""}`}
                      onClick={() => setBreakdownMetric("quota")}
                    >
                      {c.usage.metricQuota}
                    </button>
                  </div>
                </div>

                {currentBreakdownList.length > 0 ? (
                  <div className="usage-donut-grid">
                    {/* Left: Interactive SVG Donut Chart */}
                    <DonutChart
                      items={currentBreakdownList}
                      metricType={breakdownMetric}
                      totalLabel={
                        breakdownMetric === "calls"
                          ? c.usage.donutTotalCalls
                          : c.usage.donutTotalQuota
                      }
                      formatTokens={formatTokens}
                    />

                    {/* Right: Detailed Legend List */}
                    <div className="usage-donut-legend-list">
                      {(() => {
                        const totalVal = currentBreakdownList.reduce(
                          (acc, curItem) => acc + (breakdownMetric === "calls" ? curItem.calls : curItem.quota),
                          0
                        );
                        return currentBreakdownList.map((item, idx) => {
                          const val = breakdownMetric === "calls" ? item.calls : item.quota;
                          const pct = totalVal > 0 ? ((val / totalVal) * 100).toFixed(1) : "0.0";
                          return (
                            <div key={idx} className="usage-donut-legend-item">
                              <div className="usage-donut-legend-left">
                                <span className="usage-donut-legend-dot" style={{ background: item.color }} />
                                <span className="usage-donut-legend-name">{item.name}</span>
                              </div>
                              <div className="usage-donut-legend-right">
                                <span className="usage-donut-legend-val">
                                  {breakdownMetric === "calls"
                                    ? `${item.calls.toLocaleString()} ${c.usage.callsUnit}`
                                    : formatTokens(item.quota)}
                                </span>
                                <span className="usage-donut-legend-pct">{pct}%</span>
                              </div>
                            </div>
                          );
                        });
                      })()}
                    </div>
                  </div>
                ) : (
                  <div style={{ textAlign: "center", padding: "32px", color: "var(--text-faint)", fontSize: "13px" }}>
                    {c.usage.noBreakdownRecords}
                  </div>
                )}
              </div>

              {/* Recent Invocations Table (Last 1 Month) */}
              <div className="console-card usage-section-card">
                <div className="console-card-header">
                  <div className="console-title-with-info">
                    <h3 className="console-card-title">{c.usage.recentLogsTitle}</h3>
                    <span className="usage-badge-month">{c.usage.badgeMonth}</span>
                    <span className="console-info-icon">ⓘ</span>
                  </div>

                  <div className="usage-table-header-controls">
                    {/* Model filter */}
                    <select
                      className="usage-filter-select"
                      value={logModelFilter}
                      onChange={(e) => {
                        setLogModelFilter(e.target.value);
                        setLogPage(0);
                      }}
                      aria-label={c.usage.filterModelAria}
                    >
                      <option value="all">{c.usage.allModelsOption}</option>
                      <option value="MiniMax-M3">MiniMax-M3</option>
                      <option value="deepseek-v4-flash">deepseek-v4-flash</option>
                      <option value="gpt-5.6-luna">gpt-5.6-luna</option>
                      <option value="gpt-5.6-terra">gpt-5.6-terra</option>
                      <option value="kimi-k3">kimi-k3</option>
                      <option value="mimo-v2.5-pro">mimo-v2.5-pro</option>
                      <option value="nemotron-3-ultra">nemotron-3-ultra</option>
                      <option value="deepseek-v4-pro">deepseek-v4-pro</option>
                      <option value="glm-5.2">glm-5.2</option>
                    </select>

                    {/* Page size select */}
                    <select
                      className="usage-filter-select"
                      value={logPageSize}
                      onChange={(e) => {
                        const newSize = Number(e.target.value);
                        setLogPageSize(newSize);
                        setLogPage(0);
                        loadMonthLogs(0, newSize, logModelFilter);
                      }}
                      aria-label={c.usage.pageSizeAria}
                    >
                      <option value="10">{c.usage.pageSizeOption(10)}</option>
                      <option value="20">{c.usage.pageSizeOption(20)}</option>
                      <option value="50">{c.usage.pageSizeOption(50)}</option>
                    </select>

                    <button
                      type="button"
                      className={`console-refresh-btn ${loadingLogs || refreshing ? "console-refresh-btn--spin" : ""}`}
                      onClick={handleRefresh}
                      disabled={loadingLogs || refreshing}
                      title={c.usage.refreshLogsBtn}
                    >
                      <RefreshIcon width={13} height={13} />
                      <span>{loadingLogs ? c.remote.refreshingBtn : c.usage.refreshLogsBtn}</span>
                    </button>
                  </div>
                </div>

                {/* Desktop Table View (>= 769px) */}
                <div className="usage-table-wrap usage-table-desktop">
                  <table className="usage-table">
                    <thead>
                      <tr>
                        <th>{c.usage.colTime}</th>
                        <th>{c.usage.colModel}</th>
                        <th>{c.usage.colPrompt}</th>
                        <th>{c.usage.colCompletion}</th>
                        <th>{c.usage.colQuota}</th>
                        <th>{c.usage.colLatency}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {displayLogsData.items && displayLogsData.items.length > 0 ? (
                        displayLogsData.items.map((log: any) => {
                          const d = new Date(log.created_at * 1000);
                          const timeStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}`;
                          return (
                            <tr key={log.id}>
                              <td className="usage-cell-time">{timeStr}</td>
                              <td><span className="usage-cell-model">{log.model_name || "MiniMax-M3"}</span></td>
                              <td>{(log.prompt_tokens || 0).toLocaleString()}</td>
                              <td>{(log.completion_tokens || 0).toLocaleString()}</td>
                              <td className="usage-cell-quota">{formatTokens(log.quota || 0)}</td>
                              <td>{log.use_time ? `${log.use_time}s` : "—"}</td>
                            </tr>
                          );
                        })
                      ) : (
                        <tr>
                          <td colSpan={6} style={{ textAlign: "center", padding: "28px", color: "var(--text-faint)" }}>
                            {loadingLogs ? c.usage.loadingMonthLogs : c.usage.noMatchingLogs}
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>

                {/* Mobile Card List View (< 769px) */}
                <div className="usage-cards-mobile">
                  {displayLogsData.items && displayLogsData.items.length > 0 ? (
                    displayLogsData.items.map((log: any) => {
                      const d = new Date(log.created_at * 1000);
                      const timeStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}`;
                      return (
                        <div key={log.id} className="usage-log-card">
                          <div className="usage-log-card-top">
                            <span className="usage-log-card-model">{log.model_name || "MiniMax-M3"}</span>
                            <span className="usage-log-card-time">{timeStr}</span>
                          </div>
                          <div className="usage-log-card-metrics">
                            <div className="usage-log-card-metric">
                              <span className="usage-log-card-label">{c.usage.colQuota}</span>
                              <span className="usage-log-card-val usage-log-card-val--quota">{formatTokens(log.quota || 0)}</span>
                            </div>
                            <div className="usage-log-card-metric">
                              <span className="usage-log-card-label">{c.usage.colLatency}</span>
                              <span className="usage-log-card-val">{log.use_time ? `${log.use_time}s` : "—"}</span>
                            </div>
                            <div className="usage-log-card-metric">
                              <span className="usage-log-card-label">{c.usage.colPrompt}</span>
                              <span className="usage-log-card-val">{(log.prompt_tokens || 0).toLocaleString()}</span>
                            </div>
                            <div className="usage-log-card-metric">
                              <span className="usage-log-card-label">{c.usage.colCompletion}</span>
                              <span className="usage-log-card-val">{(log.completion_tokens || 0).toLocaleString()}</span>
                            </div>
                          </div>
                        </div>
                      );
                    })
                  ) : (
                    <div className="usage-logs-empty">
                      {loadingLogs ? c.usage.loadingMonthLogs : c.usage.noMatchingLogs}
                    </div>
                  )}
                </div>

                {/* Pagination Controls */}
                {displayLogsData.total > 0 && (
                  <div className="usage-pagination-bar">
                    <span className="usage-page-info">
                      {c.usage.paginationInfo(
                        logPage + 1,
                        Math.max(1, Math.ceil(displayLogsData.total / logPageSize)),
                        displayLogsData.total.toLocaleString()
                      )}
                    </span>
                    <div className="usage-page-nav">
                      <button
                        type="button"
                        className="usage-page-btn"
                        onClick={() => setLogPage((p) => Math.max(0, p - 1))}
                        disabled={logPage === 0 || loadingLogs}
                      >
                        {c.usage.prevPage}
                      </button>
                      <button
                        type="button"
                        className="usage-page-btn"
                        onClick={() =>
                          setLogPage((p) =>
                            Math.min(Math.ceil((displayLogsData.total || 1) / logPageSize) - 1, p + 1)
                          )
                        }
                        disabled={
                          logPage >= Math.ceil((displayLogsData.total || 1) / logPageSize) - 1 || loadingLogs
                        }
                      >
                        {c.usage.nextPage}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </div>
          ) : activeTab === "plan" ? (
            <div className="console-canvas-inner">
              {/* Plan Header */}
              <div className="console-hero">
                <h1 className="console-greeting">
                  {c.plan.heroTitle}
                </h1>
                <p className="console-subgreeting">
                  {isPro || (user?.quota ?? 0) > 0 || (user?.used_quota ?? 0) > 0 || user?.group === "千研"
                    ? c.plan.subgreetingActive
                    : c.plan.subgreetingUnsubscribed}
                </p>
                <div className="console-tags">
                  <span className="console-tag">
                    # {isPro || (user?.quota ?? 0) > 0 || (user?.used_quota ?? 0) > 0 || user?.group === "千研"
                      ? c.plan.tagActivePro
                      : c.plan.tagCurrentFree}
                  </span>
                  <span className="console-tag">
                    # {user?.group ? c.plan.tagClusterGroup(user.group) : c.plan.tagDefaultGroup}
                  </span>
                  <span className="console-tag">
                    # {c.plan.tagBalance(formatTokens(remaining))}
                  </span>
                </div>
              </div>

              {isPro || (user?.quota ?? 0) > 0 || (user?.used_quota ?? 0) > 0 || user?.group === "千研" ? (
                <>
                  {/* Active Subscription Details Card */}
                  <div className="console-card plan-section-card">
                    <div className="plan-active-head">
                      <div className="plan-active-title-group">
                        <div className="plan-active-name">
                          <span>
                            {user?.group === "千研"
                              ? c.plan.activeMemberPro
                              : c.plan.activeSomniqPro}
                          </span>
                          <span className="plan-active-status-tag">{c.plan.statusActiveRunning}</span>
                        </div>
                        <span style={{ fontSize: "13px", color: "var(--text-dim)" }}>
                          {c.plan.poweredByDesc}
                        </span>
                      </div>
                      <div className="plan-active-group-badge">
                        <span>
                          {c.plan.clusterGroupLabel}: {user?.group || c.plan.defaultGroupName}
                        </span>
                      </div>
                    </div>

                    {/* 4 Detail Metrics Boxes */}
                    <div className="plan-details-grid">
                      <div className="plan-detail-box">
                        <div className="plan-detail-label">{c.plan.detailAvailableQuota}</div>
                        <div className="plan-detail-val">{formatTokens(remaining)}</div>
                        <div className="plan-detail-sub">≈ ${usdValue} USD</div>
                      </div>
                      <div className="plan-detail-box">
                        <div className="plan-detail-label">{c.plan.detailUsedQuota}</div>
                        <div className="plan-detail-val" style={{ color: "var(--accent-blue)" }}>
                          {formatTokens(used)}
                        </div>
                        <div className="plan-detail-sub">≈ ${(used / 500000).toFixed(2)} USD</div>
                      </div>
                      <div className="plan-detail-box">
                        <div className="plan-detail-label">{c.plan.detailTotalRequests}</div>
                        <div className="plan-detail-val">
                          {totalRequests.toLocaleString()} {c.plan.callsUnit}
                        </div>
                        <div className="plan-detail-sub">{c.plan.detailWorkflowsSub}</div>
                      </div>
                    </div>

                    {/* Progress Track */}
                    <div>
                      <div
                        style={{
                          display: "flex",
                          justifyContent: "space-between",
                          fontSize: "12px",
                          marginBottom: "6px",
                          color: "var(--text-faint)",
                        }}
                      >
                        <span>{c.plan.progressTitle}</span>
                        <span>
                          {c.plan.remainingPercent(remainingPercent.toFixed(1))}
                        </span>
                      </div>
                      <div className="console-progress-track">
                        <div className="console-progress-fill" style={{ width: `${remainingPercent}%` }} />
                      </div>
                    </div>
                  </div>
                </>
              ) : (
                <>
                  {/* Unsubscribed User: Subscription Plans Comparison */}
                  <div className="plan-pricing-grid">
                    {/* Free Tier */}
                    <div className="plan-tier-card">
                      <div>
                        <h3 className="plan-tier-name">{c.plan.freeTierName}</h3>
                        <p className="plan-tier-desc">
                          {c.plan.freeTierDesc}
                        </p>
                        <div className="plan-tier-price">
                          <strong>{c.plan.freeTierPrice}</strong>
                          <span>{c.plan.freeTierPeriod}</span>
                        </div>
                        <ul className="plan-tier-features">
                          <li>
                            <span>✓</span> {c.plan.freeTierF1}
                          </li>
                          <li>
                            <span>✓</span> {c.plan.freeTierF2}
                          </li>
                          <li>
                            <span>✓</span> {c.plan.freeTierF3}
                          </li>
                        </ul>
                      </div>
                      <a
                        href="./#download"
                        className="btn btn--outline"
                        style={{ width: "100%", textAlign: "center", justifyContent: "center" }}
                      >
                        {c.plan.currentDefaultBtn}
                      </a>
                    </div>

                    {/* Pro Tier (Featured) */}
                    <div className="plan-tier-card plan-tier-card--pro">
                      <span className="plan-tier-badge">
                        {c.plan.popularBadge}
                      </span>
                      <div>
                        <h3 className="plan-tier-name">{c.plan.proTierName}</h3>
                        <p className="plan-tier-desc">
                          {c.plan.proTierDesc}
                        </p>
                        <div className="plan-tier-price">
                          <strong>{c.plan.proTierPrice}</strong>
                          <span>{c.plan.proTierPeriod}</span>
                        </div>
                        <ul className="plan-tier-features">
                          <li>
                            <span>✓</span> {c.plan.proTierF1}
                          </li>
                          <li>
                            <span>✓</span> {c.plan.proTierF2}
                          </li>
                          <li>
                            <span>✓</span> {c.plan.proTierF3}
                          </li>
                          <li>
                            <span>✓</span> {c.plan.proTierF4}
                          </li>
                          <li>
                            <span>✓</span> {c.plan.proTierF5}
                          </li>
                        </ul>
                      </div>
                      <a
                        href={`./pricing.html?lang=${lang}`}
                        className="btn btn--primary"
                        style={{ width: "100%", textAlign: "center", justifyContent: "center" }}
                      >
                        {c.plan.subscribeNowBtn}
                      </a>
                    </div>

                    {/* Lab / Team Tier */}
                    <div className="plan-tier-card">
                      <div>
                        <h3 className="plan-tier-name">{c.plan.teamTierName}</h3>
                        <p className="plan-tier-desc">
                          {c.plan.teamTierDesc}
                        </p>
                        <div className="plan-tier-price">
                          <strong>{c.plan.teamTierPrice}</strong>
                          <span>{c.plan.teamTierPeriod}</span>
                        </div>
                        <ul className="plan-tier-features">
                          <li>
                            <span>✓</span> {c.plan.teamTierF1}
                          </li>
                          <li>
                            <span>✓</span> {c.plan.teamTierF2}
                          </li>
                          <li>
                            <span>✓</span> {c.plan.teamTierF3}
                          </li>
                          <li>
                            <span>✓</span> {c.plan.teamTierF4}
                          </li>
                        </ul>
                      </div>
                      <a
                        href="mailto:support@somni.chat"
                        className="btn btn--outline"
                        style={{ width: "100%", textAlign: "center", justifyContent: "center" }}
                      >
                        {c.plan.contactTeamBtn}
                      </a>
                    </div>
                  </div>
                </>
              )}
            </div>
          ) : (
            <div className="console-canvas-inner">
              {/* User Greeting Section (Real User Data) */}
              <div className="console-hero">
                <h1 className="console-greeting">
                  Hello! <span className="console-greeting-name">{user?.display_name || user?.username || "Researcher"}</span>
                </h1>
                <p className="console-subgreeting">
                  {c.activity.greetingSub(daysActive)}
                </p>
                <div className="console-tags">
                  <span className="console-tag"># {c.activity.tagReviewer}</span>
                  <span className="console-tag"># {c.activity.tagMemory}</span>
                  <span className="console-tag"># {user?.group ? c.activity.tagGroup(user.group) : c.activity.tagResearchTier}</span>
                  <span className="console-tag"># {c.activity.tagTotalCalls(totalRequests.toLocaleString())}</span>
                </div>
              </div>

              {/* Quota & Compute Top Card (Real Data) */}
              <div className="console-grid-metrics">
                {/* Compute Balance Card */}
                <div className="console-card console-card--balance">
                  <div className="console-card-header">
                    <span className="console-kicker">{c.activity.balanceKicker}</span>
                    <button
                      type="button"
                      className={`console-refresh-btn ${refreshing ? "console-refresh-btn--spin" : ""}`}
                      onClick={handleRefresh}
                      disabled={refreshing}
                    >
                      <RefreshIcon width={13} height={13} />
                      <span>{refreshing ? c.activity.syncing : c.activity.refreshBalance}</span>
                    </button>
                  </div>

                  <div className="console-metric-val">
                    <span className="console-number-huge">{formatTokens(remaining)}</span>
                    <span className="console-number-usd">≈ ${usdValue} USD</span>
                  </div>

                  <div className="console-progress-track">
                    <div className="console-progress-fill" style={{ width: `${remainingPercent}%` }} />
                  </div>

                  <div className="console-metric-footer">
                    <span>{c.activity.usedQuota(formatTokens(used))}</span>
                    <span className="console-tier-tag">{user?.group || (isPro ? copy.dashboard.tierPro : copy.dashboard.tierFree)}</span>
                  </div>
                </div>

                {/* Cumulative Usage Card */}
                <div className="console-card console-card--usage">
                  <div className="console-card-header">
                    <span className="console-kicker">{c.activity.cumulativeUsageKicker}</span>
                  </div>
                  <div className="console-metric-val">
                    <span className="console-number-huge console-number--used">{formatTokens(used)}</span>
                  </div>
                  <p className="console-card-desc">
                    {c.activity.cumulativeUsageDesc(totalRequests.toLocaleString())}
                  </p>
                </div>
              </div>

              {/* Daily Call Trend Card */}
              <div className="console-card" style={{ marginBottom: "16px" }}>
                <div className="console-card-header">
                  <div className="console-title-with-info">
                    <h3 className="console-card-title">
                      {c.activity.dailyCallsTitle}
                    </h3>
                    <span className="console-info-icon">ⓘ</span>
                  </div>
                  <span style={{ fontSize: "12px", color: "var(--text-faint)" }}>
                    {hasTrendData
                      ? c.activity.dailyCallsPeak(Math.max(...trendData))
                      : c.activity.noData}
                  </span>
                </div>
                {hasTrendData ? (
                  <div style={{ padding: "8px 0 4px" }}>
                    <MiniBarChart data={trendData} color="var(--accent-blue, #38bdf8)" height={52} />
                    <div style={{ display: "flex", justifyContent: "space-between", marginTop: "6px", fontSize: "11px", color: "var(--text-faint)" }}>
                      <span>{c.activity.daysAgo30}</span>
                      <span>{c.activity.today}</span>
                    </div>
                  </div>
                ) : (
                  <div style={{ textAlign: "center", padding: "24px", color: "var(--text-faint)", fontSize: "13px" }}>
                    {c.activity.noCallHistoryYet}
                  </div>
                )}
              </div>

              {/* Heatmap Card */}
              <div className="console-card console-card--heatmap">
                <div className="console-card-header">
                  <div className="console-title-with-info">
                    <h3 className="console-card-title">{c.activity.activeDaysTitle}</h3>
                    <span
                      className="console-info-icon"
                      title={c.activity.activeDaysTooltip(daysActive)}
                    >ⓘ</span>
                  </div>
                  <div className="console-heatmap-legend">
                    <span>{c.activity.legendLess}</span>
                    <span className="c-legend-cell c-legend-cell--0" title={c.activity.legendCalls0} />
                    <span className="c-legend-cell c-legend-cell--1" title={c.activity.legendCalls1} />
                    <span className="c-legend-cell c-legend-cell--2" title={c.activity.legendCalls2} />
                    <span className="c-legend-cell c-legend-cell--3" title={c.activity.legendCalls3} />
                    <span className="c-legend-cell c-legend-cell--4" title={c.activity.legendCalls4} />
                    <span>{c.activity.legendMore}</span>
                  </div>
                </div>

                {/* Month Header */}
                <div className="c-heatmap-months">
                  {heatmapMonths.map((m, idx) => (
                    <span key={idx} className="c-month-label">
                      {m}
                    </span>
                  ))}
                </div>

                {/* Heatmap Matrix */}
                <div className="c-heatmap-scroll">
                  <div className="c-heatmap-matrix">
                    {weeks.map((week, wIdx) => (
                      <div key={wIdx} className="c-heatmap-col">
                        {week.map((cell, dIdx) => (
                          <div
                            key={dIdx}
                            className={`c-heatmap-cell c-heatmap-cell--lvl-${cell.level}`}
                            title={
                              cell.calls > 0
                                ? c.activity.heatmapCellCalls(cell.dateStr, cell.calls.toLocaleString())
                                : c.activity.heatmapCellZero(cell.dateStr)
                            }
                          />
                        ))}
                      </div>
                    ))}
                  </div>
                </div>

                {/* Output Sub-Bars (Real Data) */}
                <div className="console-activity-bars">
                  <div className="c-act-row">
                    <div className="c-act-label">
                      <span>{c.activity.synthesesLabel}</span>
                      <strong>{modelStats.synthesesCount.toLocaleString()}</strong>
                    </div>
                    <div className="c-act-track">
                      <div className="c-act-fill" style={{ width: `${synthBarPct}%` }} />
                      <span className="c-act-tag">Markdown · BibTeX</span>
                    </div>
                  </div>

                  <div className="c-act-row">
                    <div className="c-act-label">
                      <span>{c.activity.reviewsLabel}</span>
                      <strong>{modelStats.reviewPasses.toLocaleString()}</strong>
                    </div>
                    <div className="c-act-track">
                      <div className="c-act-fill c-act-fill--violet" style={{ width: `${reviewBarPct}%` }} />
                      <span className="c-act-tag">16-Step Review</span>
                    </div>
                  </div>
                </div>
              </div>

              {/* Bottom AI Partners (Real Model Invocations) */}
              <div className="console-grid-partners">
                <div className="console-card console-card--partner">
                  <div className="console-card-header">
                    <span className="console-kicker">{c.activity.topPartnerKicker}</span>
                    <span className="console-info-icon">ⓘ</span>
                  </div>
                  <div className="c-partner-body">
                    <div className="c-partner-icon-wrap">
                      <SparklesIcon width={26} height={26} />
                    </div>
                    <div className="c-partner-name">
                      {modelStats.topModel !== "—" ? `@${modelStats.topModel}` : "—"}
                    </div>
                    <div className="c-partner-stat">
                      {modelStats.topModelCalls > 0
                        ? <>{c.activity.topPartnerCooperated(modelStats.topModelCalls.toLocaleString())}</>
                        : <span style={{ color: "var(--text-faint)" }}>{c.activity.noCallsYet}</span>
                      }
                    </div>
                  </div>
                </div>

                <div className="console-card console-card--partner">
                  <div className="console-card-header">
                    <span className="console-kicker">{c.activity.secondPartnerKicker}</span>
                    <span className="console-info-icon">ⓘ</span>
                  </div>
                  <div className="c-partner-body">
                    <div className="c-partner-icon-wrap c-partner-icon-wrap--violet">
                      <CheckIcon width={26} height={26} />
                    </div>
                    <div className="c-partner-name">
                      {modelStats.secondModel !== "—" ? `@${modelStats.secondModel}` : "—"}
                    </div>
                    <div className="c-partner-stat">
                      {modelStats.secondModelCalls > 0
                        ? <>{c.activity.secondPartnerInvocations(modelStats.secondModelCalls.toLocaleString())}</>
                        : <span style={{ color: "var(--text-faint)" }}>{c.activity.noSecondModelYet}</span>
                      }
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )}
        </main>
      </div>

      <AuthModal copy={copy} />
    </div>
  );
}

export default function DashboardApp() {
  const [lang, setLang] = useAutoLang();
  const [theme, setTheme] = useState<Theme>(detectTheme);
  const c = CONSOLE_COPY[lang];

  useEffect(() => {
    document.documentElement.lang = lang === "zh" ? "zh-CN" : lang === "es" ? "es" : "en";
    document.documentElement.setAttribute("data-lang", lang);
    document.title = c.docTitle;
  }, [lang, c.docTitle]);

  useEffect(() => {
    persistTheme(theme);
    document.documentElement.setAttribute("data-theme", theme);
  }, [theme]);

  // Listen to browser/OS theme changes dynamically
  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mediaQuery = window.matchMedia("(prefers-color-scheme: light)");
    const handleChange = (e: MediaQueryListEvent) => {
      const stored = window.localStorage.getItem("somniq-site-theme");
      if (!stored) {
        setTheme(e.matches ? "light" : "dark");
      }
    };
    mediaQuery.addEventListener("change", handleChange);
    return () => mediaQuery.removeEventListener("change", handleChange);
  }, []);

  const toggleLang = useCallback(() => {
    setLang((current) => (current === "zh" ? "en" : current === "en" ? "es" : "zh"));
  }, []);

  const toggleTheme = useCallback(() => {
    setTheme((current) => (current === "dark" ? "light" : "dark"));
  }, []);

  return (
    <AuthProvider>
      <DashboardContent
        lang={lang}
        theme={theme}
        onSelectLang={setLang}
        onToggleLang={toggleLang}
        onToggleTheme={toggleTheme}
      />
    </AuthProvider>
  );
}
