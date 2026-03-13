const TRANSIENT_SUPABASE_PATTERNS = [
  /fetch failed/i,
  /network/i,
  /timed out/i,
  /timeout/i,
  /econnreset/i,
  /econnrefused/i,
  /socket/i,
];

export function isTransientSupabaseTransportError(error: unknown): boolean {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === 'string'
        ? error
        : typeof error === 'object' && error && 'message' in error
          ? String((error as { message?: unknown }).message || '')
          : String(error || '');

  return TRANSIENT_SUPABASE_PATTERNS.some((pattern) => pattern.test(message));
}
