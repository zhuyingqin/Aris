import { listen } from "@tauri-apps/api/event";
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { imageAssistPublish, imageAssistRoster } from "../api/tauri";
import type { Language } from "../store";
import { SvgIcon } from "../SvgIcon";
import {
  clearImageAssistLocation,
  requestImageAssistLocation,
  storedImageAssistLocation,
  type ImageAssistApproximateLocation,
} from "./imageAssistLocation";

export interface ImageAssistRosterEntry {
  fingerprint: string;
  displayName?: string | null;
  location?: ImageAssistApproximateLocation | null;
  available: boolean;
}

type RosterFilter = "all" | "available" | "located";

const ROSTER_EVENT = "image-assist-roster";
const ERROR_EVENT = "image-assist-error";
const ROSTER_TIMEOUT_MS = 8_000;
const PAGE_SIZE = 50;

const COPY = {
  cn: {
    loading: "正在获取在线用户…",
    unavailable: "无法获取在线用户：",
    noUsers: "当前没有用户在线提供出图帮助。",
    online: "位在线",
    available: "位空闲",
    locations: "个地点",
    open: "查看在线互助用户详情",
    title: "在线互助网络",
    subtitle: "按大致地点查看当前可提供出图帮助的用户。系统仍会自动公平撮合，不能手动指定用户。",
    map: "用户地点分布",
    mapEmpty: "暂时没有用户公开大致位置",
    me: "我",
    undisclosed: "位置未公开",
    anonymous: "匿名用户",
    busy: "忙碌",
    idle: "空闲",
    search: "搜索名称、短指纹或地点",
    all: "全部",
    idleOnly: "仅空闲",
    locatedOnly: "已公开位置",
    users: "用户列表",
    noMatch: "没有符合筛选条件的用户。",
    close: "关闭",
    refresh: "刷新",
    previous: "上一页",
    next: "下一页",
    page: (current: number, total: number) => `第 ${current} / ${total} 页`,
    shareTitle: "共享我的大致位置",
    shareDesc: "仅在你提供互助时公开。授权后坐标会在本机降至约 11 公里精度，网关不会收到精确位置。",
    shareWaiting: "位置已保存；开启“为其他用户生成图片”且本机出图可用后才会发布。",
    locating: "正在请求位置权限…",
    sharedAt: (label: string) => `当前公开：${label}`,
  },
  en: {
    loading: "Loading online users…",
    unavailable: "Unable to load online users: ",
    noUsers: "Nobody is currently online to help generate images.",
    online: "online",
    available: "available",
    locations: "locations",
    open: "View online helper details",
    title: "Online helper network",
    subtitle: "See approximate locations of users who can help generate images. Matching remains automatic and fair; users cannot be selected manually.",
    map: "Helper distribution",
    mapEmpty: "No users are sharing an approximate location",
    me: "Me",
    undisclosed: "Location not shared",
    anonymous: "Anonymous user",
    busy: "Busy",
    idle: "Available",
    search: "Search name, fingerprint, or location",
    all: "All",
    idleOnly: "Available",
    locatedOnly: "Location shared",
    users: "Users",
    noMatch: "No users match these filters.",
    close: "Close",
    refresh: "Refresh",
    previous: "Previous",
    next: "Next",
    page: (current: number, total: number) => `Page ${current} of ${total}`,
    shareTitle: "Share my approximate location",
    shareDesc: "Shared only while you offer help. Coordinates are reduced locally to roughly 11 km precision; the gateway never receives your precise location.",
    shareWaiting: "Location is saved. It will publish after you enable image help and local generation is available.",
    locating: "Requesting location permission…",
    sharedAt: (label: string) => `Currently shared: ${label}`,
  },
} as const;

function mapPosition(location: ImageAssistApproximateLocation) {
  return {
    x: ((location.longitude + 180) / 360) * 1000,
    y: ((90 - location.latitude) / 180) * 500,
  };
}

