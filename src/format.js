import { WEI_PER_GWEI, WEI_PER_USDC } from "./config.js";

/** 42 -> "42s", 302 -> "5m 2s", 7260 -> "2h 1m". */
export function formatDuration(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  if (s < 60) return `${s}s`;
  if (s < 3600) {
    const rest = s % 60;
    return rest === 0 ? `${Math.floor(s / 60)}m` : `${Math.floor(s / 60)}m ${rest}s`;
  }
  const hours = Math.floor(s / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`;
}

function formatUnits(value, unit, decimals) {
  const v = BigInt(value);
  const negative = v < 0n;
  const abs = negative ? -v : v;
  const whole = abs / unit;
  const scale = 10n ** BigInt(decimals);
  const fraction = ((abs % unit) * scale) / unit;
  let text = whole.toString();
  if (decimals > 0) {
    const frac = fraction.toString().padStart(decimals, "0").replace(/0+$/, "");
    if (frac) text += "." + frac;
  }
  return negative ? "-" + text : text;
}

/** Wei (18 decimals) to a USDC string truncated to 6 decimals. */
export const formatUsdc = (wei) => formatUnits(wei, WEI_PER_USDC, 6);

/** Wei to a gwei string truncated to 3 decimals. */
export const formatGwei = (wei) => formatUnits(wei, WEI_PER_GWEI, 3);

export function requestLink(net, requestId) {
  return `${net.explorer}/request/${net.coordinator}/${requestId}`;
}

export function listWithMore(items, max) {
  if (items.length <= max) return items.join(", ");
  return `${items.slice(0, max).join(", ")} and ${items.length - max} more`;
}
