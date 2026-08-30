import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ArrowIcon,
  CheckIcon,
  HandshakeIcon,
  LockIcon,
  NetworkIcon,
  RefreshIcon,
} from "./components/icons";
import AuthModal from "./components/AuthModal";
import Footer from "./components/Footer";
import Nav from "./components/Nav";
import PwaInstallBanner from "./components/PwaInstallBanner";
import UserDashboard from "./components/UserDashboard";
import { AuthProvider } from "./context/AuthContext";
import {
  COPY,
  detectTheme,
  persistTheme,
  useAutoLang,
  type Lang,
  type Theme,
} from "./i18n";

type NetworkRecord = {
  id: string;
  requester: string;
  helper: string;
  kind: string;
  completed_at_unix_ms: number;
};

type NetworkStats = {
  total_assists: number;
  participant_nodes: number;
  requester_nodes: number;
  helper_nodes: number;
  connection_count: number;
};

type NetworkPayload = {
  enabled: boolean;
  records: NetworkRecord[];
  stats: NetworkStats;
  updated_at_unix_ms: number | null;
};

type GraphNode = {
  id: string;
  x: number;
  y: number;
  role: "requester" | "helper" | "both";
};

type GraphEdge = {
  from: string;
  to: string;
  count: number;
};

const EMPTY_STATS: NetworkStats = {
  total_assists: 0,
  participant_nodes: 0,
  requester_nodes: 0,
  helper_nodes: 0,
  connection_count: 0,
};

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function normalizeNetworkPayload(value: unknown): NetworkPayload {
  if (!isObject(value)) {
    throw new Error("invalid network response");
  }

  const stats = isObject(value.stats) ? value.stats : {};
  const records = Array.isArray(value.records)
    ? value.records.flatMap((item): NetworkRecord[] => {
        if (!isObject(item)) return [];
        const completedAt = Number(item.completed_at_unix_ms);
        if (
          typeof item.id !== "string" ||
          typeof item.requester !== "string" ||
          typeof item.helper !== "string" ||
          typeof item.kind !== "string" ||
          !Number.isFinite(completedAt)
        ) {
          return [];
        }
        return [
          {
            id: item.id,
            requester: item.requester,
            helper: item.helper,
            kind: item.kind,
            completed_at_unix_ms: completedAt,
          },
        ];
      })
    : [];

  const updatedAt = Number(value.updated_at_unix_ms);
  return {
    enabled: value.enabled === true,
    records,
    stats: {
      total_assists: Number(stats.total_assists) || 0,
      participant_nodes: Number(stats.participant_nodes) || 0,
      requester_nodes: Number(stats.requester_nodes) || 0,
      helper_nodes: Number(stats.helper_nodes) || 0,
      connection_count: Number(stats.connection_count) || 0,
    },
    updated_at_unix_ms: Number.isFinite(updatedAt) ? updatedAt : null,
  };
}

function formatNumber(value: number, lang: Lang): string {
  return new Intl.NumberFormat(lang === "zh" ? "zh-CN" : lang === "es" ? "es" : "en").format(value);
}

function formatTime(value: number, lang: Lang): string {
  return new Intl.DateTimeFormat(
    lang === "zh" ? "zh-CN" : lang === "es" ? "es" : "en",
    {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    },
  ).format(new Date(value));
}

function nodeLabel(prefix: string, id: string): string {
  return prefix + " " + id.toUpperCase();
}

