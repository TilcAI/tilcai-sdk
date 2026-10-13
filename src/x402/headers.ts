import { TilcaiError } from "../errors.js";

export const HEADER_REQUIRED = "PAYMENT-REQUIRED";
export const HEADER_SIGNATURE = "PAYMENT-SIGNATURE";
export const HEADER_RESPONSE = "PAYMENT-RESPONSE";

export function encodeHeader(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64");
}

export function decodeHeader<T>(value: string, what = "x402 header"): T {
  try {
    return JSON.parse(Buffer.from(value, "base64").toString("utf8")) as T;
  } catch (cause) {
    throw new TilcaiError({ status: 0, code: "INVALID_INPUT", message: `${what} is not base64-encoded JSON`, recovery: "FIX_REQUEST", cause });
  }
}
