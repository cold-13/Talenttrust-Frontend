/**
 * ReputationLoadingClient.test.tsx
 *
 * Comprehensive tests for reputation loading state, focus management,
 * and deterministic failure recovery.
 */

import React from 'react';
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react';
import ReputationLoadingClient, {
  REPUTATION_LOADING_ERROR_CODE,
  REPUTATION_LOADING_TIMEOUT_CODE,
  REPUTATION_LOADING_RETRY_FAILED_CODE,
  REPUTATION_LOADING_FOCUS_TARGET_UNAVAILABLE_CODE,
  REPUTATION_LOADING_PROPS_REJECTED_CODE,
  DEFAULT_MAX_RETRIES,
  normalizeError,
  normalizeMaxRetries,
  normalizeTimeoutMs,
} from '../ReputationLoadingClient';
import {
  DEFAULT_ANNOUNCEMENT,
  DEFAULT_FOCUS_DELAY_MS,
  MAX_ANNOUNCEMENT_LENGTH,
  MAX_FOCUS_DELAY_MS,
} from '@/lib/validateReputationLoading';
import { setErrorReporter, type ErrorReporter } from '@/lib/errorReporter';
import { assertNoA11yViolations } from '@/test-utils/a11y';

// Mock the ReputationLoading component to avoid complex rendering. It honours the
// props it is given so the announcement boundary stays observable here; the real
// component is covered by loading.test.tsx and loading.invariants.test.tsx.
jest.mock('../loading', () => ({
  __esModule: true,
  default: ({
    announcement = 'Loading reputation…',
  }: {
    announcement?: string;
  }) => (
    <div data-testid="reputation-loading">
      <span role="status" aria-live="polite" aria-atomic="true" className="sr-only">
        {announcement}
      </span>
    </div>
  ),
}));

// Helper component that throws on demand
const Bomb: React.FC<{ shouldThrow?: boolean; message?: string }> = ({
  shouldThrow = true,
  message = 'Explosion in reputation loading',
}) => {
  if (shouldThrow) {
    throw new Error(message);
  }
  return <div data-testid="bomb-content">Healthy Child Content</div>;
};

