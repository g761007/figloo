import type { ErrorCode } from "@figloo/protocol";
import { TabInBackground } from "./dom-source.js";
import type { ReadingOverlay } from "./overlay.js";
import { StopExploration } from "./tree.js";
import type { BackgroundPause } from "./visibility.js";

/** Per-operation budgets from the plan: 15 s of UI work and a bounded number of UI operations. */
export const OP_TIME_BUDGET_MS = 15_000;
export const OP_MAX_UI_OPS = 300;
export const MAX_NAME_LENGTH = 200;
export const BACKGROUND_MESSAGE = "the Figma tab is in the background, where Figma does not apply selection, zoom, or page changes";

/** Budgets of one operation, and what happens to the layers panel when the user steps in. */
export interface RunLimits {
  timeBudgetMs: number;
  maxUiOps: number;
  /** Close the layers this operation opened even after the user stepped in, until their next input. */
  collapseAfterInterrupt?: boolean;
  /** Shown during the operation: input on it is not the user stepping in, and its Stop ends the operation. */
  overlay?: ReadingOverlay;
  /** Wait while the tab is in the background instead of failing; ending there puts the panel back once the tab returns. */
  pause?: BackgroundPause;
}

export const DEFAULT_LIMITS: RunLimits = { timeBudgetMs: OP_TIME_BUDGET_MS, maxUiOps: OP_MAX_UI_OPS };

/** What the user had selected: none, one layer, several found layers, or several Figloo could not all find. */
export type UserSelection = { kind: "none" } | { kind: "layer"; id: string } | { kind: "layers"; ids: string[] } | { kind: "multiple" };

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
export const normalized = (text: string) => text.replace(/\s+/g, " ").trim();

export class OpError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "OpError";
  }
}

export interface UserWatch {
  interrupted: () => boolean;
  /** How many inputs the user made so far. */
  inputs: () => number;
  dispose: () => void;
}

/** Any trusted pointer, key, or wheel input during an operation means the user took over, except input on the overlay. */
export function watchForUser(win: Window, overlay?: ReadingOverlay): UserWatch {
  let inputs = 0;
  const onInput = (event: Event) => {
    if (event.isTrusted && !overlay?.owns(event)) inputs += 1;
  };
  const types = ["pointerdown", "keydown", "wheel"];
  for (const type of types) win.addEventListener(type, onInput, { capture: true, passive: true });
  return {
    interrupted: () => inputs > 0,
    inputs: () => inputs,
    dispose: () => {
      for (const type of types) win.removeEventListener(type, onInput, { capture: true });
    },
  };
}

export function parseZoom(label: string | null): number | null {
  const match = label ? /^([\d.]+)%$/.exec(label) : null;
  return match ? Number(match[1]) / 100 : null;
}

export function translate(error: unknown): unknown {
  if (error instanceof TabInBackground) {
    return new OpError("TAB_IN_BACKGROUND", "the Figma tab is in the background, where Figma does not expand layers");
  }
  if (!(error instanceof StopExploration)) return error;
  if (error.cause === "user_interrupted") return new OpError("USER_INTERRUPTED", "the user interacted with Figma during the operation");
  if (error.cause === "ui_timeout") return new OpError("UI_NOT_READY", "the layers panel did not respond in time");
  return new OpError("BUDGET_EXCEEDED", `stopped by the ${error.cause.replace("_", " ")}`);
}
