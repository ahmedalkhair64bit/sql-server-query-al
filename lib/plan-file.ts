import { decodeBytes } from "./plan-decoder.mjs";
export const decodePlan = (bytes: Uint8Array): string => decodeBytes(bytes);