describe('ReputationLoadingClient – focus management & normal operation', () => {
  beforeEach(() => {
    // Reset document focus before each test
    document.body.focus();
    setErrorReporter(null);
  });

  afterEach(() => {
    jest.restoreAllMocks();
    setErrorReporter(null);
  });

  describe('Initial focus behavior', () => {
    it('renders the main element with tabIndex={-1}', () => {
      render(<ReputationLoadingClient />);

      const main = document.querySelector('main');
      expect(main).toBeInTheDocument();
      expect(main).toHaveAttribute('tabIndex', '-1');
    });

    it('sets aria-busy="true" on main element', () => {
      render(<ReputationLoadingClient />);

      const main = document.querySelector('main');
      expect(main).toHaveAttribute('aria-busy', 'true');
    });

    it('stores the previously focused element on mount', () => {
      // Create a focusable element and focus it before mounting
      const button = document.createElement('button');
      button.textContent = 'Previous focus';
      document.body.appendChild(button);
      button.focus();

      expect(document.activeElement).toBe(button);

      render(<ReputationLoadingClient />);

      // The component should have stored the previous focus
      expect(button).toBeInTheDocument();

      document.body.removeChild(button);
    });

    it('moves focus to the main element after mount', async () => {
      render(<ReputationLoadingClient />);

      const main = document.querySelector('main');

      await waitFor(() => {
        expect(document.activeElement).toBe(main);
      });
    });

    it('handles the case where no element was previously focused', async () => {
      // Ensure no element is focused
      document.body.focus();

      render(<ReputationLoadingClient />);

      const main = document.querySelector('main');

      await waitFor(() => {
        expect(document.activeElement).toBe(main);
      });
    });
  });

  describe('Cleanup behavior', () => {
    it('clears the focus timer on unmount', () => {
      const clearTimeoutSpy = jest.spyOn(global, 'clearTimeout');
      const { unmount } = render(<ReputationLoadingClient />);

      unmount();

      // clearTimeout should be called during cleanup
      expect(clearTimeoutSpy).toHaveBeenCalled();

      clearTimeoutSpy.mockRestore();
    });

    it('does not throw when unmounting before focus is set', () => {
      const { unmount } = render(<ReputationLoadingClient />);

      // Unmount immediately before the focus timer fires
      expect(() => unmount()).not.toThrow();
    });
  });

  describe('Accessibility attributes', () => {
    it('applies correct CSS classes to main element', () => {
      render(<ReputationLoadingClient />);

      const main = document.querySelector('main');
      expect(main).toHaveClass('min-h-screen', 'p-8');
    });

    it('renders child loading content correctly', () => {
      render(<ReputationLoadingClient />);

      expect(screen.getByTestId('reputation-loading')).toBeInTheDocument();
      expect(screen.getByRole('status')).toHaveTextContent('Loading reputation…');
    });
  });

  describe('Edge cases', () => {
    it('focuses its own landmark and never queries the document for a <main>', async () => {
      // A foreign landmark earlier in the document is what the previous
      // `document.querySelector('main')` implementation resolved to.
      const foreign = document.createElement('main');
      foreign.id = 'other-page-main';
      foreign.tabIndex = -1;
      document.body.appendChild(foreign);

      const querySpy = jest.spyOn(document, 'querySelector');
      const { container, unmount } = render(<ReputationLoadingClient />);
      const ownMain = container.querySelector('main');

      await waitFor(() => {
        expect(document.activeElement).toBe(ownMain);
      });

      expect(document.activeElement).not.toBe(foreign);
      expect(querySpy).not.toHaveBeenCalledWith('main');

      unmount();
      foreign.remove();
    });

    it('skips focus and does not throw when the landmark stops being focusable', () => {
      jest.useFakeTimers();
      const reporter = jest.fn();
      setErrorReporter(reporter);

      const { container } = render(<ReputationLoadingClient />);
      const main = container.querySelector('main');
      expect(main).not.toBeNull();

      // Make the landmark unfocusable before the pending timer fires. The
      // disconnected case is covered directly in validateReputationLoading.test.ts;
      // here the node must stay in the tree so React's own unmount cleanup
      // still owns it.
      main?.setAttribute('inert', '');

      expect(() => jest.advanceTimersByTime(DEFAULT_FOCUS_DELAY_MS)).not.toThrow();
      expect(document.activeElement).not.toBe(main);

      // The skipped focus is diagnosable: a replaced landmark is a fault,
      // unlike the expected FOCUS_DISABLED / ALREADY_APPLIED / USER skips.
      expect(reporter).toHaveBeenCalledWith(
        expect.any(Error),
        'ReputationLoadingClient',
        'warn',
        expect.objectContaining({
          code: REPUTATION_LOADING_FOCUS_TARGET_UNAVAILABLE_CODE,
        }),
      );

      setErrorReporter(null);
      jest.useRealTimers();
    });

    it('handles rapid mount/unmount cycles', () => {
      const { unmount } = render(<ReputationLoadingClient />);
      unmount();

      const { unmount: unmount2 } = render(<ReputationLoadingClient />);
      expect(() => unmount2()).not.toThrow();
    });

    it('maintains focus when component re-renders', async () => {
      const { rerender } = render(<ReputationLoadingClient />);

      const main = document.querySelector('main');

      await waitFor(() => {
        expect(document.activeElement).toBe(main);
      });

      // Re-render should maintain focus
      rerender(<ReputationLoadingClient />);

      await waitFor(() => {
        expect(document.activeElement).toBe(main);
      });
    });
  });

  describe('StrictMode behavior', () => {
    it('ignores duplicate StrictMode focus timers and focuses once', () => {
      jest.useFakeTimers();
      const focusSpy = jest.spyOn(HTMLElement.prototype, 'focus');

      render(
        <React.StrictMode>
          <ReputationLoadingClient />
        </React.StrictMode>
      );

      jest.advanceTimersByTime(100);

      expect(focusSpy).toHaveBeenCalledTimes(1);
      jest.useRealTimers();
    });
  });
});

