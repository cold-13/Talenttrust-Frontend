# Reputation loading state — validation boundaries

Contract for `src/app/reputation/loading.tsx` and its client wrapper
`src/app/reputation/ReputationLoadingClient.tsx`. It records what the loading
state accepts, what it rejects, and the invariants that hold under retries,
partial failure, and concurrent execution.

The loading state is reached during a route transition, before any reputation
data exists. Every value it accepts therefore has to be safe *before* real
content is available: an invalid focus delay must not park focus on an
unrelated element, and an invalid announcement must not be spoken into a live
region.

## Modules

| Module | Responsibility |
| --- | --- |
| `src/lib/validateReputationLoading.ts` | Pure validation and resolution. No React, no DOM reads. |
| `src/app/reputation/loading.tsx` | Suspense skeleton. Resolves its own props before rendering. |
| `src/app/reputation/ReputationLoadingClient.tsx` | Owns the `<main>` landmark, the focus transition, and the failure-recovery state machine. |

The wrapper is a class component because it owns the `loading → error →
recovering → exhausted` state machine, retry locking, and timeout handling
described in `docs/components/ReputationAccessibility.md`. The validation
boundary is layered on top of that rather than replacing it: `focusDelayMs`,
`announcement`, and `autoFocus` are resolved before any timer is scheduled or
any value reaches the DOM. The module's existing normalisers —
`normalizeError`, `normalizeMaxRetries`, `normalizeTimeoutMs` — cover the
recovery props and follow the same "resolve to a safe value, never throw"
convention.

## Props

`ReputationLoadingClient`:

| Prop | Type | Default | Notes |
| --- | --- | --- | --- |
| `focusDelayMs` | `number` | `100` | Bounded to `0…2000`. Invalid input falls back to the default or is clamped. |
| `announcement` | `string` | `"Loading reputation…"` | Sanitised and capped at 120 characters. |
| `autoFocus` | `boolean` | `true` | `false` skips the focus transition entirely. |

`loading.tsx`:

| Prop | Type | Default | Notes |
| --- | --- | --- | --- |
| `announcement` | `string` | `"Loading reputation…"` | Same rules as above. |
| `embedded` | `boolean` | `false` | `true` suppresses the skeleton's own `<main>` and `aria-busy`. |

All props are optional, so `ReputationLoading` and `ReputationLoadingClient`
keep working with no arguments. Existing callers are unaffected.

## Validation rules

`resolveReputationLoadingOptions(input)` returns
`{ options, rejections }`. `options` is always fully populated with in-range
values; `rejections` lists every field that had to be replaced. The function
never throws, including for `undefined`, a non-object argument, or an object
with a null prototype.

### `focusDelayMs`

| Input | Result | Code |
| --- | --- | --- |
| omitted, `undefined`, `null` | `100` (`DEFAULT_FOCUS_DELAY_MS`) | — |
| non-number (`string`, `NaN`, object) | `100` | `FOCUS_DELAY_NOT_A_NUMBER` |
| `Infinity` / `-Infinity` | `100` | `FOCUS_DELAY_NOT_FINITE` |
| `< 0` | `0` (`MIN_FOCUS_DELAY_MS`) | `FOCUS_DELAY_BELOW_MINIMUM` |
| `> 2000` | `2000` (`MAX_FOCUS_DELAY_MS`) | `FOCUS_DELAY_ABOVE_MAXIMUM` |
| fractional (`12.9`) | `12` | — (floored, not rejected) |

Out-of-range values are clamped rather than discarded: a caller asking for
"immediately" still gets an immediate focus move, and a caller asking for ten
seconds gets the documented ceiling instead of no focus at all.

### `announcement`

| Input | Result | Code |
| --- | --- | --- |
| omitted, `undefined`, `null` | `"Loading reputation…"` | — |
| non-string | default | `ANNOUNCEMENT_NOT_A_STRING` |
| empty, whitespace only, or only control characters | default | `ANNOUNCEMENT_EMPTY` |
| longer than 120 characters after sanitising | default | `ANNOUNCEMENT_TOO_LONG` |
| control characters / repeated whitespace | sanitised and accepted | — |