function locationGroups(entries: ImageAssistRosterEntry[]) {
  const groups = new Map<string, { location: ImageAssistApproximateLocation; count: number; available: number }>();
  for (const entry of entries) {
    if (!entry.location) continue;
    const key = `${entry.location.latitude}:${entry.location.longitude}:${entry.location.label}`;
    const group = groups.get(key) ?? { location: entry.location, count: 0, available: 0 };
    group.count += 1;
    if (entry.available) group.available += 1;
    groups.set(key, group);
  }
  return [...groups.values()];
}

function WorldDistribution({
  entries,
  ownLocation,
  ownLabel,
  emptyLabel,
}: {
  entries: ImageAssistRosterEntry[];
  ownLocation?: ImageAssistApproximateLocation;
  ownLabel: string;
  emptyLabel: string;
}) {
  const groups = locationGroups(entries);
  const ownPosition = ownLocation ? mapPosition(ownLocation) : null;
  return (
    <div className="sp-image-assist-map">
      <svg viewBox="0 0 1000 500" role="img" aria-label={emptyLabel}>
        <g className="sp-image-assist-map-grid" aria-hidden="true">
          {[125, 250, 375].map((y) => <path key={`y-${y}`} d={`M0 ${y}H1000`} />)}
          {[250, 500, 750].map((x) => <path key={`x-${x}`} d={`M${x} 0V500`} />)}
        </g>
        <g className="sp-image-assist-map-land" aria-hidden="true">
          <path d="M74 106 128 60l91 8 54 48-26 56-59 22-26 65-52-25-15-59-38-29Z" />
          <path d="m239 246 57 31 34 66-20 93-39 48-24-100-34-77Z" />
          <path d="m445 100 67-28 67 24 43-13 99 27 87 58-31 53-83-1-47 35-58-24-36 33-69-34-22-56-50-31Z" />
          <path d="m487 235 73 4 48 69-28 118-57 33-50-102-26-68Z" />
          <path d="m762 325 67-26 72 40-16 72-85 9-50-51Z" />
          <path d="m879 185 31-12 23 22-18 27-37-9Z" />
        </g>
        <g className="sp-image-assist-map-points">
          {groups.map((group) => {
            const position = mapPosition(group.location);
            const radius = Math.min(18, 7 + Math.sqrt(group.count) * 2.5);
            return (
              <g key={`${group.location.label}-${position.x}-${position.y}`} transform={`translate(${position.x} ${position.y})`}>
                <circle className={group.available > 0 ? "is-available" : ""} r={radius} />
                {group.count > 1 && <text y="4">{group.count}</text>}
                <title>{`${group.location.label}: ${group.count}`}</title>
              </g>
            );
          })}
          {ownLocation && ownPosition && (
            <g className="is-own-location" transform={`translate(${ownPosition.x} ${ownPosition.y})`}>
              <circle r="8" />
              <text y="4">{ownLabel}</text>
              <title>{`${ownLabel}: ${ownLocation.label}`}</title>
            </g>
          )}
        </g>
      </svg>
      {groups.length === 0 && !ownLocation && <div className="sp-image-assist-map-empty">{emptyLabel}</div>}
    </div>
  );
}

