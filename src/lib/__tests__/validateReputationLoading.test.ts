import {
  DEFAULT_ANNOUNCEMENT,
  DEFAULT_FOCUS_DELAY_MS,
  MAX_ANNOUNCEMENT_LENGTH,
  MAX_FOCUS_DELAY_MS,
  MIN_FOCUS_DELAY_MS,
  decideLoadingFocusApplication,
  resolveLoadingFocusTarget,
  resolveReputationLoadingOptions,
} from '../validateReputationLoading';

describe('resolveReputationLoadingOptions', () => {
  describe('accepted input', () => {
    it('returns documented defaults when no input is supplied', () => {
      expect(resolveReputationLoadingOptions()).toEqual({
        options: {
          focusDelayMs: DEFAULT_FOCUS_DELAY_MS,
          announcement: DEFAULT_ANNOUNCEMENT,
          autoFocus: true,
          embedded: false,
        },
        rejections: [],
      });
    });

    it('accepts an explicit null/undefined input without rejecting', () => {
      const { options, rejections } = resolveReputationLoadingOptions({
        focusDelayMs: undefined,
        announcement: undefined,
        autoFocus: undefined,
        embedded: undefined,
      });

      expect(rejections).toEqual([]);
      expect(options.focusDelayMs).toBe(DEFAULT_FOCUS_DELAY_MS);
      expect(options.autoFocus).toBe(true);
    });

    it('accepts a custom announcement and preserves it verbatim', () => {
      const { options, rejections } = resolveReputationLoadingOptions({
        announcement: 'Loading reputation history…',
      });

      expect(rejections).toEqual([]);
      expect(options.announcement).toBe('Loading reputation history…');
    });

    it('accepts both boolean flags', () => {
      const { options, rejections } = resolveReputationLoadingOptions({
        autoFocus: false,
        embedded: true,
      });

      expect(rejections).toEqual([]);
      expect(options.autoFocus).toBe(false);
      expect(options.embedded).toBe(true);
    });

    it('strips control characters from an otherwise valid announcement', () => {
      const { options, rejections } = resolveReputationLoadingOptions({
        announcement: 'Loading\r\n reputation \u0000history…',
      });

      expect(rejections).toEqual([]);
      expect(options.announcement).toBe('Loading reputation history…');
    });
  });

  describe('rejected input – focus delay', () => {
    it.each([
      ['a string', '250', 'FOCUS_DELAY_NOT_A_NUMBER'],
      ['NaN', Number.NaN, 'FOCUS_DELAY_NOT_A_NUMBER'],
      ['Infinity', Number.POSITIVE_INFINITY, 'FOCUS_DELAY_NOT_FINITE'],
      ['-Infinity', Number.NEGATIVE_INFINITY, 'FOCUS_DELAY_NOT_FINITE'],
      ['null-like object', {}, 'FOCUS_DELAY_NOT_A_NUMBER'],
    ])('rejects %s and falls back to the default delay', (_label, value, code) => {
      const { options, rejections } = resolveReputationLoadingOptions({
        focusDelayMs: value,
      });

      expect(options.focusDelayMs).toBe(DEFAULT_FOCUS_DELAY_MS);
      expect(rejections).toEqual([{ field: 'focusDelayMs', code }]);
    });

    it('clamps a delay below the minimum and records the rejection', () => {
      const { options, rejections } = resolveReputationLoadingOptions({
        focusDelayMs: -50,
      });

      expect(options.focusDelayMs).toBe(MIN_FOCUS_DELAY_MS);
      expect(rejections).toEqual([
        { field: 'focusDelayMs', code: 'FOCUS_DELAY_BELOW_MINIMUM' },
      ]);
    });

    it('clamps a delay above the maximum and records the rejection', () => {
      const { options, rejections } = resolveReputationLoadingOptions({
        focusDelayMs: 10_000,
      });

      expect(options.focusDelayMs).toBe(MAX_FOCUS_DELAY_MS);
      expect(rejections).toEqual([
        { field: 'focusDelayMs', code: 'FOCUS_DELAY_ABOVE_MAXIMUM' },
      ]);
    });

    it('floors fractional delays without rejecting them', () => {
      const { options, rejections } = resolveReputationLoadingOptions({
        focusDelayMs: 12.9,
      });

      expect(options.focusDelayMs).toBe(12);
      expect(rejections).toEqual([]);
    });
  });

  describe('boundary values – focus delay', () => {
    it.each([
      ['minimum', MIN_FOCUS_DELAY_MS],
      ['maximum', MAX_FOCUS_DELAY_MS],
      ['one below minimum', MIN_FOCUS_DELAY_MS - 1],
      ['one above maximum', MAX_FOCUS_DELAY_MS + 1],
      ['default', DEFAULT_FOCUS_DELAY_MS],
    ])('resolves the %s boundary deterministically', (_label, value) => {
      const first = resolveReputationLoadingOptions({ focusDelayMs: value });
      const second = resolveReputationLoadingOptions({ focusDelayMs: value });

      expect(first).toEqual(second);
      expect(first.options.focusDelayMs).toBeGreaterThanOrEqual(MIN_FOCUS_DELAY_MS);
      expect(first.options.focusDelayMs).toBeLessThanOrEqual(MAX_FOCUS_DELAY_MS);
    });

    it('accepts the minimum and maximum exactly without rejection', () => {
      expect(
        resolveReputationLoadingOptions({ focusDelayMs: MIN_FOCUS_DELAY_MS }).rejections,
      ).toEqual([]);
      expect(
        resolveReputationLoadingOptions({ focusDelayMs: MAX_FOCUS_DELAY_MS }).rejections,
      ).toEqual([]);
    });
  });

  describe('rejected input – announcement', () => {
    it.each([
      ['a number', 42, 'ANNOUNCEMENT_NOT_A_STRING'],
      ['an array', ['Loading'], 'ANNOUNCEMENT_NOT_A_STRING'],
      ['an object', { text: 'Loading' }, 'ANNOUNCEMENT_NOT_A_STRING'],
    ])('rejects %s and falls back to the default', (_label, value, code) => {
      const { options, rejections } = resolveReputationLoadingOptions({
        announcement: value,
      });

      expect(options.announcement).toBe(DEFAULT_ANNOUNCEMENT);
      expect(rejections).toEqual([{ field: 'announcement', code }]);
    });

    it.each([
      ['an empty string', ''],
      ['whitespace only', '   '],
      ['control characters only', '\u0000\u0001'],
    ])('rejects %s rather than announcing nothing', (_label, value) => {
      const { options, rejections } = resolveReputationLoadingOptions({
        announcement: value,
      });

      expect(options.announcement).toBe(DEFAULT_ANNOUNCEMENT);
      expect(rejections).toEqual([{ field: 'announcement', code: 'ANNOUNCEMENT_EMPTY' }]);
    });

    it('rejects an over-long announcement instead of truncating it', () => {
      const { options, rejections } = resolveReputationLoadingOptions({
        announcement: 'a'.repeat(MAX_ANNOUNCEMENT_LENGTH + 1),
      });

      expect(options.announcement).toBe(DEFAULT_ANNOUNCEMENT);
      expect(rejections).toEqual([
        { field: 'announcement', code: 'ANNOUNCEMENT_TOO_LONG' },
      ]);
    });

    it('accepts an announcement exactly at the length ceiling', () => {
      const announcement = 'a'.repeat(MAX_ANNOUNCEMENT_LENGTH);
      const { options, rejections } = resolveReputationLoadingOptions({ announcement });

      expect(rejections).toEqual([]);
      expect(options.announcement).toBe(announcement);
    });

    it('normalises internal whitespace', () => {
      const { options } = resolveReputationLoadingOptions({
        announcement: 'Loading\n\t reputation  history…',
      });

      expect(options.announcement).toBe('Loading reputation history…');
    });
  });

  describe('rejected input – flags', () => {
    it.each([
      ['autoFocus', 'autoFocus'],
      ['embedded', 'embedded'],
    ])('rejects a non-boolean %s and uses the documented default', (field) => {
      const { options, rejections } = resolveReputationLoadingOptions({ [field]: 'yes' });

      expect(options.autoFocus).toBe(true);
      expect(options.embedded).toBe(false);
      expect(rejections).toEqual([{ field, code: 'FLAG_NOT_BOOLEAN' }]);
    });

    it('rejects zero and one as flags because they are numbers, not booleans', () => {
      const { rejections } = resolveReputationLoadingOptions({ autoFocus: 1, embedded: 0 });

      expect(rejections).toEqual([
        { field: 'autoFocus', code: 'FLAG_NOT_BOOLEAN' },
        { field: 'embedded', code: 'FLAG_NOT_BOOLEAN' },
      ]);
    });
  });

  describe('duplicate and conflicting input', () => {
    it('is idempotent for repeated identical input', () => {
      const input = { focusDelayMs: 300, announcement: 'Loading…', autoFocus: false };

      expect(resolveReputationLoadingOptions(input)).toEqual(
        resolveReputationLoadingOptions(input),
      );
    });

    it('collects every rejected field in one pass rather than short-circuiting', () => {
      const { options, rejections } = resolveReputationLoadingOptions({
        focusDelayMs: 'soon',
        announcement: 7,
        autoFocus: 'no',
        embedded: 'no',
      });

      expect(options).toEqual({
        focusDelayMs: DEFAULT_FOCUS_DELAY_MS,
        announcement: DEFAULT_ANNOUNCEMENT,
        autoFocus: true,
        embedded: false,
      });
      expect(rejections).toEqual([
        { field: 'focusDelayMs', code: 'FOCUS_DELAY_NOT_A_NUMBER' },
        { field: 'announcement', code: 'ANNOUNCEMENT_NOT_A_STRING' },
        { field: 'autoFocus', code: 'FLAG_NOT_BOOLEAN' },
        { field: 'embedded', code: 'FLAG_NOT_BOOLEAN' },
      ]);
    });

    it('tolerates a null prototype input object', () => {
      const { options, rejections } = resolveReputationLoadingOptions(
        Object.create(null) as Record<string, unknown>,
      );

      expect(rejections).toEqual([]);
      expect(options.announcement).toBe(DEFAULT_ANNOUNCEMENT);
    });

    it('falls back to defaults for a non-object input', () => {
      const { options, rejections } = resolveReputationLoadingOptions(
        'not-an-object' as unknown as Record<string, unknown>,
      );

      expect(rejections).toEqual([]);
      expect(options).toEqual({
        focusDelayMs: DEFAULT_FOCUS_DELAY_MS,
        announcement: DEFAULT_ANNOUNCEMENT,
        autoFocus: true,
        embedded: false,
      });
    });

    it('never echoes the rejected value back to the caller', () => {
      const secret = 'user@example.com'.repeat(20);
      const { rejections } = resolveReputationLoadingOptions({ announcement: secret });

      expect(rejections).toEqual([
        { field: 'announcement', code: 'ANNOUNCEMENT_TOO_LONG' },
      ]);
      expect(JSON.stringify(rejections)).not.toContain('user@example.com');
    });
  });
});

