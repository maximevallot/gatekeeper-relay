// The extension's engine, vendored unchanged (vendor/engine/SOURCE.md names the commit), and the one way the
// account calls it: inside the account's time zone.
// @ts-ignore: plain JavaScript, typed as the account uses it
import * as E from "../../vendor/engine/engine.js";
import { withTimeZone } from "./tz";

/** The engine's functions. Its state is a plain object the account stores as it is. */
export const engine = E as unknown as Record<string, (...args: any[]) => any> & { CONSENT: Record<string, number> };

export type State = Record<string, any>;

export function inZone<T>(tz: string, fn: () => T): T {
  return withTimeZone(tz, fn);
}

/** Fields each device keeps for itself; the account's copy never carries or overwrites them. */
export const DEVICE_FIELDS = ["clock", "calendar", "judging", "unknown", "sorting", "withheld", "offersDismissed"] as const;

/**
 * Today, ready-made, for a device that can't run the engine (the Mac app): engine.snapshot as the
 * native-messaging contract v1 has it, without the extension's pages and id.
 */
export function todayFor(state: State, tz: string, now: number): State {
  const snap = inZone(tz, () => engine.snapshot(state, now, {}));
  const { pages, extensionId, base, ...rest } = snap;
  return rest;
}

export function copyOf(state: State): State {
  const c: State = { ...state };
  for (const f of DEVICE_FIELDS) delete c[f];
  return c;
}
