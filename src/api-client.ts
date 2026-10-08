/**
 * Thin fetch-based client for the AIRewards backend.
 *
 * The extension host cannot hold the HttpOnly Auth.js session cookie the
 * browser clients use, so every request authenticates with the developer API
 * key (`air_dev_…`) as `Authorization: Bearer <key>`. The key is read lazily
 * per request from SecretStorage so a key set or rotated mid-session takes
 * effect on the next call without a reload.
 *
 * Native `fetch` (Node 18+ in the extension host) keeps the extension
 * dependency-free; the SDK's hono client would require a bundling step this
 * package does not have.
 */

/** Editor surfaces this extension can run on, per `TARGET_PLATFORMS`. */
export type IdePlatform = 'vscode' | 'cursor' | 'windsurf';

export interface Ad {
  readonly adId: string;
  readonly text: string;
  readonly url: string;
  readonly trackingSignature: string;
}

export interface ImpressionPayload {
  readonly impressionId: string;
  readonly adId: string;
  readonly trackingSignature: string;
  readonly platform: IdePlatform;
  readonly viewedAt: Date;
  readonly durationMs: number;
  readonly isVisible?: () => boolean | Promise<boolean>;
}

/** Raised when no API key is stored; callers show the "set key" affordance. */
export class MissingApiKeyError extends Error {
  constructor() {
    super('No AIRewards API key configured');
    this.name = 'MissingApiKeyError';
  }
}