describe('ReputationLoadingClient – deterministic failure recovery', () => {
  let consoleErrorSpy: jest.SpyInstance;
  let mockReporter: jest.MockedFunction<ErrorReporter>;

  beforeEach(() => {
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    mockReporter = jest.fn();
    setErrorReporter(mockReporter);
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
    setErrorReporter(null);
    jest.restoreAllMocks();
  });

  describe('Error boundary containment & reporting', () => {
    it('catches descendant render errors and renders accessible alert fallback', () => {
      render(
        <ReputationLoadingClient>
          <Bomb shouldThrow={true} message="Failed to fetch reputation data" />
        </ReputationLoadingClient>
      );

      const alert = screen.getByRole('alert');
      expect(alert).toBeInTheDocument();
      expect(alert).toHaveAttribute('aria-live', 'assertive');
      expect(alert).toHaveAttribute('aria-atomic', 'true');
      expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent('Unable to load reputation');
      expect(
        screen.getByText('A problem occurred while loading reputation data. You can try again.')
      ).toBeInTheDocument();
    });

    it('sets aria-busy="false" on the main container when an error occurs', () => {
      render(
        <ReputationLoadingClient>
          <Bomb shouldThrow={true} />
        </ReputationLoadingClient>
      );

      const main = document.querySelector('main');
      expect(main).toHaveAttribute('aria-busy', 'false');
    });

    it('reports the caught error to errorReporter with proper context and metadata', () => {
      render(
        <ReputationLoadingClient>
          <Bomb shouldThrow={true} message="Database query timeout" />
        </ReputationLoadingClient>
      );

      expect(mockReporter).toHaveBeenCalledTimes(1);
      expect(mockReporter).toHaveBeenCalledWith(
        expect.any(Error),
        'ReputationLoadingClient',
        'error',
        expect.objectContaining({
          code: REPUTATION_LOADING_ERROR_CODE,
          retryCount: 0,
          maxRetries: DEFAULT_MAX_RETRIES,
        })
      );
    });

    it('calls onError callback prop when provided', () => {
      const onError = jest.fn();
      render(
        <ReputationLoadingClient onError={onError}>
          <Bomb shouldThrow={true} message="Specific error" />
        </ReputationLoadingClient>
      );

      expect(onError).toHaveBeenCalledTimes(1);
      expect(onError).toHaveBeenCalledWith(
        expect.objectContaining({ message: 'Specific error' }),
        expect.anything()
      );
    });

    it('does not unseat the error boundary if onError callback throws', () => {
      const onError = jest.fn(() => {
        throw new Error('Callback failed');
      });

      expect(() => {
        render(
          <ReputationLoadingClient onError={onError}>
            <Bomb shouldThrow={true} />
          </ReputationLoadingClient>
        );
      }).not.toThrow();

      expect(screen.getByRole('alert')).toBeInTheDocument();
    });

    it('sanitizes user-facing UI and does not leak stack traces or raw messages into DOM', () => {
      const sensitiveLeak = 'Bearer secret-token-xyz-12345 in stack trace';
      render(
        <ReputationLoadingClient>
          <Bomb shouldThrow={true} message={sensitiveLeak} />
        </ReputationLoadingClient>
      );

      expect(screen.queryByText(new RegExp(sensitiveLeak))).not.toBeInTheDocument();
      expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent('Unable to load reputation');
    });

    it('renders custom fallbackTitle when provided', () => {
      render(
        <ReputationLoadingClient fallbackTitle="Reputation service unavailable">
          <Bomb shouldThrow={true} />
        </ReputationLoadingClient>
      );

      expect(
        screen.getByRole('heading', { level: 2, name: 'Reputation service unavailable' })
      ).toBeInTheDocument();
    });

    it('focuses the "Try again" button when the error fallback renders', async () => {
      render(
        <ReputationLoadingClient>
          <Bomb shouldThrow={true} />
        </ReputationLoadingClient>
      );

      const retryButton = screen.getByRole('button', { name: /try again/i });
      await waitFor(() => {
        expect(document.activeElement).toBe(retryButton);
      });
    });

    it('renders Go Home link pointing to /', () => {
      render(
        <ReputationLoadingClient>
          <Bomb shouldThrow={true} />
        </ReputationLoadingClient>
      );

      const goHomeLink = screen.getByRole('link', { name: /go home/i });
      expect(goHomeLink).toBeInTheDocument();
      expect(goHomeLink).toHaveAttribute('href', '/');
    });
  });

  describe('Deterministic retry & recovery', () => {
    it('recovers cleanly when clicking "Try again" and error condition is resolved', async () => {
      let shouldThrow = true;
      const DynamicChild = () => <Bomb shouldThrow={shouldThrow} />;

      const onRecover = jest.fn();
      const onRetry = jest.fn();

      render(
        <ReputationLoadingClient onRetry={onRetry} onRecover={onRecover}>
          <DynamicChild />
        </ReputationLoadingClient>
      );

      expect(screen.getByRole('alert')).toBeInTheDocument();
      expect(document.querySelector('main')).toHaveAttribute('aria-busy', 'false');

      // Error condition resolves externally
      shouldThrow = false;

      const retryButton = screen.getByRole('button', { name: /try again/i });
      await act(async () => {
        fireEvent.click(retryButton);
      });

      // Verify onRetry was triggered
      expect(onRetry).toHaveBeenCalledTimes(1);
      expect(onRecover).toHaveBeenCalledTimes(1);

      // Verify healthy child content is mounted cleanly
      expect(screen.getByTestId('bomb-content')).toBeInTheDocument();
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
      expect(document.querySelector('main')).toHaveAttribute('aria-busy', 'true');

      // Focus should return to main
      await waitFor(() => {
        expect(document.activeElement).toBe(document.querySelector('main'));
      });
    });

    it('supports asynchronous onRetry handler with pending loading state', async () => {
      let resolveRetry: () => void = () => {};
      const pendingPromise = new Promise<void>((resolve) => {
        resolveRetry = resolve;
      });

      let shouldThrow = true;
      const DynamicChild = () => <Bomb shouldThrow={shouldThrow} />;

      render(
        <ReputationLoadingClient onRetry={() => pendingPromise}>
          <DynamicChild />
        </ReputationLoadingClient>
      );

      const retryButton = screen.getByRole('button', { name: /try again/i });
      act(() => {
        fireEvent.click(retryButton);
      });

      // While async retry is in flight, button is disabled and displays "Retrying…"
      expect(screen.getByRole('button', { name: /retrying/i })).toBeDisabled();
      expect(document.querySelector('main')).toHaveAttribute('aria-busy', 'true');

      // Resolve the retry
      shouldThrow = false;
      await act(async () => {
        resolveRetry();
      });

      expect(screen.getByTestId('bomb-content')).toBeInTheDocument();
    });

    it('handles rejected asynchronous onRetry by remaining in error state and logging', async () => {
      render(
        <ReputationLoadingClient
          onRetry={() => Promise.reject(new Error('Network reconnect failed'))}
        >
          <Bomb shouldThrow={true} />
        </ReputationLoadingClient>
      );

      const retryButton = screen.getByRole('button', { name: /try again/i });
      await act(async () => {
        fireEvent.click(retryButton);
      });

      expect(mockReporter).toHaveBeenCalledWith(
        expect.any(Error),
        'ReputationLoadingClient',
        'error',
        expect.objectContaining({
          code: REPUTATION_LOADING_RETRY_FAILED_CODE,
          retryCount: 1,
        })
      );

      // Still in error state with retry available (retryCount 1 < 3)
      expect(screen.getByRole('alert')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument();
    });

    it('guards against concurrent retry clicks while retry is in flight', async () => {
      let resolvePromise: () => void = () => {};
      const retryFn = jest.fn(
        () =>
          new Promise<void>((resolve) => {
            resolvePromise = resolve;
          })
      );

      render(
        <ReputationLoadingClient onRetry={retryFn}>
          <Bomb shouldThrow={true} />
        </ReputationLoadingClient>
      );

      const retryButton = screen.getByRole('button', { name: /try again/i });

      // Click multiple times rapidly
      act(() => {
        fireEvent.click(retryButton);
        fireEvent.click(retryButton);
        fireEvent.click(retryButton);
      });

      expect(retryFn).toHaveBeenCalledTimes(1);

      await act(async () => {
        resolvePromise();
      });
    });
  });

  describe('Max retries & exhausted terminal state', () => {
    it('transitions to exhausted state after maxRetries attempts fail', async () => {
      let shouldThrow = true;
      const DynamicChild = () => <Bomb shouldThrow={shouldThrow} message="Persistent failure" />;

      render(
        <ReputationLoadingClient maxRetries={2}>
          <DynamicChild />
        </ReputationLoadingClient>
      );

      // Initial failure (retryCount = 0)
      expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument();

      // Retry 1: fails
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: /try again/i }));
      });
      expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument();

      // Retry 2: fails -> maxRetries (2) reached
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: /try again/i }));
      });

      // Terminal state: "Try again" button is removed
      expect(screen.queryByRole('button', { name: /try again/i })).not.toBeInTheDocument();
      expect(
        screen.getByText(
          'Unable to load reputation after multiple attempts. Please return home or contact support if the problem persists.'
        )
      ).toBeInTheDocument();

      // Go Home link remains accessible
      expect(screen.getByRole('link', { name: /go home/i })).toBeInTheDocument();
    });

    it('immediately enters exhausted state when maxRetries is 0', () => {
      render(
        <ReputationLoadingClient maxRetries={0}>
          <Bomb shouldThrow={true} />
        </ReputationLoadingClient>
      );

      expect(screen.queryByRole('button', { name: /try again/i })).not.toBeInTheDocument();
      expect(
        screen.getByText(
          'Unable to load reputation after multiple attempts. Please return home or contact support if the problem persists.'
        )
      ).toBeInTheDocument();
      expect(screen.getByRole('link', { name: /go home/i })).toBeInTheDocument();
    });

    it('normalizes invalid maxRetries values (negative, NaN) to default', () => {
      expect(normalizeMaxRetries(-5)).toBe(DEFAULT_MAX_RETRIES);
      expect(normalizeMaxRetries(NaN)).toBe(DEFAULT_MAX_RETRIES);
      expect(normalizeMaxRetries('three')).toBe(DEFAULT_MAX_RETRIES);
      expect(normalizeMaxRetries(4.8)).toBe(4);
    });
  });

  describe('Timeout handling', () => {
    beforeEach(() => {
      jest.useFakeTimers();
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it('transitions to error state when timeoutMs threshold is exceeded', () => {
      const onError = jest.fn();
      render(
        <ReputationLoadingClient timeoutMs={500} onError={onError}>
          <div data-testid="slow-loading">Simulated slow component</div>
        </ReputationLoadingClient>
      );

      // Before timeout
      expect(screen.getByTestId('slow-loading')).toBeInTheDocument();
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();

      // Advance past timeout
      act(() => {
        jest.advanceTimersByTime(500);
      });

      // After timeout
      expect(screen.getByRole('alert')).toBeInTheDocument();
      expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent('Unable to load reputation');
      expect(mockReporter).toHaveBeenCalledWith(
        expect.any(Error),
        'ReputationLoadingClient',
        'warn',
        expect.objectContaining({
          code: REPUTATION_LOADING_TIMEOUT_CODE,
          timeoutMs: 500,
        })
      );
      expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'Reputation loading timed out' }));
    });

    it('clears timeout timer cleanly on unmount before timeout expires', () => {
      const { unmount } = render(
        <ReputationLoadingClient timeoutMs={1000}>
          <div>Slow content</div>
        </ReputationLoadingClient>
      );

      unmount();

      // Advancing timer after unmount should not throw or update state
      expect(() => {
        act(() => {
          jest.advanceTimersByTime(1500);
        });
      }).not.toThrow();
    });

    it('normalizes invalid timeoutMs inputs (non-positive, NaN)', () => {
      expect(normalizeTimeoutMs(-100)).toBeNull();
      expect(normalizeTimeoutMs(0)).toBeNull();
      expect(normalizeTimeoutMs(NaN)).toBeNull();
      expect(normalizeTimeoutMs('500')).toBeNull();
      expect(normalizeTimeoutMs(1000)).toBe(1000);
    });
  });

  describe('Custom fallback support', () => {
    it('renders custom ReactNode fallback when provided', () => {
      render(
        <ReputationLoadingClient fallback={<div data-testid="custom-ui">Custom Fallback UI</div>}>
          <Bomb shouldThrow={true} />
        </ReputationLoadingClient>
      );

      expect(screen.getByTestId('custom-ui')).toBeInTheDocument();
      expect(screen.queryByText('Unable to load reputation')).not.toBeInTheDocument();
    });

    it('renders custom function fallback with fallback context props', () => {
      render(
        <ReputationLoadingClient
          fallback={({ error, retry, retryCount, isExhausted }) => (
            <div data-testid="context-ui">
              <span>Error: {error?.message}</span>
              <span>Count: {retryCount}</span>
              <span>Exhausted: {String(isExhausted)}</span>
              <button type="button" onClick={retry}>
                Custom Retry
              </button>
            </div>
          )}
        >
          <Bomb shouldThrow={true} message="Context test error" />
        </ReputationLoadingClient>
      );

      expect(screen.getByTestId('context-ui')).toBeInTheDocument();
      expect(screen.getByText('Error: Context test error')).toBeInTheDocument();
      expect(screen.getByText('Count: 0')).toBeInTheDocument();
      expect(screen.getByText('Exhausted: false')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Custom Retry' })).toBeInTheDocument();
    });

    it('gracefully falls back to default fallback if custom fallback function throws', () => {
      render(
        <ReputationLoadingClient
          fallback={() => {
            throw new Error('Custom fallback render threw');
          }}
        >
          <Bomb shouldThrow={true} />
        </ReputationLoadingClient>
      );

      // Catches and renders default fallback instead of white-screening
      expect(screen.getByRole('alert')).toBeInTheDocument();
      expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent('Unable to load reputation');
    });
  });

  describe('Initial error & error normalization', () => {
    it('mounts directly in error state when initialError is provided', () => {
      render(<ReputationLoadingClient initialError={new Error('Pre-existing error')} />);

      expect(screen.getByRole('alert')).toBeInTheDocument();
      expect(document.querySelector('main')).toHaveAttribute('aria-busy', 'false');
    });

    it('mounts in error state when initialError is a string', () => {
      render(<ReputationLoadingClient initialError="String error message" />);

      expect(screen.getByRole('alert')).toBeInTheDocument();
    });

    it('normalizes non-Error thrown objects, strings, numbers, null', () => {
      expect(normalizeError('String err').message).toBe('String err');
      expect(normalizeError({ message: 'Object err' }).message).toBe('Object err');
      expect(normalizeError(404).message).toBe('404');
      expect(normalizeError(null).message).toBe('Unknown error occurred');
      expect(normalizeError(undefined).message).toBe('Unknown error occurred');
    });

    it('updates to error state when initialError prop changes after mount', () => {
      const { rerender } = render(<ReputationLoadingClient />);

      expect(document.querySelector('main')).toHaveAttribute('aria-busy', 'true');

      rerender(<ReputationLoadingClient initialError="Late error arriving" />);

      expect(screen.getByRole('alert')).toBeInTheDocument();
      expect(document.querySelector('main')).toHaveAttribute('aria-busy', 'false');
    });
  });

  describe('Accessibility – jest-axe audits', () => {
    it('has zero accessibility violations in normal loading state', async () => {
      const { container } = render(<ReputationLoadingClient />);
      await assertNoA11yViolations(container);
    });

    it('has zero accessibility violations in error fallback state', async () => {
      const { container } = render(
        <ReputationLoadingClient>
          <Bomb shouldThrow={true} />
        </ReputationLoadingClient>
      );
      await assertNoA11yViolations(container);
    });

    it('has zero accessibility violations in exhausted state', async () => {
      const { container } = render(
        <ReputationLoadingClient maxRetries={0}>
          <Bomb shouldThrow={true} />
        </ReputationLoadingClient>
      );
      await assertNoA11yViolations(container);
    });
  });
});

