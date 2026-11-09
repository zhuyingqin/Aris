import { useSyncExternalStore } from "react";
import { hasNativeBackend } from "./api/transport";
import { getEmptyModelPricingSnapshot, getModelPricingSnapshot, subscribeModelPricing } from "./modelPricingState";

const subscribeDisabled = () => () => {};

/** Both selectors share one account-scoped request/cache. Remote-node prices are separate. */
export function useModelPricing(enabled = true) {
  const active = enabled && hasNativeBackend();
  const state = useSyncExternalStore(active ? subscribeModelPricing : subscribeDisabled,
    active ? getModelPricingSnapshot : getEmptyModelPricingSnapshot);
  return active ? state : null;
}