describe('resolveLoadingFocusTarget', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('returns a connected, focusable element', () => {
    const main = document.createElement('main');
    main.tabIndex = -1;
    document.body.appendChild(main);

    expect(resolveLoadingFocusTarget(main)).toBe(main);
  });

  it('returns null for a detached element', () => {
    const main = document.createElement('main');
    main.tabIndex = -1;

    expect(resolveLoadingFocusTarget(main)).toBeNull();
  });

  it.each([[null], [undefined]])('returns null for %p', (value) => {
    expect(resolveLoadingFocusTarget(value)).toBeNull();
  });

  it('returns null for a non-element value', () => {
    expect(resolveLoadingFocusTarget('main' as unknown as HTMLElement)).toBeNull();
  });

  it('returns null when the element is inside an inert subtree', () => {
    const inert = document.createElement('div');
    inert.setAttribute('inert', '');
    const main = document.createElement('main');
    main.tabIndex = -1;
    inert.appendChild(main);
    document.body.appendChild(inert);

    expect(resolveLoadingFocusTarget(main)).toBeNull();
  });

  it('returns null for a disabled element', () => {
    const button = document.createElement('button');
    button.setAttribute('disabled', '');
    document.body.appendChild(button);

    expect(resolveLoadingFocusTarget(button)).toBeNull();
  });
});