function NetworkContent({
  lang,
  theme,
  onSelectLang,
  onToggleLang,
  onToggleTheme,
}: {
  lang: Lang;
  theme: Theme;
  onSelectLang: (lang: Lang) => void;
  onToggleLang: () => void;
  onToggleTheme: () => void;
}) {
  const copy = COPY[lang];
  const networkCopy = copy.network;
  const [payload, setPayload] = useState<NetworkPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [hasError, setHasError] = useState(false);

  const loadNetwork = useCallback(async (signal?: AbortSignal) => {
    setRefreshing(true);
    try {
      const response = await fetch("./v1/community/network", {
        cache: "no-store",
        signal,
      });
      if (!response.ok) throw new Error("network request failed: " + response.status);
      const nextPayload = normalizeNetworkPayload(await response.json());
      setPayload(nextPayload);
      setHasError(false);
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      setHasError(true);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void loadNetwork(controller.signal);
    const timer = window.setInterval(() => void loadNetwork(), 30_000);
    return () => {
      controller.abort();
      window.clearInterval(timer);
    };
  }, [loadNetwork]);

  const records = payload?.records ?? [];
  const stats = payload?.stats ?? EMPTY_STATS;
  const graph = useMemo(() => {
    const roles = new Map<string, Set<"requester" | "helper">>();
    const edgesByKey = new Map<string, GraphEdge>();

    for (const record of records.slice(0, 24)) {
      const requesterRoles = roles.get(record.requester) ?? new Set();
      requesterRoles.add("requester");
      roles.set(record.requester, requesterRoles);

      const helperRoles = roles.get(record.helper) ?? new Set();
      helperRoles.add("helper");
      roles.set(record.helper, helperRoles);

      const key = record.requester + "->" + record.helper;
      const edge = edgesByKey.get(key);
      if (edge) {
        edge.count += 1;
      } else {
        edgesByKey.set(key, {
          from: record.requester,
          to: record.helper,
          count: 1,
        });
      }
    }

    const ids = Array.from(roles.keys()).slice(0, 12);
    const visibleIds = new Set(ids);
    const radius = ids.length <= 2 ? 106 : 132;
    const nodes: GraphNode[] = ids.map((id, index) => {
      const angle = -Math.PI / 2 + (index * Math.PI * 2) / Math.max(ids.length, 1);
      const roleSet = roles.get(id) ?? new Set();
      return {
        id,
        x: 360 + Math.cos(angle) * radius,
        y: 180 + Math.sin(angle) * radius,
        role: roleSet.size > 1 ? "both" : roleSet.has("requester") ? "requester" : "helper",
      };
    });

    return {
      nodes,
      edges: Array.from(edgesByKey.values()).filter(
        (edge) => visibleIds.has(edge.from) && visibleIds.has(edge.to),
      ),
    };
  }, [records]);

  const statCards = [
    { key: "assists", value: stats.total_assists, icon: CheckIcon },
    { key: "nodes", value: stats.participant_nodes, icon: NetworkIcon },
    { key: "requesters", value: stats.requester_nodes, icon: ArrowIcon },
    { key: "helpers", value: stats.helper_nodes, icon: HandshakeIcon },
  ] as const;

  return (
    <div className={"page network-page lang-" + lang + " theme-" + theme}>
      <div className="aurora" aria-hidden="true">
        <span className="aurora-blob aurora-blob--blue" />
        <span className="aurora-blob aurora-blob--violet" />
        <span className="aurora-grid" />
      </div>

      <PwaInstallBanner copy={copy} />
      <Nav
        copy={copy}
        theme={theme}
        currentLang={lang}
        onSelectLang={onSelectLang}
        onToggleLang={onToggleLang}
        onToggleTheme={onToggleTheme}
      />

      <main id="main">
        <section className="network-hero">
          <div className="container network-hero-inner">
            <div className="network-hero-copy">
              <p className="section-kicker">{networkCopy.kicker}</p>
              <h1>{networkCopy.title}</h1>
              <p className="network-hero-lede">{networkCopy.lede}</p>
              <div className="network-hero-actions">
                <a className="btn btn--ghost" href={"./?lang=" + lang}>
                  <ArrowIcon width={16} height={16} />
                  {networkCopy.backHome}
                </a>
                <button
                  type="button"
                  className="btn btn--outline"
                  disabled={refreshing}
                  onClick={() => void loadNetwork()}
                >
                  <RefreshIcon
                    width={16}
                    height={16}
                    className={refreshing ? "network-spin" : undefined}
                  />
                  {refreshing ? networkCopy.refreshing : networkCopy.refresh}
                </button>
              </div>
              <div className="network-status-row" aria-live="polite">
                <span className={"network-live-status" + (payload?.enabled ? "" : " is-muted")}>
                  <span className="network-live-dot" />
                  {payload?.enabled ? networkCopy.live : networkCopy.disabled}
                </span>
                {payload?.updated_at_unix_ms ? (
                  <span>
                    {networkCopy.updated} · {formatTime(payload.updated_at_unix_ms, lang)}
                  </span>
                ) : null}
              </div>
            </div>

            <div className="network-hero-emblem" aria-hidden="true">
              <div className="network-hero-emblem-orbit network-hero-emblem-orbit--outer" />
              <div className="network-hero-emblem-orbit network-hero-emblem-orbit--inner" />
              <div className="network-hero-emblem-core">
                <HandshakeIcon width={34} height={34} />
                <span>AGENT</span>
                <strong>↔</strong>
                <span>PEER</span>
              </div>
            </div>
          </div>
        </section>

        <section className="network-content">
          <div className="container">
            <div className="network-stat-grid" aria-label={networkCopy.stats.assists}>
              {statCards.map(({ key, value, icon: Icon }) => (
                <article className="network-stat-card" key={key}>
                  <span className={"network-stat-icon network-stat-icon--" + key}>
                    <Icon width={17} height={17} />
                  </span>
                  <span className="network-stat-label">{networkCopy.stats[key]}</span>
                  <strong className="network-stat-value">
                    {loading && !payload ? "—" : formatNumber(value, lang)}
                  </strong>
                </article>
              ))}
            </div>

            {hasError ? (
              <div className="network-inline-error" role="alert">
                <span>{networkCopy.loadError}</span>
                <button type="button" onClick={() => void loadNetwork()}>
                  {networkCopy.loadRetry}
                </button>
              </div>
            ) : null}

            {!loading && payload && !payload.enabled ? (
              <div className="network-disabled-card">
                <LockIcon width={20} height={20} />
                <div>
                  <strong>{networkCopy.disabled}</strong>
                  <p>{networkCopy.disabledSub}</p>
                </div>
              </div>
            ) : null}

            <div className="network-dashboard-grid">
              <article className="network-panel network-graph-panel">
                <div className="network-panel-head">
                  <div>
                    <span className="network-panel-kicker">
                      <NetworkIcon width={14} height={14} />
                      {networkCopy.graphTitle}
                    </span>
                    <p>{networkCopy.graphSubtitle}</p>
                  </div>
                  <span className="network-panel-count">
                    {formatNumber(stats.connection_count, lang)}
                  </span>
                </div>

                {graph.nodes.length > 0 ? (
                  <div className="network-graph-stage">
                    <svg
                      className="network-graph-svg"
                      viewBox="0 0 720 360"
                      role="img"
                      aria-label={networkCopy.graphTitle}
                    >
                      <defs>
                        <linearGradient id="network-edge-gradient" x1="0%" y1="0%" x2="100%" y2="100%">
                          <stop offset="0%" stopColor="#38bdf8" stopOpacity="0.8" />
                          <stop offset="100%" stopColor="#8b5cf6" stopOpacity="0.85" />
                        </linearGradient>
                        <marker
                          id="network-arrow"
                          markerWidth="7"
                          markerHeight="7"
                          refX="6"
                          refY="3.5"
                          orient="auto"
                        >
                          <path d="M0,0 L7,3.5 L0,7 Z" fill="#8b5cf6" />
                        </marker>
                      </defs>
                      <circle className="network-graph-ring network-graph-ring--outer" cx="360" cy="180" r="142" />
                      <circle className="network-graph-ring network-graph-ring--inner" cx="360" cy="180" r="72" />
                      {graph.edges.map((edge) => {
                        const from = graph.nodes.find((node) => node.id === edge.from);
                        const to = graph.nodes.find((node) => node.id === edge.to);
                        if (!from || !to) return null;
                        return (
                          <line
                            className="network-graph-edge"
                            key={edge.from + "-" + edge.to}
                            x1={from.x}
                            y1={from.y}
                            x2={to.x}
                            y2={to.y}
                            stroke="url(#network-edge-gradient)"
                            strokeWidth={edge.count > 1 ? 3 : 2}
                            markerEnd="url(#network-arrow)"
                          />
                        );
                      })}
                      <circle className="network-graph-hub" cx="360" cy="180" r="34" />
                      <text className="network-graph-hub-label" x="360" y="176" textAnchor="middle">
                        SOMNIQ
                      </text>
                      <text className="network-graph-hub-sub" x="360" y="193" textAnchor="middle">
                        PEER LINK
                      </text>
                      {graph.nodes.map((node) => (
                        <g
                          className={"network-graph-node network-graph-node--" + node.role}
                          key={node.id}
                        >
                          <circle cx={node.x} cy={node.y} r="25" />
                          <text x={node.x} y={node.y + 4} textAnchor="middle">
                            {node.id.toUpperCase()}
                          </text>
                        </g>
                      ))}
                    </svg>
                    <div className="network-graph-legend">
                      <span>
                        <i className="network-legend-dot network-legend-dot--requester" />
                        {networkCopy.requester}
                      </span>
                      <span>
                        <i className="network-legend-dot network-legend-dot--helper" />
                        {networkCopy.helper}
                      </span>
                    </div>
                  </div>
                ) : (
                  <div className="network-graph-empty">
                    <NetworkIcon width={30} height={30} />
                    <strong>{networkCopy.graphEmpty}</strong>
                    <span>{networkCopy.graphEmptySub}</span>
                  </div>
                )}
              </article>

              <article className="network-panel network-activity-panel">
                <div className="network-panel-head">
                  <div>
                    <span className="network-panel-kicker">
                      <CheckIcon width={14} height={14} />
                      {networkCopy.activityTitle}
                    </span>
                  </div>
                  <span className="network-live-mini">
                    <span className="network-live-dot" />
                    {networkCopy.live}
                  </span>
                </div>

                {records.length > 0 ? (
                  <ol className="network-activity-list">
                    {records.slice(0, 8).map((record) => (
                      <li className="network-activity-item" key={record.id}>
                        <div className="network-activity-flow">
                          <span className="network-node-chip network-node-chip--requester">
                            {nodeLabel(networkCopy.nodePrefix, record.requester)}
                          </span>
                          <ArrowIcon width={16} height={16} />
                          <span className="network-node-chip network-node-chip--helper">
                            {nodeLabel(networkCopy.nodePrefix, record.helper)}
                          </span>
                        </div>
                        <div className="network-activity-meta">
                          <span>
                            {record.kind === "image_assist" ? networkCopy.kindImageAssist : record.kind}
                          </span>
                          <span>{networkCopy.completed}</span>
                          <time dateTime={new Date(record.completed_at_unix_ms).toISOString()}>
                            {formatTime(record.completed_at_unix_ms, lang)}
                          </time>
                        </div>
                      </li>
                    ))}
                  </ol>
                ) : (
                  <div className="network-activity-empty">
                    <p>{networkCopy.activityEmpty}</p>
                  </div>
                )}
              </article>
            </div>

            <aside className="network-privacy-card">
              <span className="network-privacy-icon">
                <LockIcon width={17} height={17} />
              </span>
              <div>
                <strong>{networkCopy.privacyTitle}</strong>
                <p>{networkCopy.privacyBody}</p>
              </div>
            </aside>
          </div>
        </section>
      </main>

      <Footer copy={copy} hideCta />
      <AuthModal copy={copy} />
      <UserDashboard copy={copy} />
    </div>
  );
}

export default function NetworkApp() {
  const [lang, setLang] = useAutoLang();
  const [theme, setTheme] = useState<Theme>(detectTheme);
  const copy = COPY[lang];

  useEffect(() => {
    document.documentElement.lang = copy.htmlLang;
    document.title = copy.network.docTitle;
  }, [copy.htmlLang, copy.network.docTitle]);

  useEffect(() => {
    persistTheme(theme);
    document.documentElement.setAttribute("data-theme", theme);
  }, [theme]);

  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mediaQuery = window.matchMedia("(prefers-color-scheme: light)");
    const handleChange = (event: MediaQueryListEvent) => {
      if (!window.localStorage.getItem("somniq-site-theme")) {
        setTheme(event.matches ? "light" : "dark");
      }
    };
    mediaQuery.addEventListener("change", handleChange);
    return () => mediaQuery.removeEventListener("change", handleChange);
  }, []);

  const toggleLang = useCallback(() => {
    setLang((current) => (current === "zh" ? "en" : current === "en" ? "es" : "zh"));
  }, [setLang]);

  const toggleTheme = useCallback(() => {
    setTheme((current) => (current === "dark" ? "light" : "dark"));
  }, []);

  return (
    <AuthProvider>
      <NetworkContent
        lang={lang}
        theme={theme}
        onSelectLang={setLang}
        onToggleLang={toggleLang}
        onToggleTheme={toggleTheme}
      />
    </AuthProvider>
  );
}
