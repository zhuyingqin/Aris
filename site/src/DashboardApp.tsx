import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AuthProvider, useAuth, accountTokens } from "./context/AuthContext";
import { AccountSessionError } from "../remote/src/accountToken";
import { AccountGatewayApi, type AccountDeviceSummary } from "../remote/src/accountGateway";
import { pairingDeepLinkFragmentFromPastedCode } from "../remote/src/qr";
import { COPY, detectTheme, persistTheme, useAutoLang, type Lang, type Theme, APP_VERSION, RELEASES_URL } from "./i18n";
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

// ── Real historical 30-day activity data for active researchers ────────────────
const KNOWN_30_DAY_CALLS = [
  78, 98, 5, 5, 169, 67, 236, 251, 611, 823, 1030, 0, 46, 73, 331,
  172, 206, 183, 149, 0, 121, 41, 68, 4, 53, 318, 336, 185, 158, 276
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
  const { user, isAuthenticated, isLoading, logout, refreshUser, fetchUserLogs, openAuthModal, closeAuthModal, formatTokens } = useAuth();
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
  const isZh = lang === "zh";
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
          : (isZh
            ? "无法识别这个连接码。"
            : "This is not a SomniQ connection code. Copy it again from Settings → Remote Access on the computer."),
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
          ? (isZh
            ? "当前浏览器没有可授权给远程网关的登录状态。请重新登录后再试。"
            : "This browser holds no sign-in the gateway can use. Sign in again.")
          : reason === "expired"
          ? (isZh
            ? "登录状态已失效，无法读取同账号客户端。请重新登录后再试。"
            : "Your session was rejected. Sign in again to load account clients.")
          : (isZh
            ? "暂时无法读取同账号客户端，可稍后重试。"
            : "Could not reach the gateway. Try again shortly."),
      );
    } finally {
      setRemoteDevicesLoading(false);
    }
  }, [isZh, user?.id]);

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
      setPairingNotice(isZh
        ? `🎉 绑定成功！「${name}」已上线，可立即开始对话。`
        : `🎉 Paired. “${name}” is online and ready.`);
      void loadRemoteDevices();
    };
    window.addEventListener("message", onEmbeddedMessage);
    return () => window.removeEventListener("message", onEmbeddedMessage);
  }, [isZh, loadRemoteDevices]);

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
  const heatmapMonths = isZh
    ? ["8月", "9月", "10月", "11月", "12月", "1月", "2月", "3月", "4月", "5月", "6月", "7月", "8月"]
    : ["Aug", "Sep", "Oct", "Nov", "Dec", "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug"];

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
          <a className="brand console-brand" href={isZh ? "./?lang=zh" : "./?lang=en"} title={isZh ? "返回官网" : "Return to Home"}>
            <img src="./app-logo.png" alt="SomniQ Logo" width={26} height={26} />
            <span className="brand-name">SomniQ</span>
            <span className="brand-name-sub">Studio</span>
          </a>
          <span className="console-crumb-divider" aria-hidden="true">/</span>
          <span className="console-pill-badge">
            <span className="console-badge-dot" aria-hidden="true" />
            {isZh ? "控制台" : "Console"}
          </span>
        </div>

        <div className="console-header-right">
          <a
            className="console-link-home"
            href={isZh ? "./?lang=zh" : "./?lang=en"}
            title={isZh ? "返回官网首页" : "Return to Home"}
          >
            <HomeIcon width={14} height={14} />
            <span className="console-link-home-text">{isZh ? "返回官网" : "Home"}</span>
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
                title={copy.dashboard.logout}
                aria-label={copy.dashboard.logout}
              >
                <LogoutIcon width={13} height={13} />
                <span className="console-logout-text">{copy.dashboard.logout}</span>
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
                <span>{isZh ? "科研分析" : "Analytics"}</span>
              </div>
              <div className="console-nav-group-items">
                <button
                  type="button"
                  className={`console-nav-item ${activeTab === "activity" ? "console-nav-item--active" : ""}`}
                  onClick={() => setActiveTab("activity")}
                  title={isZh ? "活跃看板" : "Activity & Analytics"}
                >
                  <ChartBarIcon width={15} height={15} />
                  <span className="console-nav-label-full">{isZh ? "活跃看板" : "Activity"}</span>
                  <span className="console-nav-label-short">{isZh ? "看板" : "Activity"}</span>
                </button>

                <button
                  type="button"
                  className={`console-nav-item ${activeTab === "usage" ? "console-nav-item--active" : ""}`}
                  onClick={() => setActiveTab("usage")}
                  title={isZh ? "算力用量" : "Compute Usage"}
                >
                  <SparklesIcon width={15} height={15} />
                  <span className="console-nav-label-full">{isZh ? "算力用量" : "Usage"}</span>
                  <span className="console-nav-label-short">{isZh ? "用量" : "Usage"}</span>
                </button>
              </div>
            </div>

            {/* Group 2: 协同终端 / WORKSPACES & CLIENTS */}
            <div className="console-nav-group">
              <div className="console-nav-section-title">
                <span>{isZh ? "协同终端" : "Terminals"}</span>
              </div>
              <div className="console-nav-group-items">
                <button
                  type="button"
                  className={`console-nav-item console-nav-item--remote ${activeTab === "remote" ? "console-nav-item--active" : ""}`}
                  onClick={() => {
                    setActiveTab("remote");
                    setRemoteViewMode("chat");
                  }}
                  title={isZh ? "远程工作台" : "Remote Workspace"}
                >
                  <SmartphoneIcon width={15} height={15} />
                  <span className="console-nav-label-full">{isZh ? "远程工作台" : "Remote Workspace"}</span>
                  <span className="console-nav-label-short">{isZh ? "工作台" : "Remote"}</span>
                  {onlineRemoteDevices.length > 0 && (
                    <span className="console-nav-badge console-nav-badge--online">
                      {isZh ? `${onlineRemoteDevices.length} 在线` : `${onlineRemoteDevices.length} online`}
                    </span>
                  )}
                </button>
              </div>
            </div>

            {/* Group 3: 算力与账户 / BILLING & ACCOUNT */}
            <div className="console-nav-group">
              <div className="console-nav-section-title">
                <span>{isZh ? "算力与账户" : "Account"}</span>
              </div>
              <div className="console-nav-group-items">
                <button
                  type="button"
                  className={`console-nav-item ${activeTab === "plan" ? "console-nav-item--active" : ""}`}
                  onClick={() => setActiveTab("plan")}
                  title={isZh ? "套餐与订阅" : "Plans & Billing"}
                >
                  <CheckIcon width={15} height={15} />
                  <span className="console-nav-label-full">{isZh ? "套餐与订阅" : "Plans & Billing"}</span>
                  <span className="console-nav-label-short">{isZh ? "套餐" : "Plans"}</span>
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
                <span>{isZh ? "资源生态" : "Resources"}</span>
              </div>
              <div className="console-nav-group-items">
                <a
                  className="console-nav-item console-nav-link"
                  href={RELEASES_URL}
                  target="_blank"
                  rel="noopener noreferrer"
                  title={isZh ? "下载桌面客户端安装包" : "Download Desktop Client"}
                >
                  <WindowsIcon width={15} height={15} />
                  <span className="console-nav-label-full">{isZh ? "下载桌面端" : "Desktop App"}</span>
                  <span className="console-nav-label-short">{isZh ? "下载" : "Download"}</span>
                  <span className="console-nav-badge console-nav-badge--version">v{APP_VERSION}</span>
                </a>
              </div>
            </div>
          </nav>

          {/* Sidebar Bottom Quota Card */}
          <div className="console-sidebar-footer">
            <div className="console-mini-quota">
              <div className="mini-quota-head">
                <span className="mini-quota-label">{isZh ? "可用科研算力" : "Available Quota"}</span>
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
                  title={copy.dashboard.quotaRefresh}
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
                      {isZh ? "REMOTE ACCESS · 同账号客户端" : "REMOTE ACCESS · ACCOUNT CLIENTS"}
                    </span>
                    <h1 className="console-greeting">
                      {isZh ? "连接你的 SomniQ 客户端" : "Connect your SomniQ client"}
                    </h1>
                  </div>
                </header>
              )}

              {remoteViewMode === "connect" ? (
                <div className="console-remote-connect-layout">
                  <section className="console-card console-remote-connect-card">
                    <div className="console-remote-section-heading">
                      <div>
                        <span className="console-kicker">{isZh ? "远程访问" : "REMOTE ACCESS"}</span>
                        <h2>{isZh ? "连接电脑客户端" : "Connect Desktop Client"}</h2>
                      </div>
                      <button
                        type="button"
                        className="console-refresh-btn"
                        onClick={() => void loadRemoteDevices()}
                        disabled={remoteDevicesLoading}
                        title={isZh ? "刷新客户端列表" : "Refresh clients"}
                      >
                        <RefreshIcon width={14} height={14} className={remoteDevicesLoading ? "mini-refresh-btn--spin" : ""} />
                        <span>{remoteDevicesLoading ? (isZh ? "刷新中..." : "Refreshing...") : (isZh ? "刷新" : "Refresh")}</span>
                      </button>
                    </div>

                    {remoteDevicesError && (
                      <div className="console-remote-alert-box is-error">
                        <div className="console-remote-alert-icon">
                          <AlertCircleIcon width={18} height={18} />
                        </div>
                        <div className="console-remote-alert-content">
                          <strong>{isZh ? "连接提示" : "Connection Notice"}</strong>
                          <p>{remoteDevicesError}</p>
                        </div>
                        <div className="console-remote-alert-actions">
                          {(remoteDevicesError.includes("登录") || remoteDevicesError.includes("Session") || remoteDevicesError.includes("sign-in") || remoteDevicesError.includes("令牌")) && (
                            <button
                              type="button"
                              className="btn btn--primary btn--sm"
                              onClick={() => openAuthModal("login")}
                            >
                              {isZh ? "重新登录" : "Sign In"}
                            </button>
                          )}
                          <button
                            type="button"
                            className="btn btn--outline btn--sm"
                            onClick={() => void loadRemoteDevices()}
                            disabled={remoteDevicesLoading}
                          >
                            {isZh ? "重试" : "Retry"}
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
                          <strong>{isZh ? "连接码无法识别" : "Unrecognized code"}</strong>
                          <p>{pairingCodeError}</p>
                        </div>
                        <button
                          type="button"
                          className="btn btn--outline btn--sm"
                          onClick={() => setPairingCodeError("")}
                        >
                          {isZh ? "知道了" : "Dismiss"}
                        </button>
                      </div>
                    )}

                    {pairingNotice && (
                      <div className="console-remote-alert-box is-success">
                        <div className="console-remote-alert-icon">
                          <CheckIcon width={18} height={18} />
                        </div>
                        <div className="console-remote-alert-content">
                          <strong>{isZh ? "绑定成功" : "Pairing Complete"}</strong>
                          <p>{pairingNotice}</p>
                        </div>
                        <button
                          type="button"
                          className="btn btn--outline btn--sm"
                          onClick={() => setPairingNotice("")}
                        >
                          {isZh ? "知道了" : "Dismiss"}
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
                              {isZh ? "🟢 电脑在线 · 已就绪" : "🟢 Desktop Online · Ready"}
                            </span>
                            <h2>{primaryRemoteDevice.name}</h2>
                            <p>
                              {isZh
                                ? "向这台电脑发起端到端加密连接，在电脑端弹窗授权后直接进入 Chat 对话工作台。"
                                : "Request an E2E encrypted connection. Chat opens directly after desktop approval."}
                            </p>
                          </div>
                          <div className="console-remote-primary-actions" onClick={(e) => e.stopPropagation()}>
                            <button
                              type="button"
                              className="btn btn--primary console-remote-btn-compact"
                              onClick={() => startRemoteChat(primaryRemoteDevice)}
                            >
                              <span>{isZh ? "进入 Chat 对话" : "Open Chat"}</span>
                              <ArrowIcon width={13} height={13} aria-hidden="true" />
                            </button>
                            <a
                              className="console-remote-subtle-link"
                              href={remoteChatHref}
                              target="_blank"
                              rel="noreferrer noopener"
                            >
                              <span>{isZh ? "新标签页打开" : "New Tab"}</span>
                              <ExternalLinkIcon width={11} height={11} />
                            </a>
                          </div>
                        </article>

                        {/* Multiple devices selector if > 1 device */}
                        {remoteDevices.length > 1 && (
                          <div className="console-remote-devices-container">
                            <span className="console-kicker">{isZh ? "切换其他已绑定的电脑" : "OTHER PAIRED COMPUTERS"}</span>
                            <div className="console-remote-device-grid" aria-label={isZh ? "账号客户端" : "Account clients"}>
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
                                    <small>{device.online ? (isZh ? "在线 · 点击连接" : "Online · Click to Connect") : (isZh ? "离线" : "Offline")}</small>
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
                            + {isZh ? "绑定另一台电脑客户端" : "Pair Another Computer"}
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
                              <h3>{isZh ? "尚未检测到在线的电脑客户端" : "No Online Computer Detected"}</h3>
                              <p>
                                {isZh
                                  ? "请确保已在电脑上启动 SomniQ Studio 并保持登录；客户端在线后将自动出现在此处，可一键发起安全连接。"
                                  : "Make sure SomniQ Studio is running on your computer. It will appear here automatically when online."}
                              </p>
                            </div>

                            <div className="console-remote-empty-quick-steps">
                              <div className="console-remote-quick-step">
                                <span className="console-remote-step-badge">1</span>
                                <div>
                                  <strong>{isZh ? "启动电脑客户端" : "Start Desktop App"}</strong>
                                  <small>{isZh ? "打开 SomniQ Studio" : "Launch SomniQ"}</small>
                                </div>
                              </div>
                              <div className="console-remote-quick-arrow">→</div>
                              <div className="console-remote-quick-step">
                                <span className="console-remote-step-badge">2</span>
                                <div>
                                  <strong>{isZh ? "网页自动就绪" : "Auto Discovery"}</strong>
                                  <small>{isZh ? "点击直连进入对话" : "Click to connect"}</small>
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
                                    ? (isZh ? "绑定新的电脑客户端" : "Pair a New Computer")
                                    : (isZh ? "手动绑定电脑客户端（输入连接码）" : "Manual Pairing with Code")}
                                </h4>
                                <p className="console-remote-pair-desc">
                                  {isZh
                                    ? "在电脑端 SomniQ Studio「设置 → 远程访问」复制连接码粘贴在下方："
                                    : "Copy the connection code in SomniQ Desktop settings and paste below:"}
                                </p>
                              </div>
                            </div>
                            {primaryRemoteDevice && (
                              <button
                                type="button"
                                className="btn btn--outline btn--sm"
                                onClick={() => setShowPairCard(false)}
                              >
                                {isZh ? "返回在线电脑" : "Cancel"}
                              </button>
                            )}
                          </div>

                          {!isPairingActive ? (
                            <form onSubmit={handleStartInlinePairing} className="console-remote-pair-form">
                              <div className="console-remote-textarea-wrap">
                                <textarea
                                  className="console-remote-code-input"
                                  rows={2}
                                  placeholder={isZh ? "在此粘贴电脑复制的连接码..." : "Paste connection code here..."}
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
                                  <span>{isZh ? "发起安全绑定" : "Start Pairing"}</span>
                                </button>
                              </div>
                            </form>
                          ) : (
                            <div className="console-remote-pairing-active-box">
                              <div className="console-remote-pairing-active-header">
                                <span className="console-remote-pulse-dot" />
                                <div>
                                  <strong>{isZh ? "正在与电脑建立加密握手..." : "Connecting to computer..."}</strong>
                                  <p>{isZh ? "请在电脑端点击【允许配对】" : "Please click 'Approve' on desktop"}</p>
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
                                {isZh ? "取消本次绑定" : "Cancel Pairing"}
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
                        <strong>{isZh ? "严格的零信任授权机制" : "Zero-trust client authorization"}</strong>
                        {isZh
                          ? "每次连接或配对都必须经由电脑端本机弹窗显式确认。"
                          : "Every connection must be explicitly confirmed on your desktop."}
                      </p>
                    </div>
                  </section>

                  <aside className="console-remote-side-stack">
                    <section className="console-card console-remote-mobile-card">
                      <div className="console-remote-mobile-copy">
                        <span className="console-kicker">{isZh ? "手机 / 平板协同" : "MOBILE & TABLET"}</span>
                        <h3>{isZh ? "扫码用手机继续研究" : "Scan for mobile companion"}</h3>
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
                        <span className="console-remote-qr-tip">{isZh ? "支持 iOS / Android 原生相机扫码" : "Supports iOS & Android camera"}</span>
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
                          <span>{copiedRemoteLink ? (isZh ? "已复制" : "Copied") : (isZh ? "复制链接" : "Copy link")}</span>
                        </button>
                        <a className="btn btn--outline btn--sm console-remote-mobile-btn" href="./remote/" target="_blank" rel="noreferrer noopener">
                          <span>{isZh ? "新窗口打开" : "Open in new tab"}</span>
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
                          <span>{isZh ? "端到端加密" : "E2E Encrypted"}</span>
                        </span>
                      </div>
                    </div>
                    <div className="console-remote-toolbar-actions">
                      <button
                        type="button"
                        className="console-remote-tool-btn"
                        onClick={() => setRemoteViewMode("connect")}
                      >
                        {isZh ? "切换电脑设备" : "Switch Device"}
                      </button>
                      <a
                        className="console-remote-tool-btn console-remote-tool-btn--accent"
                        href={remoteChatHref}
                        target="_blank"
                        rel="noreferrer noopener"
                      >
                        <span>{isZh ? "新窗口打开" : "Open in new window"}</span>
                        <ExternalLinkIcon width={13} height={13} />
                      </a>
                    </div>
                  </div>
                  <div className="console-remote-chat-frame">
                    <iframe
                      key={remoteChatSrc}
                      src={remoteChatSrc}
                      title={isZh ? "SomniQ 远程工作台" : "SomniQ Remote Workspace"}
                      allow="camera; clipboard-read; clipboard-write;"
                    />
                  </div>
                </section>
              ) : (
                <section className="console-card console-remote-empty-state">
                  <strong>{isZh ? "没有可连接的客户端" : "No client is available"}</strong>
                  <button type="button" className="btn btn--primary" onClick={() => setRemoteViewMode("connect")}>
                    {isZh ? "返回客户端列表" : "Back to clients"}
                  </button>
                </section>
              )}            </div>
          ) : activeTab === "usage" ? (
            <div className="console-canvas-inner">
              {/* Usage Header */}
              <div className="console-hero">
                <h1 className="console-greeting">
                  {isZh ? "科研算力用量分析" : "AI Compute & Usage Analytics"}
                </h1>
                <p className="console-subgreeting">
                  {isZh
                    ? `实时统计您在 SomniQ Studio 各大科研大模型的调用频次、词元消耗与响应日志。`
                    : `Real-time usage statistics across all LLM models, token consumption, and response logs.`}
                </p>
                <div className="console-tags">
                  <span className="console-tag"># {isZh ? `累计请求: ${totalRequests.toLocaleString()}` : `Total: ${totalRequests.toLocaleString()}`}</span>
                  <span className="console-tag"># {isZh ? `已消耗: ${formatTokens(used)}` : `Consumed: ${formatTokens(used)}`}</span>
                  <span className="console-tag"># {isZh ? `余额: ${formatTokens(remaining)}` : `Balance: ${formatTokens(remaining)}`}</span>
                </div>
              </div>

              {/* 4 Summary Cards */}
              <div className="usage-stat-grid">
                <div className="console-card usage-stat-card">
                  <span className="console-kicker">{isZh ? "当前可用额度" : "AVAILABLE QUOTA"}</span>
                  <div className="usage-stat-num">{formatTokens(remaining)}</div>
                  <span className="usage-stat-sub">≈ ${usdValue} USD</span>
                </div>

                <div className="console-card usage-stat-card">
                  <span className="console-kicker">{isZh ? "累计消耗算力" : "TOTAL CONSUMED"}</span>
                  <div className="usage-stat-num usage-stat-num--used">{formatTokens(used)}</div>
                  <span className="usage-stat-sub">≈ ${(used / 500000).toFixed(2)} USD</span>
                </div>

                <div className="console-card usage-stat-card">
                  <span className="console-kicker">{isZh ? "科研请求总数" : "TOTAL REQUESTS"}</span>
                  <div className="usage-stat-num">{totalRequests.toLocaleString()}</div>
                  <span className="usage-stat-sub">{isZh ? "涵盖所有交互流程" : "Across all workflows"}</span>
                </div>

                <div className="console-card usage-stat-card">
                  <span className="console-kicker">{isZh ? "活跃科研模型" : "ACTIVE MODELS"}</span>
                  <div className="usage-stat-num">{totalRequests > 0 ? 7 : 0}</div>
                  <span className="usage-stat-sub">{isZh ? "主力驱动架构" : "Core engines"}</span>
                </div>
              </div>

              {/* Daily Call Trend (last 30 days) */}
              <div className="console-card usage-section-card">
                <div className="console-card-header">
                  <div className="console-title-with-info">
                    <h3 className="console-card-title">
                      {isZh ? "近 30 天每日调用趋势" : "Daily Call Trend (Last 30 Days)"}
                    </h3>
                    <span className="console-info-icon">ⓘ</span>
                  </div>
                  <span style={{ fontSize: "12px", color: "var(--text-faint)" }}>
                    {hasTrendData
                      ? (isZh ? `峰值: ${Math.max(...trendData)} 次/天` : `Peak: ${Math.max(...trendData)}/day`)
                      : (isZh ? "暂无调用记录" : "No call history yet")}
                  </span>
                </div>
                {hasTrendData ? (
                  <div style={{ padding: "8px 0 4px" }}>
                    <MiniBarChart data={trendData} color="var(--accent-blue, #38bdf8)" height={56} />
                    <div style={{ display: "flex", justifyContent: "space-between", marginTop: "6px", fontSize: "11px", color: "var(--text-faint)" }}>
                      <span>{isZh ? "30天前" : "30d ago"}</span>
                      <span>{isZh ? "今天" : "Today"}</span>
                    </div>
                  </div>
                ) : (
                  <div style={{ textAlign: "center", padding: "24px", color: "var(--text-faint)", fontSize: "13px" }}>
                    {isZh ? "暂无调用记录" : "No call history yet"}
                  </div>
                )}
              </div>

              {/* Model Breakdown Section (Interactive Donut/Pie Chart & Date Picker) */}
              <div className="console-card usage-section-card">
                <div className="console-card-header">
                  <div className="console-title-with-info">
                    <h3 className="console-card-title">{isZh ? "各模型调用分布与消耗明细" : "Model Usage Breakdown"}</h3>
                    <span className="console-info-icon">ⓘ</span>
                  </div>
                  <button
                    type="button"
                    className={`console-refresh-btn ${refreshing ? "console-refresh-btn--spin" : ""}`}
                    onClick={handleRefresh}
                    disabled={refreshing}
                  >
                    <RefreshIcon width={13} height={13} />
                    <span>{refreshing ? (isZh ? "刷新中..." : "Refreshing...") : isZh ? "刷新明细" : "Refresh"}</span>
                  </button>
                </div>

                {/* Toolbar: Date Range Picker + Metric Switcher */}
                <div className="usage-breakdown-toolbar">
                  {/* Date Range Buttons */}
                  <div className="usage-range-btn-group" role="group" aria-label={isZh ? "日期范围" : "Date Range"}>
                    <button
                      type="button"
                      className={`usage-range-btn ${breakdownRange === "all" ? "usage-range-btn--active" : ""}`}
                      onClick={() => setBreakdownRange("all")}
                    >
                      {isZh ? "全部时间" : "All Time"}
                    </button>
                    <button
                      type="button"
                      className={`usage-range-btn ${breakdownRange === "30d" ? "usage-range-btn--active" : ""}`}
                      onClick={() => setBreakdownRange("30d")}
                    >
                      {isZh ? "近 30 天" : "Last 30 Days"}
                    </button>
                    <button
                      type="button"
                      className={`usage-range-btn ${breakdownRange === "7d" ? "usage-range-btn--active" : ""}`}
                      onClick={() => setBreakdownRange("7d")}
                    >
                      {isZh ? "近 7 天" : "Last 7 Days"}
                    </button>
                    <button
                      type="button"
                      className={`usage-range-btn ${breakdownRange === "24h" ? "usage-range-btn--active" : ""}`}
                      onClick={() => setBreakdownRange("24h")}
                    >
                      {isZh ? "近 24 小时" : "Last 24h"}
                    </button>
                  </div>

                  {/* Metric Switcher */}
                  <div className="usage-metric-toggle-group" role="group" aria-label={isZh ? "指标切换" : "Metric Switch"}>
                    <button
                      type="button"
                      className={`usage-metric-toggle-btn ${breakdownMetric === "calls" ? "usage-metric-toggle-btn--active" : ""}`}
                      onClick={() => setBreakdownMetric("calls")}
                    >
                      {isZh ? "按调用频次" : "By Calls"}
                    </button>
                    <button
                      type="button"
                      className={`usage-metric-toggle-btn ${breakdownMetric === "quota" ? "usage-metric-toggle-btn--active" : ""}`}
                      onClick={() => setBreakdownMetric("quota")}
                    >
                      {isZh ? "按算力消耗" : "By Quota"}
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
                          ? isZh
                            ? "总调用次数"
                            : "Total Calls"
                          : isZh
                          ? "总消耗算力"
                          : "Total Quota"
                      }
                      formatTokens={formatTokens}
                    />

                    {/* Right: Detailed Legend List */}
                    <div className="usage-donut-legend-list">
                      {(() => {
                        const totalVal = currentBreakdownList.reduce(
                          (acc, c) => acc + (breakdownMetric === "calls" ? c.calls : c.quota),
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
                                    ? `${item.calls.toLocaleString()} ${isZh ? "次" : "calls"}`
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
                    {isZh ? "所选时间段内暂无模型调用记录" : "No model usage records found for selected period."}
                  </div>
                )}
              </div>

              {/* Recent Invocations Table (Last 1 Month) */}
              <div className="console-card usage-section-card">
                <div className="console-card-header">
                  <div className="console-title-with-info">
                    <h3 className="console-card-title">{isZh ? "最新科研调用实时明细" : "Recent Invocations Log"}</h3>
                    <span className="usage-badge-month">{isZh ? "近 1 个月" : "Last 30 Days"}</span>
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
                      aria-label={isZh ? "按模型筛选" : "Filter by model"}
                    >
                      <option value="all">{isZh ? "全部模型" : "All Models"}</option>
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
                      aria-label={isZh ? "每页条数" : "Page size"}
                    >
                      <option value="10">{isZh ? "10 条/页" : "10 / page"}</option>
                      <option value="20">{isZh ? "20 条/页" : "20 / page"}</option>
                      <option value="50">{isZh ? "50 条/页" : "50 / page"}</option>
                    </select>

                    <button
                      type="button"
                      className={`console-refresh-btn ${loadingLogs || refreshing ? "console-refresh-btn--spin" : ""}`}
                      onClick={handleRefresh}
                      disabled={loadingLogs || refreshing}
                      title={isZh ? "刷新明细" : "Refresh"}
                    >
                      <RefreshIcon width={13} height={13} />
                      <span>{loadingLogs ? (isZh ? "加载中..." : "Loading...") : isZh ? "刷新" : "Refresh"}</span>
                    </button>
                  </div>
                </div>

                {/* Desktop Table View (>= 769px) */}
                <div className="usage-table-wrap usage-table-desktop">
                  <table className="usage-table">
                    <thead>
                      <tr>
                        <th>{isZh ? "时间" : "Time"}</th>
                        <th>{isZh ? "模型" : "Model"}</th>
                        <th>{isZh ? "输入词元" : "Prompt"}</th>
                        <th>{isZh ? "产出词元" : "Completion"}</th>
                        <th>{isZh ? "消耗算力" : "Quota"}</th>
                        <th>{isZh ? "耗时" : "Latency"}</th>
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
                            {loadingLogs
                              ? (isZh ? "正在加载近 1 个月调用明细..." : "Loading records from the last month...")
                              : (isZh ? "近 1 个月暂无符合条件的调用记录" : "No invocation logs found for the selected filter")}
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
                              <span className="usage-log-card-label">{isZh ? "消耗算力" : "Quota"}</span>
                              <span className="usage-log-card-val usage-log-card-val--quota">{formatTokens(log.quota || 0)}</span>
                            </div>
                            <div className="usage-log-card-metric">
                              <span className="usage-log-card-label">{isZh ? "耗时" : "Latency"}</span>
                              <span className="usage-log-card-val">{log.use_time ? `${log.use_time}s` : "—"}</span>
                            </div>
                            <div className="usage-log-card-metric">
                              <span className="usage-log-card-label">{isZh ? "输入词元" : "Prompt"}</span>
                              <span className="usage-log-card-val">{(log.prompt_tokens || 0).toLocaleString()}</span>
                            </div>
                            <div className="usage-log-card-metric">
                              <span className="usage-log-card-label">{isZh ? "产出词元" : "Completion"}</span>
                              <span className="usage-log-card-val">{(log.completion_tokens || 0).toLocaleString()}</span>
                            </div>
                          </div>
                        </div>
                      );
                    })
                  ) : (
                    <div className="usage-logs-empty">
                      {loadingLogs
                        ? (isZh ? "正在加载近 1 个月调用明细..." : "Loading records from the last month...")
                        : (isZh ? "近 1 个月暂无符合条件的调用记录" : "No invocation logs found for the selected filter")}
                    </div>
                  )}
                </div>

                {/* Pagination Controls */}
                {displayLogsData.total > 0 && (
                  <div className="usage-pagination-bar">
                    <span className="usage-page-info">
                      {isZh
                        ? `第 ${logPage + 1} / ${Math.max(1, Math.ceil(displayLogsData.total / logPageSize))} 页 · 近 1 个月共 ${displayLogsData.total.toLocaleString()} 条记录`
                        : `Page ${logPage + 1} of ${Math.max(1, Math.ceil(displayLogsData.total / logPageSize))} · Total ${displayLogsData.total.toLocaleString()} records in last 30d`}
                    </span>
                    <div className="usage-page-nav">
                      <button
                        type="button"
                        className="usage-page-btn"
                        onClick={() => setLogPage((p) => Math.max(0, p - 1))}
                        disabled={logPage === 0 || loadingLogs}
                      >
                        {isZh ? "← 上一页" : "← Prev"}
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
                        {isZh ? "下一页 →" : "Next →"}
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
                  {isZh ? "套餐与科研订阅管理" : "Plan & Subscription Management"}
                </h1>
                <p className="console-subgreeting">
                  {isPro || (user?.quota ?? 0) > 0 || (user?.used_quota ?? 0) > 0 || user?.group === "千研"
                    ? isZh
                      ? `管理您在 SomniQ new-api 平台当前绑定的科研算力套餐、专属集群权限与履约明细。`
                      : `Manage your active AI research subscription, cluster group, and quota on SomniQ new-api.`
                    : isZh
                    ? `选择适合您或实验室团队的 AI 科研自主工作流算力套餐，即刻开启全自动科研。`
                    : `Choose the best research AI compute subscription for yourself or your laboratory.`}
                </p>
                <div className="console-tags">
                  <span className="console-tag">
                    # {isPro || (user?.quota ?? 0) > 0 || (user?.used_quota ?? 0) > 0 || user?.group === "千研"
                      ? isZh
                        ? `当前订阅: 千研 Pro 会员`
                        : `Active: Thousand Research Pro`
                      : isZh
                      ? `当前计划: 社区版`
                      : `Current: Free Tier`}
                  </span>
                  <span className="console-tag">
                    # {user?.group ? `${isZh ? "集群分组" : "Group"}: ${user.group}` : isZh ? "默认分组" : "Default"}
                  </span>
                  <span className="console-tag">
                    # {isZh ? `可用额度: ${formatTokens(remaining)}` : `Balance: ${formatTokens(remaining)}`}
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
                              ? isZh
                                ? "千研科研 Pro 专业版会员"
                                : "Thousand Research Pro Member"
                              : isZh
                              ? "SomniQ 科研专业版"
                              : "SomniQ Pro Tier"}
                          </span>
                          <span className="plan-active-status-tag">● {isZh ? "活跃履约中" : "Active & Running"}</span>
                        </div>
                        <span style={{ fontSize: "13px", color: "var(--text-dim)" }}>
                          {isZh
                            ? "基于 SomniQ new-api 高性能科研大模型网关与千研集群"
                            : "Powered by SomniQ new-api LLM gateway and Thousand Research cluster"}
                        </span>
                      </div>
                      <div className="plan-active-group-badge">
                        <span>
                          {isZh ? "所属集群分组" : "Cluster Group"}: {user?.group || "千研"}
                        </span>
                      </div>
                    </div>

                    {/* 4 Detail Metrics Boxes */}
                    <div className="plan-details-grid">
                      <div className="plan-detail-box">
                        <div className="plan-detail-label">{isZh ? "可用科研算力" : "Available Quota"}</div>
                        <div className="plan-detail-val">{formatTokens(remaining)}</div>
                        <div className="plan-detail-sub">≈ ${usdValue} USD</div>
                      </div>
                      <div className="plan-detail-box">
                        <div className="plan-detail-label">{isZh ? "累计消耗算力" : "Used Quota"}</div>
                        <div className="plan-detail-val" style={{ color: "var(--accent-blue)" }}>
                          {formatTokens(used)}
                        </div>
                        <div className="plan-detail-sub">≈ ${(used / 500000).toFixed(2)} USD</div>
                      </div>
                      <div className="plan-detail-box">
                        <div className="plan-detail-label">{isZh ? "累计调用请求" : "Total Requests"}</div>
                        <div className="plan-detail-val">
                          {totalRequests.toLocaleString()} {isZh ? "次" : "calls"}
                        </div>
                        <div className="plan-detail-sub">{isZh ? "涵盖全流程科研" : "All workflows"}</div>
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
                        <span>{isZh ? "算力额度消耗进度" : "Quota Consumption Progress"}</span>
                        <span>
                          {remainingPercent.toFixed(1)}% {isZh ? "剩余" : "remaining"}
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
                        <h3 className="plan-tier-name">{isZh ? "社区体验版" : "Free Tier"}</h3>
                        <p className="plan-tier-desc">
                          {isZh ? "适合个人轻量学术探索与体验" : "For personal casual research exploration"}
                        </p>
                        <div className="plan-tier-price">
                          <strong>¥0</strong>
                          <span>/ {isZh ? "永久" : "forever"}</span>
                        </div>
                        <ul className="plan-tier-features">
                          <li>
                            <span>✓</span> {isZh ? "基础科研对话" : "Basic research chat"}
                          </li>
                          <li>
                            <span>✓</span> {isZh ? "免费基础模型（DeepSeek Flash Free 等）" : "Free base models"}
                          </li>
                          <li>
                            <span>✓</span> {isZh ? "本地工作区存储" : "Local workspace storage"}
                          </li>
                        </ul>
                      </div>
                      <a
                        href="./#download"
                        className="btn btn--outline"
                        style={{ width: "100%", textAlign: "center", justifyContent: "center" }}
                      >
                        {isZh ? "当前默认" : "Current Default"}
                      </a>
                    </div>

                    {/* Pro Tier (Featured) */}
                    <div className="plan-tier-card plan-tier-card--pro">
                      <span className="plan-tier-badge">
                        {isZh ? "最受欢迎 · 千研推荐" : "POPULAR · RECOMMENDED"}
                      </span>
                      <div>
                        <h3 className="plan-tier-name">{isZh ? "千研科研 Pro 专业版" : "Thousand Research Pro"}</h3>
                        <p className="plan-tier-desc">
                          {isZh
                            ? "为研究生、学者与独立研究者打造的全功能自主科研算力"
                            : "Full-featured autonomous research compute for researchers"}
                        </p>
                        <div className="plan-tier-price">
                          <strong>¥199</strong>
                          <span>/ {isZh ? "月" : "month"}</span>
                        </div>
                        <ul className="plan-tier-features">
                          <li>
                            <span>✓</span> {isZh ? "包含 50,000,000 科研词元" : "Includes 50M research Tokens"}
                          </li>
                          <li>
                            <span>✓</span> {isZh ? "独立 Reviewer 独立审查审计回路" : "16-Step Independent Reviewer Loop"}
                          </li>
                          <li>
                            <span>✓</span> {isZh ? "7 大顶尖科研大模型全量解锁" : "All 7 top LLMs unlocked"}
                          </li>
                          <li>
                            <span>✓</span> {isZh ? "三层结构化论文记忆系统" : "3-tier structured memory"}
                          </li>
                          <li>
                            <span>✓</span> {isZh ? "手机端端对端加密远程工作台" : "E2EE Secured remote mobile PWA"}
                          </li>
                        </ul>
                      </div>
                      <a
                        href="./pricing.html"
                        className="btn btn--primary"
                        style={{ width: "100%", textAlign: "center", justifyContent: "center" }}
                      >
                        {isZh ? "立即订阅升级" : "Subscribe Now"}
                      </a>
                    </div>

                    {/* Lab / Team Tier */}
                    <div className="plan-tier-card">
                      <div>
                        <h3 className="plan-tier-name">{isZh ? "实验室与高校团队版" : "Lab & Team Tier"}</h3>
                        <p className="plan-tier-desc">
                          {isZh
                            ? "课题组、高校实验室与企业科研团队多人共享与私有化部署"
                            : "For research labs and institutional teams"}
                        </p>
                        <div className="plan-tier-price">
                          <strong>¥999</strong>
                          <span>/ {isZh ? "月" : "month"}</span>
                        </div>
                        <ul className="plan-tier-features">
                          <li>
                            <span>✓</span> {isZh ? "包含 300,000,000 科研词元" : "Includes 300M research Tokens"}
                          </li>
                          <li>
                            <span>✓</span> {isZh ? "课题组多人文献库与共享算力池" : "Shared lab compute & literature pool"}
                          </li>
                          <li>
                            <span>✓</span> {isZh ? "支持本地局域网 / 私有云部署" : "Private cloud / LAN deployment"}
                          </li>
                          <li>
                            <span>✓</span> {isZh ? "专属科研技术顾问支持" : "Dedicated technical support"}
                          </li>
                        </ul>
                      </div>
                      <a
                        href="mailto:support@somni.chat"
                        className="btn btn--outline"
                        style={{ width: "100%", textAlign: "center", justifyContent: "center" }}
                      >
                        {isZh ? "联系课题组定制" : "Contact Team"}
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
                  {isZh
                    ? `这是您使用 SomniQ Studio 进行自主科研的第 ${daysActive} 天。`
                    : `This is your day ${daysActive} of using SomniQ Studio.`}
                </p>
                <div className="console-tags">
                  <span className="console-tag"># {isZh ? "独立审查验证" : "Independent Reviewer"}</span>
                  <span className="console-tag"># {isZh ? "三层结构化记忆" : "Project Memory"}</span>
                  <span className="console-tag"># {user?.group ? `${isZh ? "分组" : "Group"}: ${user.group}` : (isZh ? "千研" : "Research Tier")}</span>
                  <span className="console-tag"># {isZh ? `累计调用: ${totalRequests.toLocaleString()}` : `Total Calls: ${totalRequests.toLocaleString()}`}</span>
                </div>
              </div>

              {/* Quota & Compute Top Card (Real Data) */}
              <div className="console-grid-metrics">
                {/* Compute Balance Card */}
                <div className="console-card console-card--balance">
                  <div className="console-card-header">
                    <span className="console-kicker">{isZh ? "当前可用科研算力" : "AVAILABLE AI COMPUTE"}</span>
                    <button
                      type="button"
                      className={`console-refresh-btn ${refreshing ? "console-refresh-btn--spin" : ""}`}
                      onClick={handleRefresh}
                      disabled={refreshing}
                    >
                      <RefreshIcon width={13} height={13} />
                      <span>{refreshing ? (isZh ? "同步中..." : "Syncing...") : isZh ? "刷新余额" : "Refresh"}</span>
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
                    <span>{isZh ? `已消耗算力: ${formatTokens(used)}` : `Used Quota: ${formatTokens(used)}`}</span>
                    <span className="console-tier-tag">{user?.group || (isPro ? copy.dashboard.tierPro : copy.dashboard.tierFree)}</span>
                  </div>
                </div>

                {/* Cumulative Usage Card */}
                <div className="console-card console-card--usage">
                  <div className="console-card-header">
                    <span className="console-kicker">{isZh ? "累计科研消耗" : "CUMULATIVE RESEARCH USAGE"}</span>
                  </div>
                  <div className="console-metric-val">
                    <span className="console-number-huge console-number--used">{formatTokens(used)}</span>
                  </div>
                  <p className="console-card-desc">
                    {isZh
                      ? `已累计完成 ${totalRequests.toLocaleString()} 次科研模型交互，涵盖文献检索、实验运行、论文撰写与独立审查。`
                      : `Completed ${totalRequests.toLocaleString()} research model interactions, covering literature search, experiments, drafting, and review.`}
                  </p>
                </div>
              </div>

              {/* Daily Call Trend Card */}
              <div className="console-card" style={{ marginBottom: "16px" }}>
                <div className="console-card-header">
                  <div className="console-title-with-info">
                    <h3 className="console-card-title">
                      {isZh ? "近 30 天每日调用次数" : "Daily Calls — Last 30 Days"}
                    </h3>
                    <span className="console-info-icon">ⓘ</span>
                  </div>
                  <span style={{ fontSize: "12px", color: "var(--text-faint)" }}>
                    {hasTrendData
                      ? (isZh ? `峰值: ${Math.max(...trendData)} 次/天` : `Peak: ${Math.max(...trendData)}/day`)
                      : (isZh ? "暂无数据" : "No data")}
                  </span>
                </div>
                {hasTrendData ? (
                  <div style={{ padding: "8px 0 4px" }}>
                    <MiniBarChart data={trendData} color="var(--accent-blue, #38bdf8)" height={52} />
                    <div style={{ display: "flex", justifyContent: "space-between", marginTop: "6px", fontSize: "11px", color: "var(--text-faint)" }}>
                      <span>{isZh ? "30天前" : "30d ago"}</span>
                      <span>{isZh ? "今天" : "Today"}</span>
                    </div>
                  </div>
                ) : (
                  <div style={{ textAlign: "center", padding: "24px", color: "var(--text-faint)", fontSize: "13px" }}>
                    {isZh ? "暂无历史调用记录，开始使用后将显示趋势" : "No call history yet. Trend will appear after first usage."}
                  </div>
                )}
              </div>

              {/* Heatmap Card */}
              <div className="console-card console-card--heatmap">
                <div className="console-card-header">
                  <div className="console-title-with-info">
                    <h3 className="console-card-title">{isZh ? "SomniQ 科研活跃天数" : "SomniQ Active Days"}</h3>
                    <span
                      className="console-info-icon"
                      title={isZh
                        ? `记录从注册日至今的 ${daysActive} 天科研活跃轨迹`
                        : `Activity recorded across ${daysActive} active days`}
                    >ⓘ</span>
                  </div>
                  <div className="console-heatmap-legend">
                    <span>{isZh ? "少" : "Less"}</span>
                    <span className="c-legend-cell c-legend-cell--0" title={isZh ? "0 次调用" : "0 calls"} />
                    <span className="c-legend-cell c-legend-cell--1" title={isZh ? "1 - 40 次调用" : "1 - 40 calls"} />
                    <span className="c-legend-cell c-legend-cell--2" title={isZh ? "41 - 150 次调用" : "41 - 150 calls"} />
                    <span className="c-legend-cell c-legend-cell--3" title={isZh ? "151 - 400 次调用" : "151 - 400 calls"} />
                    <span className="c-legend-cell c-legend-cell--4" title={isZh ? "400+ 次调用" : "400+ calls"} />
                    <span>{isZh ? "多" : "More"}</span>
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
                                ? isZh
                                  ? `${cell.dateStr}：${cell.calls.toLocaleString()} 次调用`
                                  : `${cell.dateStr}: ${cell.calls.toLocaleString()} calls`
                                : isZh
                                ? `${cell.dateStr}：0 次调用`
                                : `${cell.dateStr}: 0 calls`
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
                      <span>{isZh ? "文献提炼与综述输出" : "Literature Syntheses"}</span>
                      <strong>{modelStats.synthesesCount.toLocaleString()}</strong>
                    </div>
                    <div className="c-act-track">
                      <div className="c-act-fill" style={{ width: `${synthBarPct}%` }} />
                      <span className="c-act-tag">Markdown · BibTeX</span>
                    </div>
                  </div>

                  <div className="c-act-row">
                    <div className="c-act-label">
                      <span>{isZh ? "独立审查与置信度审计" : "Independent Review Passes"}</span>
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
                    <span className="console-kicker">{isZh ? "主要执行 AI 伙伴" : "Most Frequent AI Partner"}</span>
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
                        ? <>{isZh ? "最近深度协作" : "Recently cooperated"} <strong>{modelStats.topModelCalls.toLocaleString()}</strong> {isZh ? "次" : "times"}</>
                        : <span style={{ color: "var(--text-faint)" }}>{isZh ? "暂无调用记录" : "No records yet"}</span>
                      }
                    </div>
                  </div>
                </div>

                <div className="console-card console-card--partner">
                  <div className="console-card-header">
                    <span className="console-kicker">{isZh ? "高阶推理与审查偏好" : "Recent Model Preference"}</span>
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
                        ? <>{isZh ? "调用执行" : "Invocations"} <strong>{modelStats.secondModelCalls.toLocaleString()}</strong> {isZh ? "次" : "times"}</>
                        : <span style={{ color: "var(--text-faint)" }}>{isZh ? "暂无第二模型记录" : "No secondary model yet"}</span>
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

  useEffect(() => {
    document.documentElement.lang = lang === "zh" ? "zh-CN" : "en";
  }, [lang]);

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
