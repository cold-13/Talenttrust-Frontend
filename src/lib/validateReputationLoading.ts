import { sanitizeUserText } from './sanitizeUserText';

/**
 * Validation boundaries for the reputation loading state
 * (`src/app/reputation/loading.tsx` and its client wrapper
 * `src/app/reputation/ReputationLoadingClient.tsx`).
 *
 * The loading state is reached during a route transition, so every value it
 * accepts has to be safe to resolve *before* any real content exists: an
 * invalid delay must not park focus on the wrong element, and an invalid
 * announcement must not be spoken to a screen reader. All validation is
 * therefore pure, total (never throws for hostile input), and deterministic:
 * the same input always produces the same options and the same rejection list.
 */

/** Lower bound for the focus delay. `0` is allowed and means "next tick". */
export const MIN_FOCUS_DELAY_MS = 0;

/**
 * Upper bound for the focus delay. Anything longer is clamped here because a
 * focus that arrives seconds after the skeleton is gone moves focus into an
 * unrelated element.
 */
export const MAX_FOCUS_DELAY_MS = 2000;

/** Focus delay used when no delay is supplied or the supplied one is unusable. */
export const DEFAULT_FOCUS_DELAY_MS = 100;

/**
 * Maximum length of the screen-reader announcement. Long enough for
 * "Loading reputation…" plus a qualifier, short enough that a passing string
 * cannot flood the live region.
 */
export const MAX_ANNOUNCEMENT_LENGTH = 120;

/** Announcement rendered when none is supplied or the supplied one is unusable. */
export const DEFAULT_ANNOUNCEMENT = 'Loading reputation…';

/**
 * Raw, untrusted input accepted by the reputation loading components.
 *
 * Every field is `unknown` on purpose: callers are JSX props, JSON, or test
 * doubles, so the boundary — not the type system — decides what is usable.
 */
export interface ReputationLoadingInput {
  focusDelayMs?: unknown;
  announcement?: unknown;
  autoFocus?: unknown;
  embedded?: unknown;
}

/** Fully validated options. Safe to hand to the DOM without further checks. */
export interface ReputationLoadingOptions {
  /** Finite integer delay between `MIN_FOCUS_DELAY_MS` and `MAX_FOCUS_DELAY_MS`. */
  focusDelayMs: number;
  /** Non-empty, control-character-free announcement within the length ceiling. */
  announcement: string;
  /** Whether the wrapper may move focus on mount. */
  autoFocus: boolean;
  /** Whether the skeleton renders inside a landmark the wrapper already owns. */
  embedded: boolean;
}

/** Machine-readable reason a value was replaced with its default. */
export type ReputationLoadingRejectionCode =
  | 'FOCUS_DELAY_NOT_A_NUMBER'
  | 'FOCUS_DELAY_NOT_FINITE'
  | 'FOCUS_DELAY_BELOW_MINIMUM'
  | 'FOCUS_DELAY_ABOVE_MAXIMUM'
  | 'ANNOUNCEMENT_NOT_A_STRING'
  | 'ANNOUNCEMENT_EMPTY'
  | 'ANNOUNCEMENT_TOO_LONG'
  | 'FLAG_NOT_BOOLEAN';

/** A single rejected input. `field` names the prop, never the value. */
export interface ReputationLoadingRejection {
  field: keyof ReputationLoadingInput;
  code: ReputationLoadingRejectionCode;
}

/** Result of resolving untrusted input against the loading boundaries. */
export interface ReputationLoadingResolution {
  options: ReputationLoadingOptions;
  rejections: ReputationLoadingRejection[];
}

/** Reason a focus application was not performed. */
export type FocusSkipCode =
  | 'FOCUS_DISABLED'
  | 'FOCUS_ALREADY_APPLIED'
  | 'FOCUS_TARGET_UNAVAILABLE'
  | 'FOCUS_SUPPRESSED_BY_USER';

export interface FocusApplicationDecision {
  shouldApply: boolean;
  code?: FocusSkipCode;
}

export interface FocusApplicationInput {
  /** Resolved focus target, or `null` when the wrapper is not mounted/connected. */
  target: HTMLElement | null;
  /** Validated `autoFocus` option. */
  autoFocus: boolean;
  /** `true` once focus has been applied for the current mount. */
  alreadyApplied: boolean;
  /** `document.activeElement` at the moment the decision is made. */
  activeElement: Element | null;
  /** Element that held focus when the wrapper mounted. */
  previousFocus: HTMLElement | null;
}

function resolveFocusDelay(
  value: unknown,
  rejections: ReputationLoadingRejection[],
): number {
  if (value === undefined || value === null) return DEFAULT_FOCUS_DELAY_MS;

  if (typeof value !== 'number' || Number.isNaN(value)) {
    rejections.push({ field: 'focusDelayMs', code: 'FOCUS_DELAY_NOT_A_NUMBER' });
    return DEFAULT_FOCUS_DELAY_MS;
  }

  if (!Number.isFinite(value)) {
    rejections.push({ field: 'focusDelayMs', code: 'FOCUS_DELAY_NOT_FINITE' });
    return DEFAULT_FOCUS_DELAY_MS;
  }

  // Sub-millisecond values are floored rather than rejected: the caller asked
  // for a delay, the value is simply finer grained than the platform supports.
  const floored = Math.floor(value);

  if (floored < MIN_FOCUS_DELAY_MS) {
    rejections.push({ field: 'focusDelayMs', code: 'FOCUS_DELAY_BELOW_MINIMUM' });
    return MIN_FOCUS_DELAY_MS;
  }

  if (floored > MAX_FOCUS_DELAY_MS) {
    rejections.push({ field: 'focusDelayMs', code: 'FOCUS_DELAY_ABOVE_MAXIMUM' });
    return MAX_FOCUS_DELAY_MS;
  }

  return floored;
}

