import type { CloudModelOption } from "@reai/app-sdk/v1";
import { currentAccountPricing } from "./cloud-selection";
import { t } from "./voice-i18n";

export interface AccountEffectivePrice {
  unit: "second";
  unitPriceCents: string;
  baseUnitPriceCents: string;
  reason: "subscription_privilege" | "subscription_price" | "published_price";
  ruleRevision: string;
  policyRevision: string | null;
  subscriptionRevision: string | null;
  evaluatedAt: string;
  validUntil: string | null;
}
const decimal = (value: unknown): value is string => typeof value === "string" && value.length <= 256 && /^\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(value);
const revision = (value: unknown): boolean => typeof value === "string" && value.length > 0 && value.length <= 256;
const time = (value: unknown): value is string => typeof value === "string" && value.length <= 64 && Number.isFinite(Date.parse(value));

/** Keep the exact effective decimal, including zero and very small nonzero quotes.
 * An expired or incomplete account quote is unknown, never a free-price fallback. */
export function currentAccountPrice(model: CloudModelOption, now = Date.now()): AccountEffectivePrice | undefined {
  if (!currentAccountPricing(model)) return undefined;
  const price = (model as CloudModelOption & { effectivePrice?: AccountEffectivePrice }).effectivePrice;
  if (!price || price.unit !== "second" || !decimal(price.unitPriceCents) || !decimal(price.baseUnitPriceCents)
    || !["subscription_privilege", "subscription_price", "published_price"].includes(price.reason)
    || !revision(price.ruleRevision) || !(price.policyRevision === null || revision(price.policyRevision))
    || !(price.subscriptionRevision === null || revision(price.subscriptionRevision)) || !time(price.evaluatedAt)
    || !(price.validUntil === null || (time(price.validUntil) && Date.parse(price.validUntil) > now))) return undefined;
  return price;
}

export function cloudAccountPriceLabel(model: CloudModelOption, freeOnly = false): string | undefined {
  if (!currentAccountPricing(model)) return undefined;
  const price = currentAccountPrice(model);
  if (!price) return t("view.cloudAccountPriceUnavailable");
  const reason = price.reason === "subscription_privilege" ? t("view.cloudPricingReason.subscriptionPrivilege")
    : price.reason === "subscription_price" ? t("view.cloudPricingReason.subscriptionPrice") : t("view.cloudPricingReason.publishedPrice");
  const quote = t("view.cloudAccountPrice", { price: price.unitPriceCents, reason });
  return freeOnly ? t("view.cloudAccountPriceFreeOnly", { quote }) : quote;
}
