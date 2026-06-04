export function fmtTs(ts: number | undefined | null): string {
  if (!ts) return "";
  // run-state stores epoch seconds; tolerate millis too.
  const ms = ts < 1e12 ? ts * 1000 : ts;
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString();
}

export function fmtClock(ts: number | undefined | null): string {
  if (!ts) return "";
  const ms = ts < 1e12 ? ts * 1000 : ts;
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString();
}

export function Badge({ status }: { status: string }) {
  const cls = `badge st-${status.toLowerCase()}`;
  return <span className={cls}>{status.replace(/_/g, " ")}</span>;
}