function resolveAnnouncement(
  value: unknown,
  rejections: ReputationLoadingRejection[],
): string {
  if (value === undefined || value === null) return DEFAULT_ANNOUNCEMENT;

  if (typeof value !== 'string') {
    rejections.push({ field: 'announcement', code: 'ANNOUNCEMENT_NOT_A_STRING' });
    return DEFAULT_ANNOUNCEMENT;
  }

  const bounded = sanitizeUserText(value, MAX_ANNOUNCEMENT_LENGTH);
  if (!bounded) {
    rejections.push({ field: 'announcement', code: 'ANNOUNCEMENT_EMPTY' });
    return DEFAULT_ANNOUNCEMENT;
  }

  // Over-long announcements are rejected instead of truncated so the caller
  // learns its input was unusable rather than hearing a clipped message.
  if (bounded.length < sanitizeUserText(value, Number.MAX_SAFE_INTEGER).length) {
    rejections.push({ field: 'announcement', code: 'ANNOUNCEMENT_TOO_LONG' });
    return DEFAULT_ANNOUNCEMENT;
  }

  return bounded;
}

function resolveFlag(
  value: unknown,
  field: keyof ReputationLoadingInput,
  fallback: boolean,
  rejections: ReputationLoadingRejection[],
): boolean {
  if (value === undefined || value === null) return fallback;

  if (typeof value !== 'boolean') {
    rejections.push({ field, code: 'FLAG_NOT_BOOLEAN' });
    return fallback;
  }

  return value;
}

/**
 * Resolves untrusted input into validated loading options plus the list of
 * values that had to be replaced by their defaults.
 *
 * Rejections describe *which field* failed and *why*; the offending value is
 * never echoed back, so reports stay safe to log.
 */
export function resolveReputationLoadingOptions(
  input: ReputationLoadingInput = {},
): ReputationLoadingResolution {
  const rejections: ReputationLoadingRejection[] = [];
  const source: ReputationLoadingInput =
    typeof input === 'object' && input !== null ? input : {};

  return {
    options: {
      focusDelayMs: resolveFocusDelay(source.focusDelayMs, rejections),
      announcement: resolveAnnouncement(source.announcement, rejections),
      autoFocus: resolveFlag(source.autoFocus, 'autoFocus', true, rejections),
      embedded: resolveFlag(source.embedded, 'embedded', false, rejections),
    },
    rejections,
  };
}

/**
 * Returns the focus target only when it is connected to the document and
 * actually focusable. A disconnected or unfocusable element yields `null` so
 * the caller skips focus instead of throwing or focusing a stale node.
 */
export function resolveLoadingFocusTarget(
  scope: HTMLElement | null | undefined,
): HTMLElement | null {
  if (!(scope instanceof HTMLElement)) return null;
  if (!scope.isConnected) return null;
  // `tabIndex` is -1 for a programmatic-only target and >= 0 when it is also
  // reachable by keyboard; anything else means the element cannot take focus.
  if (scope.tabIndex < -1) return null;
  if (scope.hasAttribute('disabled') || scope.closest('[inert]')) return null;
  return scope;
}

/**
 * Decides whether focus may be moved at this point in time.
 *
 * Pure on purpose: the ordering rules below are the invariants the wrapper
 * relies on, and they are cheaper to prove with unit tests than through
 * timers.
 *
 * Invariants, in order:
 * 1. A disabled wrapper never takes focus.
 * 2. Focus is applied at most once per mount (no duplicate/second attempt).
 * 3. Without a resolved target, nothing happens (unmounted or replaced node).
 * 4. Focus is never stolen from an element the user focused after mount;
 *    focus still sitting on the pre-mount element or on `<body>` is fair game.
 */
export function decideLoadingFocusApplication(
  input: FocusApplicationInput,
): FocusApplicationDecision {
  if (!input.autoFocus) return { shouldApply: false, code: 'FOCUS_DISABLED' };
  if (input.alreadyApplied) return { shouldApply: false, code: 'FOCUS_ALREADY_APPLIED' };
  if (!input.target) return { shouldApply: false, code: 'FOCUS_TARGET_UNAVAILABLE' };

  const { activeElement, previousFocus } = input;
  const userMovedFocus =
    activeElement instanceof HTMLElement &&
    activeElement !== previousFocus &&
    activeElement !== activeElement.ownerDocument?.body;

  if (userMovedFocus) return { shouldApply: false, code: 'FOCUS_SUPPRESSED_BY_USER' };

  return { shouldApply: true };
}