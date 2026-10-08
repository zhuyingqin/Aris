import { useState, type KeyboardEvent, type PointerEvent } from "react";
import type { Language } from "../store";
import type { ProfileActivityPoint } from "./profileHeatmap";
import type { SettingsProfileCopy } from "./i18n";

const WIDTH = 720;
const HEIGHT = 160;
const INSET = 4;

export default function ProfileActivityChart({
  points, mode, language, copy, formatValue,
}: {
  points: ProfileActivityPoint[];
  mode: "weekly" | "cumulative";
  language: Language;
  copy: SettingsProfileCopy;
  formatValue: (value: number) => string;
}) {
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);
  if (points.length === 0) return null;
  const index = Math.min(selectedIndex ?? points.length - 1, points.length - 1);
  const selected = points[index];
  const locale = language === "cn" ? "zh-CN" : "en-US";
  const modeLabel = mode === "weekly" ? copy.modeWeekly : copy.modeCumulative;
  const describe = (point: ProfileActivityPoint) => `${point.date}${point.endDate ? ` – ${point.endDate}` : ""} · ${point.tokens.toLocaleString(locale)} ${copy.tokenUnit}`;
  const max = Math.max(1, ...points.map((point) => point.tokens));
  const plotWidth = WIDTH - INSET * 2;
  const slot = plotWidth / points.length;
  const x = (i: number) => INSET + (mode === "weekly" ? (i + .5) * slot : i / Math.max(1, points.length - 1) * plotWidth);
  const y = (tokens: number) => HEIGHT - tokens / max * (HEIGHT - INSET);
  const line = points.map((point, i) => `${i === 0 ? "M" : "L"} ${x(i)} ${y(point.tokens)}`).join(" ");
  const ticks = [0, Math.floor((points.length - 1) / 2), points.length - 1];

  const selectPointer = (event: PointerEvent<SVGSVGElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    if (bounds.width <= 0) return;
    const ratio = Math.max(0, Math.min(1, ((event.clientX - bounds.left) / bounds.width * WIDTH - INSET) / plotWidth));
    setSelectedIndex(Math.min(points.length - 1, mode === "weekly" ? Math.floor(ratio * points.length) : Math.round(ratio * (points.length - 1))));
  };
  const selectKeyboard = (event: KeyboardEvent<SVGSVGElement>) => {
    const next = event.key === "ArrowLeft" ? index - 1 : event.key === "ArrowRight" ? index + 1 : event.key === "Home" ? 0 : event.key === "End" ? points.length - 1 : null;
    if (next === null) return;
    event.preventDefault();
    setSelectedIndex(Math.max(0, Math.min(points.length - 1, next)));
  };

  return (
    <div className="sp-profile-chart" data-mode={mode}>
      <div className="sp-profile-chart-detail">{describe(selected)}</div>
      <div className="sp-profile-chart-body">
        <div className="sp-profile-chart-axis" aria-hidden="true">
          {[max, max / 2, 0].map((value, i) => <span key={i}>{formatValue(value)}</span>)}
        </div>
        <div className="sp-profile-chart-plot">
          <svg
            viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
            preserveAspectRatio="none"
            role="img"
            aria-label={`${copy.activityTitle} · ${modeLabel} · ${describe(selected)}`}
            tabIndex={0}
            onPointerMove={selectPointer}
            onPointerLeave={() => setSelectedIndex(null)}
            onKeyDown={selectKeyboard}
            onBlur={() => setSelectedIndex(null)}
          >
            <title>{`${copy.activityTitle} · ${modeLabel}`}</title>
            <desc>{copy.activityChartHint}</desc>
            {[INSET, (HEIGHT + INSET) / 2, HEIGHT].map((position) => <line key={position} className="sp-profile-chart-grid" x1={0} x2={WIDTH} y1={position} y2={position} vectorEffect="non-scaling-stroke" />)}
            {mode === "weekly" ? points.map((point, i) => (
              <rect key={point.date} className="sp-profile-chart-bar" data-selected={i === index || undefined} x={x(i) - slot * .35} y={y(point.tokens)} width={slot * .7} height={HEIGHT - y(point.tokens)} rx={1}>
                <title>{describe(point)}</title>
              </rect>
            )) : (
              <>
                <path className="sp-profile-chart-area" d={`${line} L ${x(points.length - 1)} ${HEIGHT} L ${x(0)} ${HEIGHT} Z`} />
                <path className="sp-profile-chart-line" d={line} vectorEffect="non-scaling-stroke" />
                <line className="sp-profile-chart-cursor" x1={x(index)} x2={x(index)} y1={0} y2={HEIGHT} vectorEffect="non-scaling-stroke" />
                <circle className="sp-profile-chart-point" cx={x(index)} cy={y(selected.tokens)} r={3} vectorEffect="non-scaling-stroke" />
              </>
            )}
          </svg>
          <div className="sp-profile-chart-dates" aria-hidden="true">
            {ticks.map((i, tick) => <span key={tick}>{points[i].date.slice(0, 7)}</span>)}
          </div>
        </div>
      </div>
      <div className="sp-profile-chart-hint">{copy.activityChartHint}</div>
    </div>
  );
}
