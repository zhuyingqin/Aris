import type { Language } from "../store";
import type { ConfigTestResult } from "../types";
import { formatServerLabel, hideManagedServerAddress } from "./settingsProviderCatalog";

export default function TestDetail({ detail, language }: { detail: ConfigTestResult["executor"]; language: Language }) {
  return (
    <div className={`st-test-detail${detail.ok ? " ok" : " failed"}`}>
      <div className="st-test-detail-head">
        <span className="st-test-dot" />
        <span className="st-test-label">{detail.label}</span>
        {detail.model && <span className="st-test-meta">{detail.model}</span>}
      </div>
      <div className="st-test-message">{hideManagedServerAddress(detail.message, language)}</div>
      {detail.baseUrl && <div className="st-test-url">{formatServerLabel(detail.baseUrl, language)}</div>}
    </div>
  );
}