export function ImageAssistRoster({ language = "cn" }: { language?: Language }) {
  const copy = COPY[language];
  const [entries, setEntries] = useState<ImageAssistRosterEntry[] | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<RosterFilter>("all");
  const [page, setPage] = useState(0);
  const [sharedLocation, setSharedLocation] = useState<ImageAssistApproximateLocation | undefined>(() => storedImageAssistLocation());
  const [locationBusy, setLocationBusy] = useState(false);
  const [locationProblem, setLocationProblem] = useState<string | null>(null);
  const [locationPublished, setLocationPublished] = useState(false);
  const closeRef = useRef<HTMLButtonElement | null>(null);

  const refresh = () => {
    setProblem(null);
    void imageAssistRoster().catch((cause: unknown) => {
      setProblem(cause instanceof Error ? cause.message : String(cause));
    });
  };

  useEffect(() => {
    let disposed = false;
    const roster = listen<ImageAssistRosterEntry[]>(ROSTER_EVENT, (event) => {
      if (disposed) return;
      setEntries(event.payload);
      setProblem(null);
    });
    const errors = listen<string>(ERROR_EVENT, (event) => {
      if (!disposed) setProblem(event.payload);
    });
    void imageAssistPublish(undefined, storedImageAssistLocation())
      .then(setLocationPublished)
      .catch(() => setLocationPublished(false));
    refresh();
    const timer = window.setTimeout(() => {
      if (!disposed) setProblem((current) => current ?? "网关没有响应。请确认远程控制已启用，且网关开启了互助出图。");
    }, ROSTER_TIMEOUT_MS);
    return () => {
      disposed = true;
      window.clearTimeout(timer);
      void roster.then((stop) => stop());
      void errors.then((stop) => stop());
    };
  }, []);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    closeRef.current?.focus();
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open]);

  const filtered = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    return (entries ?? []).filter((entry) => {
      if (filter === "available" && !entry.available) return false;
      if (filter === "located" && !entry.location) return false;
      if (!normalized) return true;
      return [entry.fingerprint, entry.displayName, entry.location?.label]
        .some((value) => value?.toLocaleLowerCase().includes(normalized));
    });
  }, [entries, filter, query]);

  useEffect(() => setPage(0), [filter, query]);

  const currentEntries = entries ?? [];
  const available = currentEntries.filter((entry) => entry.available).length;
  const places = new Set(currentEntries.flatMap((entry) => entry.location?.label ? [entry.location.label] : [])).size;
  const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const visible = filtered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  const changeLocationSharing = async (enabled: boolean) => {
    setLocationProblem(null);
    if (!enabled) {
      clearImageAssistLocation();
      setSharedLocation(undefined);
      setLocationPublished(false);
      void imageAssistPublish(undefined, undefined).catch((cause: unknown) => setLocationProblem(String(cause)));
      return;
    }
    setLocationBusy(true);
    try {
      const location = await requestImageAssistLocation();
      setSharedLocation(location);
      setLocationPublished(await imageAssistPublish(undefined, location));
      refresh();
    } catch (cause) {
      setLocationProblem(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLocationBusy(false);
    }
  };

  if (problem && entries === null) {
    return <div className="sp-image-assist-roster-empty">{copy.unavailable}{problem}</div>;
  }
  if (entries === null) return <div className="sp-image-assist-roster-empty">{copy.loading}</div>;

  return (
    <>
      <button type="button" className="sp-image-assist-roster-summary" onClick={() => setOpen(true)} aria-label={copy.open}>
        <span className="sp-image-assist-roster-summary-icon"><SvgIcon name="graph" size={18} /></span>
        <span className="sp-image-assist-roster-summary-copy">
          <strong>{entries.length === 0 ? copy.noUsers : `${entries.length} ${copy.online}`}</strong>
          {entries.length > 0 && <small>{available} {copy.available} · {places} {copy.locations}</small>}
        </span>
        <span className="sp-image-assist-roster-avatars" aria-hidden="true">
          {entries.slice(0, 4).map((entry) => <i key={entry.fingerprint} className={entry.available ? "is-available" : ""} />)}
        </span>
        <SvgIcon name="chevronRight" size={16} />
      </button>

      {open && createPortal(
        <div className="sp-image-assist-roster-backdrop" role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget) setOpen(false);
        }}>
          <section className="sp-image-assist-roster-dialog" role="dialog" aria-modal="true" aria-labelledby="image-assist-roster-title">
            <header className="sp-image-assist-roster-dialog-head">
              <div>
                <h2 id="image-assist-roster-title">{copy.title}</h2>
                <p>{copy.subtitle}</p>
              </div>
              <div className="sp-image-assist-roster-head-actions">
                <button type="button" onClick={refresh} title={copy.refresh} aria-label={copy.refresh}><SvgIcon name="refresh" size={15} /></button>
                <button ref={closeRef} type="button" onClick={() => setOpen(false)} title={copy.close} aria-label={copy.close}><SvgIcon name="close" size={15} /></button>
              </div>
            </header>

            <div className="sp-image-assist-roster-stats">
              <div><strong>{currentEntries.length}</strong><span>{copy.online}</span></div>
              <div><strong>{available}</strong><span>{copy.available}</span></div>
              <div><strong>{places}</strong><span>{copy.locations}</span></div>
              <div><strong>{currentEntries.length - currentEntries.filter((entry) => entry.location).length}</strong><span>{copy.undisclosed}</span></div>
            </div>

            <div className="sp-image-assist-roster-layout">
              <section className="sp-image-assist-roster-map-panel" aria-labelledby="image-assist-map-title">
                <h3 id="image-assist-map-title">{copy.map}</h3>
                <WorldDistribution
                  entries={entries}
                  ownLocation={locationPublished ? sharedLocation : undefined}
                  ownLabel={copy.me}
                  emptyLabel={copy.mapEmpty}
                />
                <label className="sp-image-assist-location-toggle">
                  <span>
                    <strong>{copy.shareTitle}</strong>
                    <small>
                      {sharedLocation
                        ? locationPublished
                          ? copy.sharedAt(sharedLocation.label)
                          : copy.shareWaiting
                        : copy.shareDesc}
                    </small>
                    {locationProblem && <small className="is-error">{locationProblem}</small>}
                  </span>
                  <input type="checkbox" role="switch" checked={Boolean(sharedLocation)} disabled={locationBusy} onChange={(event) => void changeLocationSharing(event.target.checked)} />
                </label>
                {locationBusy && <div className="sp-image-assist-location-busy" role="status">{copy.locating}</div>}
              </section>

              <section className="sp-image-assist-roster-list-panel" aria-labelledby="image-assist-users-title">
                <div className="sp-image-assist-roster-list-head">
                  <h3 id="image-assist-users-title">{copy.users}</h3>
                  <span>{filtered.length}</span>
                </div>
                <div className="sp-image-assist-roster-toolbar">
                  <label className="sp-image-assist-roster-search">
                    <SvgIcon name="search" size={14} />
                    <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={copy.search} aria-label={copy.search} />
                  </label>
                  <div className="sp-image-assist-roster-filters" role="group">
                    {(["all", "available", "located"] as const).map((value) => (
                      <button key={value} type="button" className={filter === value ? "is-active" : ""} onClick={() => setFilter(value)}>
                        {value === "all" ? copy.all : value === "available" ? copy.idleOnly : copy.locatedOnly}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="sp-image-assist-roster-list">
                  {visible.length === 0 ? <div className="sp-image-assist-roster-no-match">{copy.noMatch}</div> : visible.map((entry) => (
                    <div key={entry.fingerprint} className="sp-image-assist-roster-row">
                      <span className={`sp-image-assist-roster-dot${entry.available ? " is-available" : ""}`} aria-hidden="true" />
                      <span className="sp-image-assist-roster-person">
                        <strong>{entry.displayName ?? copy.anonymous}</strong>
                        <small><code>{entry.fingerprint}</code> · {entry.location?.label ?? copy.undisclosed}</small>
                      </span>
                      <span className={`sp-image-assist-roster-status${entry.available ? " is-available" : ""}`}>{entry.available ? copy.idle : copy.busy}</span>
                    </div>
                  ))}
                </div>
                {pages > 1 && <div className="sp-image-assist-roster-pagination">
                  <button type="button" disabled={page === 0} onClick={() => setPage((value) => Math.max(0, value - 1))}><SvgIcon name="chevronLeft" size={13} />{copy.previous}</button>
                  <span>{copy.page(page + 1, pages)}</span>
                  <button type="button" disabled={page + 1 >= pages} onClick={() => setPage((value) => Math.min(pages - 1, value + 1))}>{copy.next}<SvgIcon name="chevronRight" size={13} /></button>
                </div>}
              </section>
            </div>
          </section>
        </div>,
        document.body,
      )}
    </>
  );
}
