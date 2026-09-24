import { describe, expect, it } from "vitest";
import {
  LEGACY_MANAGED_NEWAPI_BASE_URL,
  MANAGED_NEWAPI_BASE_URL,
  approvedManagedNewApiBaseUrl,
  isLegacyManagedNewApiUrl,
  secureManagedNewApiBaseUrl,
} from "./managedNewApi";
import { isManagedModelServerUrl } from "./settings/settingsProviderCatalog";

describe("managed New API endpoint", () => {
  it("uses an HTTPS release candidate and accepts only its exact origin", () => {
    expect(MANAGED_NEWAPI_BASE_URL).toMatch(/^https:\/\//);
    expect(approvedManagedNewApiBaseUrl(`${MANAGED_NEWAPI_BASE_URL}/`)).toBe(MANAGED_NEWAPI_BASE_URL);
    expect(approvedManagedNewApiBaseUrl("https://other.example")).toBe("");
    expect(approvedManagedNewApiBaseUrl(LEGACY_MANAGED_NEWAPI_BASE_URL)).toBe("");
  });

  it("blocks public HTTP and URL parts that could redirect credentials", () => {
    expect(secureManagedNewApiBaseUrl("http://106.53.28.124:18080")).toBe("");
    expect(secureManagedNewApiBaseUrl("https://user:password@somni.ensuanx.com")).toBe("");
    expect(secureManagedNewApiBaseUrl("https://somni.ensuanx.com/api")).toBe("");
    expect(secureManagedNewApiBaseUrl("http://127.0.0.1:18080")).toBe("http://127.0.0.1:18080");
  });

  it("recognizes the retired address for display without using it", () => {
    expect(isLegacyManagedNewApiUrl(`${LEGACY_MANAGED_NEWAPI_BASE_URL}/v1`)).toBe(true);
    expect(isManagedModelServerUrl(`${MANAGED_NEWAPI_BASE_URL}/v1`)).toBe(true);
    expect(isManagedModelServerUrl(`${LEGACY_MANAGED_NEWAPI_BASE_URL}/v1`)).toBe(true);
  });
});
