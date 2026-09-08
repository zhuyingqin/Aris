import { useState } from "react";
import type { Copy } from "../i18n";

type Props = {
  copy: Copy;
};

type ViewMode = "metrics" | "domains" | "table";

export default function Benchmark({ copy }: Props) {
  const { benchmark } = copy;
  const [activeTab, setActiveTab] = useState<ViewMode>("metrics");

  const metricGroups = benchmark.metricGroups;
  const domainGroups = benchmark.domainGroups;

  return (
    <section id="benchmark" className="section section--raised">
      <div className="container">
        {/* Section Header */}
        <div className="benchmark-header-wrap" data-reveal>
          <div className="section-head">
            <p className="kicker">{benchmark.kicker}</p>
            <h2 className="section-title">{benchmark.title}</h2>
            <p className="section-lede">{benchmark.lede}</p>
          </div>

          {/* Apple-style Fluid Segmented Controller */}
          <div className="apple-segmented-control" role="tablist" aria-label="Benchmark View Toggle">
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === "metrics"}
              className={`apple-segment-btn ${activeTab === "metrics" ? "active" : ""}`}
              onClick={() => setActiveTab("metrics")}
            >
              <span className="apple-segment-icon">📊</span>
              <span>{benchmark.tabs.metrics}</span>
            </button>

            <button
              type="button"
              role="tab"
              aria-selected={activeTab === "domains"}
              className={`apple-segment-btn ${activeTab === "domains" ? "active" : ""}`}
              onClick={() => setActiveTab("domains")}
            >
              <span className="apple-segment-icon">🔬</span>
              <span>{benchmark.tabs.domains}</span>
            </button>

            <button
              type="button"
              role="tab"
              aria-selected={activeTab === "table"}
              className={`apple-segment-btn ${activeTab === "table" ? "active" : ""}`}
              onClick={() => setActiveTab("table")}
            >
              <span className="apple-segment-icon">📋</span>
              <span>{benchmark.tabs.table}</span>
            </button>
          </div>
        </div>

        {/* ── Apple-Style Interactive Display Stage ─────────────────────────── */}
        <div className="apple-benchmark-stage" data-reveal>
          {activeTab !== "table" ? (
            /* ══ Visual Bar Chart View ══ */
            <div className="apple-chart-card">
              {/* Chart Meta Header */}
              <div className="apple-chart-head">
                <div className="apple-chart-title-box">
                  <span className="apple-chart-badge">
                    {activeTab === "metrics"
                      ? benchmark.chartHead.metricsBadge
                      : benchmark.chartHead.domainsBadge}
                  </span>
                  <h3>
                    {activeTab === "metrics"
                      ? benchmark.chartHead.metricsTitle
                      : benchmark.chartHead.domainsTitle}
                  </h3>
                </div>

                {/* Apple-style Model Legend */}
                <div className="apple-legend">
                  {activeTab === "metrics" ? (
                    <>
                      <div className="apple-legend-item apple-legend-item--lead">
                        <span className="apple-legend-dot apple-legend-dot--lead" />
                        <strong>DeepSeek V4Flash</strong>
                        <span className="apple-legend-tag">{benchmark.legend.somniRec}</span>
                      </div>
                      <div className="apple-legend-item">
                        <span className="apple-legend-dot apple-legend-dot--blue" />
                        <span>Codex · GPT-5.6</span>
                      </div>
                      <div className="apple-legend-item">
                        <span className="apple-legend-dot apple-legend-dot--amber" />
                        <span>Minimax-V3</span>
                      </div>
                    </>
                  ) : (
                    <>
                      <div className="apple-legend-item apple-legend-item--lead">
                        <span className="apple-legend-dot apple-legend-dot--lead" />
                        <strong>{benchmark.legend.arisReviewed}</strong>
                        <span className="apple-legend-tag">{benchmark.legend.reviewGain}</span>
                      </div>
                      <div className="apple-legend-item">
                        <span className="apple-legend-dot apple-legend-dot--blue" />
                        <span>Codex · GPT-5.6</span>
                      </div>
                      <div className="apple-legend-item">
                        <span className="apple-legend-dot apple-legend-dot--dim" />
                        <span>{benchmark.legend.unreviewed}</span>
                      </div>
                    </>
                  )}
                </div>
              </div>

              {/* Chart Stage Canvas with smooth scroll wrap */}
              <div className="apple-chart-scroll-wrap">
                <div className="apple-canvas-container">
                  {/* Background Grid & Ticks */}
                  <div className="apple-grid-layer">
                    {(activeTab === "metrics" ? [100, 75, 50, 25, 0] : [50, 40, 30, 20, 10, 0]).map(
                      (tick) => (
                        <div key={tick} className="apple-grid-row">
                          <span className="apple-grid-label">{tick}%</span>
                          <div className="apple-grid-line" />
                        </div>
                      )
                    )}
                  </div>

                  {/* Foreground Animated Columns */}
                  <div className="apple-columns-layer">
                    {activeTab === "metrics" ? (
                      /* 3 Core Metric Pillar Groups */
                      <div className="apple-pillar-groups apple-pillar-groups--3">
                        {metricGroups.map((grp) => (
                          <div key={grp.id} className="apple-pillar-group">
                            <div className="apple-pillar-bars">
                              {grp.items.map((item) => (
                                <div
                                  key={item.name}
                                  className={`apple-pillar-slot apple-pillar-slot--${item.color}`}
                                >
                                  <div
                                    className={`apple-pillar-bar apple-pillar-bar--${item.color}`}
                                    style={{ height: `${item.val}%` }}
                                  >
                                    <span className="apple-pillar-sheen" />
                                    {/* Number dynamically riding on top of the bar */}
                                    <span className="apple-pillar-number">
                                      {item.display}
                                    </span>
                                  </div>
                                </div>
                              ))}
                            </div>

                            <div className="apple-pillar-labels">
                              {grp.items.map((item) => (
                                <span
                                  key={item.name}
                                  className={`apple-pillar-label apple-pillar-label--${item.color}`}
                                >
                                  {item.name.split(" ")[0]}
                                </span>
                              ))}
                            </div>

                            <div className="apple-group-footer">
                              <div className="apple-group-title-row">
                                <strong>{grp.title}</strong>
                                <span className="apple-group-badge">{grp.badge}</span>
                              </div>
                              <p className="apple-group-desc">{grp.desc}</p>
                            </div>
                          </div>
                        ))}
                      </div>
                    ) : (
                      /* 6 Domain Pillar Groups */
                      <div className="apple-pillar-groups apple-pillar-groups--6">
                        {domainGroups.map((grp) => (
                          <div key={grp.domain} className="apple-pillar-group">
                            <div className="apple-pillar-bars">
                              {grp.items.map((item) => (
                                <div
                                  key={item.name}
                                  className={`apple-pillar-slot apple-pillar-slot--${item.color}`}
                                >
                                  <div
                                    className={`apple-pillar-bar apple-pillar-bar--${item.color}`}
                                    style={{ height: `${(item.val / 50) * 100}%` }}
                                  >
                                    <span className="apple-pillar-sheen" />
                                    {/* Number dynamically riding on top of the bar */}
                                    <span className="apple-pillar-number">
                                      {item.display}
                                    </span>
                                  </div>
                                </div>
                              ))}
                            </div>

                            <div className="apple-pillar-labels">
                              {grp.items.map((item) => (
                                <span
                                  key={item.name}
                                  className={`apple-pillar-label apple-pillar-label--${item.color}`}
                                >
                                  {item.name.includes("ARIS")
                                    ? "ARIS"
                                    : item.name.includes("Codex")
                                      ? "Codex"
                                      : benchmark.legend.baselineTag}
                                </span>
                              ))}
                            </div>

                            <div className="apple-group-footer">
                              <strong>{grp.domain}</strong>
                              <p className="apple-group-desc">{grp.desc}</p>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              </div>

              {/* Apple-style Key Takeaway Banner */}
              <div className="apple-takeaway-banner">
                <div className="apple-takeaway-glow" />
                <div className="apple-takeaway-content">
                  <div className="apple-takeaway-icon-pill">
                    <span className="apple-sparkle">✨</span>
                    <span>{benchmark.takeaway.badge}</span>
                  </div>
                  <p>
                    {activeTab === "metrics"
                      ? benchmark.takeaway.metrics
                      : benchmark.takeaway.domains}
                  </p>
                </div>
              </div>
            </div>
          ) : (
            /* ══ Detailed Data Tables View ══ */
            <div className="apple-tables-wrap">
              <div className="benchmark-table-card">
                <div className="benchmark-table-head">
                  <div>
                    <p className="benchmark-table-kicker">01 / RESULT MATRIX</p>
                    <h3>{benchmark.tableTitle}</h3>
                  </div>
                  <p id="benchmark-table-note">{benchmark.tableMeta}</p>
                </div>

                <div className="benchmark-table-scroll">
                  <table className="benchmark-table" aria-describedby="benchmark-table-note">
                    <thead>
                      <tr>
                        <th scope="col">{benchmark.systemLabel}</th>
                        <th scope="col">{benchmark.modelLabel}</th>
                        {benchmark.metrics.map((metric) => (
                          <th key={metric.label} scope="col">
                            <span>{metric.label}</span>
                            <span
                              className={`benchmark-direction benchmark-direction--${
                                metric.direction === "↑" ? "up" : "down"
                              }`}
                              aria-label={metric.direction}
                            >
                              {metric.direction}
                            </span>
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {benchmark.rows.map((row, rowIndex) => (
                        <tr key={row.model}>
                          <th scope="row">
                            <span className="benchmark-system-mark" aria-hidden="true" />
                            {row.system}
                          </th>
                          <td>
                            <strong>{row.model}</strong>
                            <span className={`benchmark-row-tag benchmark-row-tag--${rowIndex}`}>
                              {row.tag}
                            </span>
                          </td>
                          {row.values.map((value, valueIndex) => (
                            <td
                              key={`${row.model}-${benchmark.metrics[valueIndex].label}`}
                              className={
                                valueIndex === 3
                                  ? "benchmark-cell--hazard"
                                  : valueIndex === 4
                                    ? "benchmark-cell--resistance"
                                    : undefined
                              }
                            >
                              {value}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>

              <div className="benchmark-table-card benchmark-domain-card">
                <div className="benchmark-table-head">
                  <div>
                    <p className="benchmark-table-kicker">02 / DOMAIN RESISTANCE</p>
                    <h3>{benchmark.domainTable.title}</h3>
                  </div>
                  <p id="benchmark-domain-note">{benchmark.domainTable.meta}</p>
                </div>

                <div className="benchmark-table-scroll">
                  <table
                    className="benchmark-table benchmark-domain-table"
                    aria-describedby="benchmark-domain-note"
                  >
                    <thead>
                      <tr>
                        <th scope="col">{benchmark.domainTable.systemLabel}</th>
                        {benchmark.domainTable.metrics.map((metric) => (
                          <th key={metric.label} scope="col">
                            <span>{metric.label}</span>
                            <span
                              className={`benchmark-direction benchmark-direction--${
                                metric.direction === "↑" ? "up" : "down"
                              }`}
                              aria-label={metric.direction}
                            >
                              {metric.direction}
                            </span>
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {benchmark.domainTable.rows.map((row) => (
                        <tr key={row.system}>
                          <th scope="row">
                            <span className="benchmark-system-mark" aria-hidden="true" />
                            {row.system}
                          </th>
                          {row.values.map((value, valueIndex) => (
                            <td
                              key={`${row.system}-${benchmark.domainTable.metrics[valueIndex].label}`}
                            >
                              {value}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          )}
        </div>

        <aside className="benchmark-method" data-reveal>
          <span className="benchmark-method-mark" aria-hidden="true">
            i
          </span>
          <div>
            <strong>{benchmark.methodTitle}</strong>
            <p>{benchmark.methodNote}</p>
          </div>
        </aside>
      </div>
    </section>
  );
}

