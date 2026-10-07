import { randomUUID } from 'node:crypto';
import * as vscode from 'vscode';
import {
  type Ad,
  type AirewardsApiClient,
  ApiError,
  type IdePlatform,
  MissingApiKeyError,
  isHttpsUrl,
} from './api-client';

/**
 * Owns the earn loop: polls the backend for the current ad, renders it in the
 * status bar, and reports one impression per unique ad fetch once the ad has
 * been visible for the backend's minimum dwell time.
 */

/** How often to ask the backend for a fresh ad. */
const POLL_INTERVAL_MS = 60_000;

/**
 * Dwell time before an impression counts. Must be >= the backend's
 * `duration_ms` minimum (5s) or the payload is rejected with a 400.
 */
const IMPRESSION_DELAY_MS = 5_000;

/**
 * Left of the line/column indicator, right-aligned like other earn indicators.
 */
const STATUS_BAR_PRIORITY = 100;

/** Keep the status bar unobtrusive; the full ad text lives in the tooltip. */
const MAX_STATUS_BAR_TEXT_LENGTH = 60;

/**
 * Upper bound on remembered tracking signatures. Signatures expire server-side
 * after 5 minutes, so anything beyond the recent past is dead weight; clearing
 * wholesale is fine because a re-send of an old signature would be rejected
 * (expired) rather than double-credited.
 */
const MAX_LOGGED_SIGNATURES = 200;

/** Command id the status bar item triggers; registered in extension.ts. */
export const OPEN_AD_COMMAND = 'airewards.openCurrentAd';
export const SET_API_KEY_COMMAND = 'airewards.setApiKey';

export class AdManager implements vscode.Disposable {
  private readonly statusBarItem: vscode.StatusBarItem;
  private readonly outputChannel: vscode.OutputChannel;
  private pollTimer: NodeJS.Timeout | undefined;
  private impressionTimer: NodeJS.Timeout | undefined;
  private currentAd: Ad | undefined;
  private pollInFlight = false;
  private disposed = false;

  /**
   * Signatures already reported (or in flight). Each ad fetch returns a fresh
   * signature, so keying on it guarantees exactly one impression per fetch —
   * a repeated poll returning the same payload never re-reports.
   */
  private readonly loggedSignatures = new Set<string>();

  /** Registration is idempotent server-side; one attempt per session suffices. */
  private deviceRegistration: Promise<void> | undefined;

  /** Surface an invalid-key warning once per key, not once per poll. */
  private authWarningShown = false;

  constructor(
    private readonly client: AirewardsApiClient,
    private readonly platform: IdePlatform,
  ) {
    this.outputChannel = vscode.window.createOutputChannel('AIRewards');
    this.statusBarItem = vscode.window.createStatusBarItem(
      'airewards.status',
      vscode.StatusBarAlignment.Right,
      STATUS_BAR_PRIORITY,
    );
    this.statusBarItem.name = 'AIRewards Earnings';
    this.showIdle();
    this.statusBarItem.show();
  }

  log(message: string): void {
    const time = new Date().toLocaleTimeString();
    this.outputChannel.appendLine(`[${time}] ${message}`);
  }

  /** Begin the earn loop: one immediate poll, then every POLL_INTERVAL_MS. */
  start(): void {
    if (this.pollTimer || this.disposed) return;
    this.log(`Earn loop initialized for platform: "${this.platform}"`);
    this.log(`Backend endpoint: ${this.client.getBaseUrl()}`);
    void this.poll();
    this.pollTimer = setInterval(() => void this.poll(), POLL_INTERVAL_MS);
  }

  /** Called when the stored API key changes: re-arm the warning and re-poll. */
  onApiKeyChanged(): void {
    this.authWarningShown = false;
    this.log('API key configuration changed, re-polling...');
    void this.poll();
  }

  /** Open the displayed ad's destination in the default browser. */
  async openCurrentAd(): Promise<void> {
    if (!this.currentAd) return;
    if (!isHttpsUrl(this.currentAd.url)) {
      this.log('Refusing to open an ad destination that is not HTTPS.');
      return;
    }
    this.log(`Opening ad target in browser: ${this.currentAd.url}`);
    await vscode.env.openExternal(vscode.Uri.parse(this.currentAd.url));
  }