// ---------------------------------------------------------------------------
// Validation boundaries (issue #1224)
//
// The cases above cover the merged failure-recovery state machine. The suite
// below covers the input boundary: which untrusted prop values are accepted,
// which are rejected, and what the user experiences in each case.
// ---------------------------------------------------------------------------

describe('ReputationLoadingClient – prop validation boundaries', () => {
  let reporter: jest.MockedFunction<ErrorReporter>;

  beforeEach(() => {
    reporter = jest.fn();
    setErrorReporter(reporter);
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    setErrorReporter(null);
    jest.restoreAllMocks();
  });

  /** Rejection reports carry field names and codes, never the bad value. */
  const rejectedReports = () =>
    reporter.mock.calls.filter(
      ([, , , meta]) => (meta as { code?: string } | undefined)?.code === REPUTATION_LOADING_PROPS_REJECTED_CODE,
    );

  describe('Accepted input', () => {
    it('applies a valid custom delay exactly, and nothing earlier', () => {
      jest.useFakeTimers();
      const { container } = render(<ReputationLoadingClient focusDelayMs={450} />);
      const main = container.querySelector('main');

      jest.advanceTimersByTime(449);
      expect(document.activeElement).not.toBe(main);

      jest.advanceTimersByTime(1);
      expect(document.activeElement).toBe(main);
      expect(rejectedReports()).toHaveLength(0);

      jest.useRealTimers();
    });

    it('focuses on the next tick when the delay is zero', () => {
      jest.useFakeTimers();
      const { container } = render(<ReputationLoadingClient focusDelayMs={0} />);

      jest.advanceTimersByTime(0);
      expect(document.activeElement).toBe(container.querySelector('main'));

      jest.useRealTimers();
    });

    it('renders a valid custom announcement in the live region', async () => {
      const { container } = render(
        <ReputationLoadingClient announcement="Fetching your reputation score" />,
      );

      await waitFor(() => {
        expect(screen.getByRole('status')).toHaveTextContent(
          'Fetching your reputation score',
        );
      });
      expect(container.querySelectorAll('[role="status"]')).toHaveLength(1);
      expect(rejectedReports()).toHaveLength(0);
    });

    it('accepts an announcement of exactly the maximum length', async () => {
      const exact = 'a'.repeat(MAX_ANNOUNCEMENT_LENGTH);
      render(<ReputationLoadingClient announcement={exact} />);

      await waitFor(() => {
        expect(screen.getByRole('status')).toHaveTextContent(exact);
      });
      expect(rejectedReports()).toHaveLength(0);
    });

    it('accepts explicit autoFocus={false} and leaves focus untouched', () => {
      jest.useFakeTimers();
      const { container } = render(<ReputationLoadingClient autoFocus={false} />);

      jest.advanceTimersByTime(MAX_FOCUS_DELAY_MS * 4);
      expect(document.activeElement).not.toBe(container.querySelector('main'));
      expect(rejectedReports()).toHaveLength(0);

      jest.useRealTimers();
    });
  });

  describe('Rejected input', () => {
    it('falls back to the default delay for a non-numeric delay', () => {
      jest.useFakeTimers();
      const { container } = render(
        <ReputationLoadingClient focusDelayMs={'soon' as unknown as number} />,
      );
      const main = container.querySelector('main');

      jest.advanceTimersByTime(DEFAULT_FOCUS_DELAY_MS - 1);
      expect(document.activeElement).not.toBe(main);

      jest.advanceTimersByTime(1);
      expect(document.activeElement).toBe(main);

      expect(rejectedReports()).toHaveLength(1);
      expect(rejectedReports()[0][3]).toEqual({
        code: REPUTATION_LOADING_PROPS_REJECTED_CODE,
        rejections: [{ field: 'focusDelayMs', code: 'FOCUS_DELAY_NOT_A_NUMBER' }],
      });

      jest.useRealTimers();
    });

    it.each([
      ['NaN', Number.NaN, 'FOCUS_DELAY_NOT_A_NUMBER'],
      ['Infinity', Number.POSITIVE_INFINITY, 'FOCUS_DELAY_NOT_FINITE'],
      ['-Infinity', Number.NEGATIVE_INFINITY, 'FOCUS_DELAY_NOT_FINITE'],
    ])('rejects a %s delay', (_label, value, code) => {
      jest.useFakeTimers();
      render(<ReputationLoadingClient focusDelayMs={value} />);

      jest.advanceTimersByTime(DEFAULT_FOCUS_DELAY_MS);
      expect(rejectedReports()[0][3]).toEqual({
        code: REPUTATION_LOADING_PROPS_REJECTED_CODE,
        rejections: [{ field: 'focusDelayMs', code }],
      });

      jest.useRealTimers();
    });

    it('falls back to the default announcement when the value is over-long', async () => {
      render(<ReputationLoadingClient announcement={'x'.repeat(MAX_ANNOUNCEMENT_LENGTH + 1)} />);

      await waitFor(() => {
        expect(screen.getByRole('status')).toHaveTextContent(DEFAULT_ANNOUNCEMENT);
      });
      expect(rejectedReports()[0][3]).toEqual({
        code: REPUTATION_LOADING_PROPS_REJECTED_CODE,
        rejections: [{ field: 'announcement', code: 'ANNOUNCEMENT_TOO_LONG' }],
      });
    });

    it.each([
      ['whitespace only', '   ', 'ANNOUNCEMENT_EMPTY'],
      ['control characters only', ' ', 'ANNOUNCEMENT_EMPTY'],
    ])('rejects an announcement that is %s', async (_label, value, code) => {
      render(<ReputationLoadingClient announcement={value} />);

      await waitFor(() => {
        expect(screen.getByRole('status')).toHaveTextContent(DEFAULT_ANNOUNCEMENT);
      });
      expect(rejectedReports()[0][3]).toEqual({
        code: REPUTATION_LOADING_PROPS_REJECTED_CODE,
        rejections: [{ field: 'announcement', code }],
      });
    });

    it('rejects a non-boolean autoFocus rather than coercing it', () => {
      jest.useFakeTimers();
      // `autoFocus: 0` is falsy. Truthiness coercion would silently disable
      // focus; strict validation falls back to the default and keeps focus.
      render(<ReputationLoadingClient autoFocus={0 as unknown as boolean} />);

      jest.advanceTimersByTime(DEFAULT_FOCUS_DELAY_MS);
      expect(document.activeElement).toBeInstanceOf(HTMLElement);
      expect(document.activeElement?.tagName).toBe('MAIN');
      expect(rejectedReports()[0][3]).toEqual({
        code: REPUTATION_LOADING_PROPS_REJECTED_CODE,
        rejections: [{ field: 'autoFocus', code: 'FLAG_NOT_BOOLEAN' }],
      });

      jest.useRealTimers();
    });

    it('reports every invalid prop in a single pass', () => {
      jest.useFakeTimers();
      render(
        <ReputationLoadingClient
          focusDelayMs={-5}
          announcement={42 as unknown as string}
          autoFocus={'yes' as unknown as boolean}
        />,
      );

      jest.advanceTimersByTime(DEFAULT_FOCUS_DELAY_MS);

      expect(rejectedReports()).toHaveLength(1);
      expect(rejectedReports()[0][3]).toEqual({
        code: REPUTATION_LOADING_PROPS_REJECTED_CODE,
        rejections: [
          { field: 'focusDelayMs', code: 'FOCUS_DELAY_BELOW_MINIMUM' },
          { field: 'announcement', code: 'ANNOUNCEMENT_NOT_A_STRING' },
          { field: 'autoFocus', code: 'FLAG_NOT_BOOLEAN' },
        ],
      });

      jest.useRealTimers();
    });
  });

  describe('Boundary values', () => {
    it('clamps an over-maximum delay so focus lands at the ceiling', () => {
      jest.useFakeTimers();
      const { container } = render(
        <ReputationLoadingClient focusDelayMs={MAX_FOCUS_DELAY_MS + 10_000} />,
      );
      const main = container.querySelector('main');

      jest.advanceTimersByTime(MAX_FOCUS_DELAY_MS - 1);
      expect(document.activeElement).not.toBe(main);

      jest.advanceTimersByTime(1);
      expect(document.activeElement).toBe(main);
      expect(rejectedReports()[0][3]).toEqual({
        code: REPUTATION_LOADING_PROPS_REJECTED_CODE,
        rejections: [{ field: 'focusDelayMs', code: 'FOCUS_DELAY_ABOVE_MAXIMUM' }],
      });

      jest.useRealTimers();
    });

    it('clamps a negative delay to zero rather than deferring focus', () => {
      jest.useFakeTimers();
      const { container } = render(<ReputationLoadingClient focusDelayMs={-25} />);

      jest.advanceTimersByTime(0);
      expect(document.activeElement).toBe(container.querySelector('main'));
      expect(rejectedReports()[0][3]).toEqual({
        code: REPUTATION_LOADING_PROPS_REJECTED_CODE,
        rejections: [{ field: 'focusDelayMs', code: 'FOCUS_DELAY_BELOW_MINIMUM' }],
      });

      jest.useRealTimers();
    });

    it('focuses exactly at the maximum accepted delay', () => {
      jest.useFakeTimers();
      const { container } = render(<ReputationLoadingClient focusDelayMs={MAX_FOCUS_DELAY_MS} />);
      const main = container.querySelector('main');

      jest.advanceTimersByTime(MAX_FOCUS_DELAY_MS - 1);
      expect(document.activeElement).not.toBe(main);

      jest.advanceTimersByTime(1);
      expect(document.activeElement).toBe(main);
      expect(rejectedReports()).toHaveLength(0);

      jest.useRealTimers();
    });

    it('floors a fractional delay instead of rejecting it', () => {
      jest.useFakeTimers();
      const { container } = render(<ReputationLoadingClient focusDelayMs={250.9} />);
      const main = container.querySelector('main');

      jest.advanceTimersByTime(250);
      expect(document.activeElement).toBe(main);
      expect(rejectedReports()).toHaveLength(0);

      jest.useRealTimers();
    });
  });

  describe('Focus invariants', () => {
    it('does not steal focus from an element the user focused after mount', () => {
      jest.useFakeTimers();
      const { container } = render(<ReputationLoadingClient />);
      const main = container.querySelector('main');

      const userTarget = document.createElement('button');
      userTarget.textContent = 'user choice';
      document.body.appendChild(userTarget);
      userTarget.focus();

      jest.advanceTimersByTime(DEFAULT_FOCUS_DELAY_MS);
      expect(document.activeElement).toBe(userTarget);
      expect(document.activeElement).not.toBe(main);

      // Suppressing focus is expected behaviour, so it stays unreported.
      expect(reporter).not.toHaveBeenCalledWith(
        expect.any(Error),
        'ReputationLoadingClient',
        'warn',
        expect.objectContaining({
          code: REPUTATION_LOADING_FOCUS_TARGET_UNAVAILABLE_CODE,
        }),
      );

      userTarget.remove();
      jest.useRealTimers();
    });

    it('applies focus at most once per mount', () => {
      jest.useFakeTimers();
      const focusSpy = jest.spyOn(HTMLElement.prototype, 'focus');

      const { rerender } = render(<ReputationLoadingClient />);
      jest.advanceTimersByTime(DEFAULT_FOCUS_DELAY_MS);
      expect(focusSpy).toHaveBeenCalledTimes(1);

      // Re-rendering with unchanged props must not queue a second application.
      rerender(<ReputationLoadingClient />);
      jest.advanceTimersByTime(DEFAULT_FOCUS_DELAY_MS * 4);
      expect(focusSpy).toHaveBeenCalledTimes(1);

      jest.useRealTimers();
    });

    it('does not move focus when unmounted before the timer fires', () => {
      jest.useFakeTimers();
      const focusSpy = jest.spyOn(HTMLElement.prototype, 'focus');

      const { unmount } = render(<ReputationLoadingClient />);
      unmount();
      jest.advanceTimersByTime(DEFAULT_FOCUS_DELAY_MS * 4);

      expect(focusSpy).not.toHaveBeenCalled();
      jest.useRealTimers();
    });
  });

  describe('Observability', () => {
    it('never includes the rejected value in a report', () => {
      jest.useFakeTimers();
      // Over-long, so it is rejected, and it embeds an identifier to prove the
      // report cannot leak caller-supplied text.
      const secret = `user@example.com ${'x'.repeat(MAX_ANNOUNCEMENT_LENGTH)}`;
      render(<ReputationLoadingClient announcement={secret} />);

      jest.advanceTimersByTime(DEFAULT_FOCUS_DELAY_MS);

      const serialised = JSON.stringify(reporter.mock.calls);
      expect(serialised).not.toContain('user@example.com');
      expect(serialised).toContain('ANNOUNCEMENT_TOO_LONG');

      jest.useRealTimers();
    });

    it('deduplicates repeated identical rejections but logs a new shape', () => {
      jest.useFakeTimers();
      const { rerender } = render(<ReputationLoadingClient focusDelayMs={'a' as unknown as number} />);
      jest.advanceTimersByTime(DEFAULT_FOCUS_DELAY_MS);
      expect(rejectedReports()).toHaveLength(1);

      // Same bad value re-rendered: no new report.
      rerender(<ReputationLoadingClient focusDelayMs={'a' as unknown as number} />);
      jest.advanceTimersByTime(DEFAULT_FOCUS_DELAY_MS);
      expect(rejectedReports()).toHaveLength(1);

      // A different failure is always surfaced.
      rerender(<ReputationLoadingClient announcement={'b'.repeat(500)} />);
      expect(rejectedReports()).toHaveLength(2);
      expect(rejectedReports()[1][3]).toEqual({
        code: REPUTATION_LOADING_PROPS_REJECTED_CODE,
        rejections: [{ field: 'announcement', code: 'ANNOUNCEMENT_TOO_LONG' }],
      });

      jest.useRealTimers();
    });

    it('emits no report for valid props', () => {
      jest.useFakeTimers();
      render(<ReputationLoadingClient focusDelayMs={200} announcement="Loading" autoFocus />);

      jest.advanceTimersByTime(200);
      expect(reporter).not.toHaveBeenCalled();

      jest.useRealTimers();
    });
  });
});
