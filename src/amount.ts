import { invalidInput } from "./errors.js";

/** "1.25" with 6 decimals → 1250000n. Exact: no floats, no rounding; more decimals than the asset has is an error. */
export function decimalToAtomic(amount: string, decimals: number): bigint {
  const m = /^(\d{1,30})(?:\.(\d{1,30}))?$/.exec(amount.trim());
  if (!m) throw invalidInput(`amount must be a positive decimal string such as "1.25", got ${JSON.stringify(amount)}`);
  const whole = m[1]!;
  const frac = m[2] ?? "";
  if (frac.length > decimals) throw invalidInput(`amount ${amount} has more than ${decimals} decimals`);
  const atomic = BigInt(whole + frac.padEnd(decimals, "0"));
  if (atomic <= 0n) throw invalidInput("amount must be greater than zero");
  return atomic;
}

/** 1250000n with 6 decimals → "1.25" (trailing zeros trimmed, at least one integer digit). */
export function atomicToDecimal(atomic: bigint | string, decimals: number): string {
  const v = typeof atomic === "bigint" ? atomic : BigInt(atomic);
  const neg = v < 0n;
  const s = (neg ? -v : v).toString().padStart(decimals + 1, "0");
  const whole = s.slice(0, s.length - decimals);
  const frac = s.slice(s.length - decimals).replace(/0+$/, "");
  return `${neg ? "-" : ""}${whole}${frac ? `.${frac}` : ""}`;
}