  /** Manual ad refresh triggered by user. */
  async fetchAdNow(): Promise<void> {
    this.log('Manual ad check requested by user');
    const ad = await this.poll();
    if (ad) {
      void vscode.window.showInformationMessage('AIRewards: Sponsored ad loaded in status bar.');
    } else {
      void vscode.window.showInformationMessage(
        'AIRewards: Checked for ads (no sponsored line right now).',
      );
    }
  }

  /** Diagnostic check to verify configuration, connectivity, and ad retrieval. */
  async diagnose(apiKeyInfo: { key?: string; source: string }): Promise<void> {
    this.outputChannel.show(true);
    this.log('=== AIRewards Diagnostic Check ===');
    this.log(`Editor Platform: ${this.platform} (${vscode.env.appName})`);
    this.log(`API Base URL: ${this.client.getBaseUrl()}`);
    if (apiKeyInfo.key) {
      const masked = `${apiKeyInfo.key.slice(0, 10)}...${apiKeyInfo.key.slice(-4)}`;
      this.log(`API Key: ${masked} (source: ${apiKeyInfo.source})`);
    } else {
      this.log('API Key: NOT CONFIGURED');
    }

    if (!apiKeyInfo.key) {
      void vscode.window
        .showErrorMessage(
          'AIRewards: No API key found. Run "AIRewards: Set / Update API Key" or use the CLI.',
          'Set API Key',
        )
        .then((sel) => {
          if (sel === 'Set API Key') {
            void vscode.commands.executeCommand(SET_API_KEY_COMMAND);
          }
        });
      return;
    }

    this.log('Testing connectivity and ad fetching from backend...');
    try {
      const ad = await this.client.fetchCurrentAd(this.platform);
      if (ad) {
        this.log(`SUCCESS: Fetched ad [${ad.adId}]: "${ad.text}"`);
        this.displayAd(ad);
        void vscode.window
          .showInformationMessage(
            `AIRewards is connected & active! Sponsored line: "${truncate(ad.text, 50)}"`,
            'Open Link',
          )
          .then((action) => {
            if (action === 'Open Link') void this.openCurrentAd();
          });
      } else {
        this.log(
          'SUCCESS: Connected to AIRewards backend. No active campaigns currently targeting this platform.',
        );
        void vscode.window.showInformationMessage(
          'AIRewards is connected! No active sponsored line right now.',
        );
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.log(`DIAGNOSTIC ERROR: ${msg}`);
      void vscode.window.showErrorMessage(`AIRewards Diagnostic failed: ${msg}`);
    }
  }

  dispose(): void {
    this.disposed = true;
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.impressionTimer) clearTimeout(this.impressionTimer);
    this.pollTimer = undefined;
    this.impressionTimer = undefined;
    this.statusBarItem.dispose();
    this.outputChannel.dispose();
  }

  async poll(): Promise<Ad | null> {
    if (this.pollInFlight || this.disposed) return null;
    this.pollInFlight = true;

    try {
      this.log(`Checking for ads (${this.platform})...`);
      const ad = await this.client.fetchCurrentAd(this.platform);

      if (ad) {
        this.log(`Ad received: "${ad.text}"`);
        this.displayAd(ad);
        return ad;
      }
      this.log('No ads available currently for this platform (404/empty)');
      this.currentAd = undefined;
      this.showIdle();
      return null;
    } catch (error) {
      this.currentAd = undefined;

      if (error instanceof MissingApiKeyError) {
        this.log('No API key configured. Run "AIRewards: Set / Update API Key".');
        this.showNeedsApiKey();
      } else if (error instanceof ApiError && error.status === 401) {
        this.log('API key rejected (401 Unauthorized).');
        this.showNeedsApiKey();
        if (!this.authWarningShown) {
          this.authWarningShown = true;
          void vscode.window.showWarningMessage(
            'AIRewards rejected your API key. Run "AIRewards: Set / Update API Key" to update it.',
          );
        }
      } else {
        const errorMsg = error instanceof Error ? error.message : String(error);
        this.log(`Poll error: ${errorMsg}`);
        this.showIdle();
      }
      return null;
    } finally {
      this.pollInFlight = false;
    }
  }