An over-long announcement is rejected rather than truncated. Truncation would
announce a clipped sentence, which is worse than a clear default and hides the
caller's bug. Sanitising uses the existing `sanitizeUserText` helper, so the
live region cannot receive control characters.

### `autoFocus` / `embedded`

Only real booleans are accepted. `0`, `1`, `"true"`, and `"false"` are
rejected with `FLAG_NOT_BOOLEAN` and replaced by the documented default
(`true` and `false` respectively). Truthiness coercion is deliberately not
used: `autoFocus: 0` must not silently read as "on".

### Multiple rejections

All fields are validated in one pass. A call with three bad props produces
three entries in `rejections` and one fully-defaulted `options` object, so a
single report describes the whole problem.

## Focus invariants

`decideLoadingFocusApplication` is pure and evaluated when the timer fires.
Its rules are applied in this order:

1. `autoFocus` disabled → skip (`FOCUS_DISABLED`).
2. Focus already applied for this mount → skip (`FOCUS_ALREADY_APPLIED`).
3. Target missing, disconnected, inert, or unfocusable → skip
   (`FOCUS_TARGET_UNAVAILABLE`).
4. Focus moved to an element the user chose after mount → skip
   (`FOCUS_SUPPRESSED_BY_USER`). Focus still on the pre-mount element, or on
   `<body>`, is considered unclaimed and may be taken.

Consequences:

- **Retries and partial failure.** The skeleton may render, unmount, and be
  replaced before the delay elapses. The timer is cleared on unmount, and the
  decision re-checks that the target is still connected, so a late timer never
  focuses a detached node. A successful retry re-enters the loading state and
  legitimately needs focus again, so `focusApplied` is reset when a retry
  starts; that transition unmounts the retry button that held focus, landing
  focus on `<body>`, which does not trip `FOCUS_SUPPRESSED_BY_USER`.
- **Concurrent execution.** `focusApplied` is set before `focus()` runs, so a
  re-entrant path cannot apply focus twice. Each mount, and each retry cycle,
  gets one focus move.
- **No focus theft.** A user who tabs or clicks during the delay keeps focus.
  Moving it anyway would be a regression against the previous behaviour, which
  unconditionally focused `document.querySelector('main')` — the *first*
  `<main>` in the document, which may belong to another surface entirely.
- **Single landmark.** The wrapper renders the only `<main>` and passes
  `embedded` to the skeleton, so the document has exactly one landmark and one
  `role="status"` region.

## Observability

Rejected props are reported once per distinct rejection shape:

```text
context:   ReputationLoadingClient
level:     warn
code:      REPUTATION_LOADING_PROPS_REJECTED
rejections: [{ field: 'focusDelayMs', code: 'FOCUS_DELAY_BELOW_MINIMUM' }]
```

A focus target that cannot be resolved is reported separately:

```text
context:   ReputationLoadingClient
level:     warn
code:      REPUTATION_LOADING_FOCUS_TARGET_UNAVAILABLE
```

Reports carry field names and machine-readable codes only. Rejected values are
never included: `announcement` is caller-supplied text and may embed
user-identifying content. Reports also flow through `reportError`, which is a
no-op in production, so a rejected prop cannot become a production log line
containing user text.

Expected skips (`FOCUS_DISABLED`, `FOCUS_ALREADY_APPLIED`,
`FOCUS_SUPPRESSED_BY_USER`) are silent — they are normal behaviour, not faults.

## Tests

| File | Coverage |
| --- | --- |
| `src/lib/__tests__/validateReputationLoading.test.ts` | Accepted input, every rejection code, boundary delays, over-long and control-character announcements, idempotence, non-object input, focus-target resolution, focus decision table, no value leakage. |
| `src/app/reputation/__tests__/ReputationLoadingClient.test.tsx` | The existing failure-recovery suite (error boundary, retry locking, timeouts, exhausted state, axe audits) plus the prop validation boundary: accepted/rejected props, boundary delays, reporting and dedupe, StrictMode double-invocation, focus-theft prevention, foreign-landmark regression. |
| `src/app/reputation/__tests__/loading.test.tsx` | Skeleton structure, landmarks, live region, axe audit. |
| `src/app/reputation/__tests__/loading.invariants.test.tsx` | Geometry invariants (INV-1 … INV-5) owned by the skeleton. |