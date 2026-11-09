import { readFileSync, writeFileSync, chmodSync } from 'node:fs';

const IAM = 'https://iam.viessmann-climatesolutions.com/idp/v3';
const API = 'https://api.viessmann-climatesolutions.com/iot/v2';
const TIMEOUT_MS = 15_000;

export interface Feature {
  feature: string;
  isEnabled: boolean;
  properties?: Record<string, { type: string; value: unknown; unit?: string }>;
  commands?: Record<string, { uri: string; isExecutable: boolean }>;
}

/** Thrown when the ViCare API rate limit (1450 calls / 24 h on the Basic plan) is hit. */
export class RateLimitError extends Error {
  constructor(public readonly retryAt: Date) {
    super(`ViCare API rate limit reached, blocked until ${retryAt.toISOString()}`);
  }
}

/**
 * Minimal ViCare client: refresh-token auth, device discovery, one call for all features, command execution.
 * The refresh token comes from scripts/vicare-auth.mjs and is stored in a 0600 JSON file.
 */
export class ViCareApi {
  private accessToken?: string;
  private accessTokenExpiry = 0;
  private devicePath?: string;

  constructor(
    private readonly clientId: string,
    private readonly tokenFile: string,
  ) {}

  private get refreshToken(): string {
    return JSON.parse(readFileSync(this.tokenFile, 'utf8')).refreshToken;
  }

  private async token(): Promise<string> {
    if (this.accessToken && Date.now() < this.accessTokenExpiry) {
      return this.accessToken;
    }
    const refreshToken = this.refreshToken;
    const res = await fetch(`${IAM}/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', client_id: this.clientId, refresh_token: refreshToken }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const body = await res.json() as { access_token?: string; refresh_token?: string; expires_in?: number; error?: string };
    if (!res.ok || !body.access_token) {
      throw new Error(`token refresh failed (${res.status} ${body.error ?? ''}); run scripts/vicare-auth.mjs again`);
    }
    if (body.refresh_token && body.refresh_token !== refreshToken) {
      writeFileSync(this.tokenFile, JSON.stringify({ refreshToken: body.refresh_token, savedAt: new Date().toISOString() }, null, 2));
      chmodSync(this.tokenFile, 0o600);
    }
    this.accessToken = body.access_token;
    // refresh a minute early
    this.accessTokenExpiry = Date.now() + ((body.expires_in ?? 3600) - 60) * 1000;
    return this.accessToken;
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const res = await fetch(`${API}${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${await this.token()}`, 'Content-Type': 'application/json', ...init.headers },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const text = await res.text();
    const body = text ? JSON.parse(text) : {};
    if (res.status === 429) {
      const reset = Number(body.extendedPayload?.limitReset);
      throw new RateLimitError(new Date(reset > 0 ? reset : Date.now() + 3600_000));
    }
    if (res.status === 401) {
      this.accessToken = undefined;
    }
    if (!res.ok) {
      throw new Error(`${init.method ?? 'GET'} ${path.replace(/gateways\/\w+/, 'gateways/…')} -> ${res.status} ` +
        `${body.errorType ?? ''} ${body.message ?? ''}`.trim());
    }
    return body as T;
  }

  /** Finds the first installation's heating device (3 calls, once per start). */
  async discover(): Promise<{ model: string; gatewayType: string }> {
    const installs = await this.request<{ data: { id: number }[] }>('/equipment/installations');
    const installation = installs.data[0];
    if (!installation) {
      throw new Error('no installation on this ViCare account');
    }
    const gateways = await this.request<{ data: { serial: string; gatewayType: string }[] }>(
      `/equipment/installations/${installation.id}/gateways`);
    for (const gw of gateways.data) {
      const devices = await this.request<{ data: { id: string; deviceType: string; modelId: string }[] }>(
        `/equipment/installations/${installation.id}/gateways/${gw.serial}/devices`);
      const heating = devices.data.find((d) => d.deviceType === 'heating');
      if (heating) {
        this.devicePath = `/features/installations/${installation.id}/gateways/${gw.serial}/devices/${heating.id}`;
        return { model: heating.modelId, gatewayType: gw.gatewayType };
      }
    }
    throw new Error('no heating device found on this ViCare account');
  }

  /** All enabled features of the heating device, keyed by feature name (1 call). */
  async features(): Promise<Map<string, Feature>> {
    if (!this.devicePath) {
      throw new Error('device not discovered yet');
    }
    const body = await this.request<{ data: Feature[] }>(`${this.devicePath}/features`);
    return new Map(body.data.filter((f) => f.isEnabled).map((f) => [f.feature, f]));
  }

  /** Executes a feature command, e.g. ('heating.dhw.oneTimeCharge', 'activate') (1 call). */
  async command(feature: string, command: string, params: Record<string, unknown> = {}): Promise<void> {
    if (!this.devicePath) {
      throw new Error('device not discovered yet');
    }
    await this.request(`${this.devicePath}/features/${feature}/commands/${command}`, {
      method: 'POST',
      body: JSON.stringify(params),
    });
  }
}