  private displayAd(ad: Ad): void {
    const alreadyDisplayed = this.currentAd?.trackingSignature === ad.trackingSignature;
    this.currentAd = ad;

    this.statusBarItem.text = `$(sparkle) ${truncate(ad.text, MAX_STATUS_BAR_TEXT_LENGTH)}`;
    const md = new vscode.MarkdownString();
    md.appendMarkdown('### $(sparkle) Sponsored via AIRewards\n\n**');
    md.appendText(ad.text);
    md.appendMarkdown('**\n\n_Click status bar to open_');
    md.isTrusted = false;
    this.statusBarItem.tooltip = md;
    this.statusBarItem.command = OPEN_AD_COMMAND;
    this.statusBarItem.backgroundColor = undefined;

    // A poll that returns the identical fetch (same signature) must not
    // restart the dwell timer or queue a second impression.
    if (!alreadyDisplayed) {
      this.log(`Scheduled impression dwell timer (5s) for ad: ${ad.adId}`);
      this.scheduleImpression(ad);
    }
  }

  private scheduleImpression(ad: Ad): void {
    // The previous ad is no longer visible; its pending impression is void.
    if (this.impressionTimer) clearTimeout(this.impressionTimer);

    if (this.loggedSignatures.has(ad.trackingSignature)) return;

    const viewedAt = new Date();
    this.impressionTimer = setTimeout(() => {
      this.impressionTimer = undefined;
      // Only credit if this exact fetch is still the one on screen.
      if (this.disposed || this.currentAd?.trackingSignature !== ad.trackingSignature) return;
      void this.sendImpression(ad, viewedAt);
    }, IMPRESSION_DELAY_MS);
  }

  private async sendImpression(ad: Ad, viewedAt: Date): Promise<void> {
    // Mark before sending so a slow response can't race a second attempt.
    if (this.loggedSignatures.has(ad.trackingSignature)) return;
    if (this.loggedSignatures.size >= MAX_LOGGED_SIGNATURES) this.loggedSignatures.clear();
    this.loggedSignatures.add(ad.trackingSignature);

    try {
      await this.ensureDeviceRegistered();
      await this.client.recordImpression({
        impressionId: randomUUID(),
        adId: ad.adId,
        trackingSignature: ad.trackingSignature,
        platform: this.platform,
        viewedAt,
        durationMs: IMPRESSION_DELAY_MS,
        isVisible: () =>
          !this.disposed && this.currentAd?.trackingSignature === ad.trackingSignature,
      });
    } catch (error) {
      // 409 (duplicate) and 429 (cooldown) are terminal verdicts on this
      // impression — the signature stays marked so we never re-send. Anything
      // else (network, 5xx, expired signature) is unmarked; the next fresh
      // fetch gets a new signature and a clean attempt.
      const terminal = error instanceof ApiError && (error.status === 409 || error.status === 429);
      if (!terminal) this.loggedSignatures.delete(ad.trackingSignature);
    }
  }

  private ensureDeviceRegistered(): Promise<void> {
    this.deviceRegistration ??= this.client
      .registerDevice(vscode.env.machineId)
      .catch((error: unknown) => {
        // Allow the next impression to retry registration.
        this.deviceRegistration = undefined;
        throw error;
      });
    return this.deviceRegistration;
  }

  private showIdle(): void {
    this.statusBarItem.text = '$(sparkle) AIRewards';
    this.statusBarItem.tooltip =
      'AIRewards — active & connected (no sponsored line right now). Click to check for ads.';
    this.statusBarItem.command = 'airewards.fetchAdNow';
    this.statusBarItem.backgroundColor = undefined;
  }

  private showNeedsApiKey(): void {
    this.statusBarItem.text = '$(key) AIRewards: Set Key';
    this.statusBarItem.tooltip = 'AIRewards needs your developer API key. Click here to configure.';
    this.statusBarItem.command = SET_API_KEY_COMMAND;
    this.statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
  }
}

function truncate(text: string, maxLength: number): string {
  return text.length <= maxLength ? text : `${text.slice(0, maxLength - 1)}…`;
}