describe('decideLoadingFocusApplication', () => {
  let main: HTMLElement;
  let other: HTMLElement;

  beforeEach(() => {
    main = document.createElement('main');
    main.tabIndex = -1;
    other = document.createElement('a');
    other.href = '#';
    document.body.append(main, other);
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  const base = {
    target: null as HTMLElement | null,
    autoFocus: true,
    alreadyApplied: false,
    activeElement: null as Element | null,
    previousFocus: null as HTMLElement | null,
  };

  it('applies focus for a fresh mount with a valid target', () => {
    expect(
      decideLoadingFocusApplication({ ...base, target: main, activeElement: document.body }),
    ).toEqual({ shouldApply: true });
  });

  it('skips focus when autoFocus is disabled', () => {
    expect(
      decideLoadingFocusApplication({
        ...base,
        target: main,
        autoFocus: false,
        activeElement: document.body,
      }),
    ).toEqual({ shouldApply: false, code: 'FOCUS_DISABLED' });
  });

  it('skips a duplicate second application for the same mount', () => {
    expect(
      decideLoadingFocusApplication({
        ...base,
        target: main,
        alreadyApplied: true,
        activeElement: document.body,
      }),
    ).toEqual({ shouldApply: false, code: 'FOCUS_ALREADY_APPLIED' });
  });

  it('skips focus when the target is unavailable', () => {
    expect(
      decideLoadingFocusApplication({ ...base, target: null, activeElement: document.body }),
    ).toEqual({ shouldApply: false, code: 'FOCUS_TARGET_UNAVAILABLE' });
  });

  it('applies focus when focus is still on the pre-mount element', () => {
    expect(
      decideLoadingFocusApplication({
        ...base,
        target: main,
        activeElement: other,
        previousFocus: other,
      }),
    ).toEqual({ shouldApply: true });
  });

  it('does not steal focus from an element the user focused after mount', () => {
    other.focus();

    expect(
      decideLoadingFocusApplication({
        ...base,
        target: main,
        activeElement: document.activeElement,
        previousFocus: document.body,
      }),
    ).toEqual({ shouldApply: false, code: 'FOCUS_SUPPRESSED_BY_USER' });
  });

  it('still applies focus when the active element is the body after a blur', () => {
    document.body.focus();

    expect(
      decideLoadingFocusApplication({
        ...base,
        target: main,
        activeElement: document.activeElement,
        previousFocus: other,
      }),
    ).toEqual({ shouldApply: true });
  });
});