/** Raised for non-2xx responses; `status` lets callers branch on 401/404/403/409/429. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly retryAfter?: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

interface SuccessEnvelope<T> {
  success: true;
  data: T;
}

interface WireAd {
  ad_id: string;
  text: string;
  url: string;
  tracking_signature: string;
}

export const FALLBACK_API_BASE_URL = 'https://www.airewards.tech';

const AI_REWARDS_API_HOSTS = new Set([
  'airewards.tech',
  'www.airewards.tech',
  'airewards.codermillat.workers.dev',
]);

function isLoopbackHost(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
}

export function isHttpsUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password;
  } catch {
    return false;
  }
}

export function canonicalizeApiBaseUrl(url?: string): string {
  if (!url || url.trim().length === 0) return FALLBACK_API_BASE_URL;
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    throw new Error('AIRewards API URL must be an absolute URL');
  }

  const isLoopback = isLoopbackHost(parsed.hostname);
  const isLegacyAiRewardsHost =
    parsed.hostname === 'airewards.tech' ||
    parsed.hostname === 'airewards.codermillat.workers.dev' ||
    (parsed.hostname === 'www.airewards.tech' && parsed.protocol === 'http:');

  if (isLegacyAiRewardsHost && parsed.pathname === '/' && !parsed.search && !parsed.hash) {
    return FALLBACK_API_BASE_URL;
  }

  const isAiRewardsHost = AI_REWARDS_API_HOSTS.has(parsed.hostname);
  if (
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    (!isAiRewardsHost && !isLoopback) ||
    (isAiRewardsHost && parsed.port !== '') ||
    (parsed.protocol !== 'https:' && !(isLoopback && parsed.protocol === 'http:'))
  ) {
    throw new Error('AIRewards API URL must use an AIRewards host or a local development host');
  }

  return `${parsed.origin}${parsed.pathname.replace(/\/+$/, '')}`;
}

export class AirewardsApiClient {
  private readonly normalizedBaseUrl: string;
  private logger?: (msg: string) => void;

  constructor(
    baseUrl: string,
    private readonly getApiKey: () => Thenable<string | undefined>,
    logger?: (msg: string) => void,
  ) {
    this.normalizedBaseUrl = canonicalizeApiBaseUrl(baseUrl);
    this.logger = logger;
  }

  setLogger(logger: (msg: string) => void): void {
    this.logger = logger;
  }

  getBaseUrl(): string {
    return this.normalizedBaseUrl;
  }

  /**
   * Fetch the ad currently eligible for this platform.
   * Returns null when the backend has nothing to show (404).
   */
  async fetchCurrentAd(platform: IdePlatform): Promise<Ad | null> {
    const response = await this.request(
      'GET',
      `/v1/ads/current?platform=${encodeURIComponent(platform)}`,
    );

    if (response.status === 404) return null;
    if (!response.ok) {
      const retryAfterHeader = response.headers.get('Retry-After');
      const parsedRetryAfter = retryAfterHeader ? Number.parseInt(retryAfterHeader, 10) : undefined;
      const retryAfter = Number.isFinite(parsedRetryAfter) ? parsedRetryAfter : undefined;
      throw new ApiError(response.status, `Ad fetch failed (${response.status})`, retryAfter);
    }

    const body = (await response.json()) as SuccessEnvelope<WireAd>;
    if (!isHttpsUrl(body.data.url)) {
      throw new ApiError(502, 'Ad destination must use HTTPS');
    }
    return {
      adId: body.data.ad_id,
      text: body.data.text,
      url: body.data.url,
      trackingSignature: body.data.tracking_signature,
    };
  }

  /**
   * Register (or refresh) this editor install as an IDE device. Impressions
   * are rejected until the user has at least one device on record.
   */
  async registerDevice(fingerprint: string): Promise<void> {
    const response = await this.request('POST', '/v1/devices/register', {
      type: 'IDE',
      fingerprint,
    });

    if (!response.ok) {
      throw new ApiError(response.status, `Device registration failed (${response.status})`);
    }
  }

  /** Record one impression, crediting the developer's wallet. */
  async recordImpression(payload: ImpressionPayload): Promise<void> {
    const created = await this.request('POST', '/v2/impressions/challenges', {
      ad_id: payload.adId,
      tracking_signature: payload.trackingSignature,
      provider: payload.platform.toUpperCase(),
      platform: payload.platform,
      conversation_id: null,
    });
    if (!created.ok)
      throw new ApiError(created.status, `Impression challenge failed (${created.status})`);
    const challenge = (await created.json()) as SuccessEnvelope<{
      impression_id: string;
      challenge: string;
    }>;
    for (
      let sequence = 0;
      sequence < Math.max(6, Math.ceil(payload.durationMs / 1_000) + 1);
      sequence += 1
    ) {
      if (sequence > 0) await new Promise((resolve) => setTimeout(resolve, 1_000));
      const visible = (await payload.isVisible?.()) ?? true;
      const heartbeat = await this.request(
        'POST',
        `/v2/impressions/${challenge.data.impression_id}/heartbeats`,
        {
          challenge: challenge.data.challenge,
          sequence,
          visible,
        },
      );
      if (!heartbeat.ok)
        throw new ApiError(heartbeat.status, `Impression heartbeat failed (${heartbeat.status})`);
      if (!visible) throw new Error('Impression display ended before evidence was complete');
    }
    const completed = await this.request(
      'POST',
      `/v2/impressions/${challenge.data.impression_id}/complete`,
      {
        challenge: challenge.data.challenge,
      },
    );
    if (!completed.ok)
      throw new ApiError(completed.status, `Impression completion failed (${completed.status})`);
  }

  private async request(method: string, path: string, body?: unknown): Promise<Response> {
    const apiKey = await this.getApiKey();
    if (!apiKey) throw new MissingApiKeyError();

    const url = `${this.normalizedBaseUrl}${path}`;
    this.logger?.(`[API] ${method} ${url}`);

    const headers: Record<string, string> = {
      Authorization: `Bearer ${apiKey}`,
      Accept: 'application/json',
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    };

    let response = await fetch(url, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      redirect: 'manual',
    });

    // Follow only same-origin redirects so a response cannot forward credentials.
    if (response.status >= 301 && response.status <= 308) {
      const location = response.headers.get('location');
      if (location) {
        const nextUrl = new URL(location, url);
        if (
          nextUrl.origin !== new URL(url).origin ||
          nextUrl.username.length > 0 ||
          nextUrl.password.length > 0
        ) {
          throw new ApiError(response.status, 'Refusing cross-origin API redirect');
        }
        this.logger?.(`[API] Following same-origin redirect (${response.status}) -> ${nextUrl}`);
        response = await fetch(nextUrl, {
          method,
          headers,
          body: body !== undefined ? JSON.stringify(body) : undefined,
          redirect: 'manual',
        });
      }
    }

    return response;
  }
}
