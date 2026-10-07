import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import * as vscode from 'vscode';
import { AdManager, OPEN_AD_COMMAND, SET_API_KEY_COMMAND } from './ad-manager';
import {
  AirewardsApiClient,
  FALLBACK_API_BASE_URL,
  type IdePlatform,
  canonicalizeApiBaseUrl,
} from './api-client';

/**
 * AIRewards VS Code extension.
 *
 * This host reaches the same backend as the browser extension and desktop
 * agent, but it cannot carry the HttpOnly Auth.js session cookie those clients
 * rely on. Instead the earner generates a developer API key on the dashboard
 * (Profile → Developer Settings) and the extension sends it as
 * `Authorization: Bearer <key>`.
 *
 * The key lives in VS Code SecretStorage (OS keychain), with automatic fallback
 * to process.env.AIREWARDS_API_KEY or ~/.airewards/config.json.
 */

const API_KEY_SECRET = 'airewards.apiKey';
const API_KEY_PREFIX = 'air_dev_';
const DEFAULT_API_BASE_URL = process.env.AIREWARDS_API_URL || FALLBACK_API_BASE_URL;

/**
 * Map the running editor onto a `TARGET_PLATFORMS` slug so advertisers
 * targeting Cursor or Windsurf specifically reach those installs.
 */
function detectPlatform(): IdePlatform {
  const appName = vscode.env.appName.toLowerCase();
  if (appName.includes('cursor')) return 'cursor';
  if (appName.includes('windsurf')) return 'windsurf';
  return 'vscode';
}

function resolveBaseUrl(): string {
  const configured = vscode.workspace.getConfiguration('airewards').get<string>('apiBaseUrl');
  return canonicalizeApiBaseUrl(configured);
}

export interface ApiKeyDetails {
  key?: string;
  source: string;
}

export async function getApiKeyDetails(context: vscode.ExtensionContext): Promise<ApiKeyDetails> {
  const secret = await context.secrets.get(API_KEY_SECRET);
  if (secret && secret.trim().length > 0) {
    return { key: secret.trim(), source: 'VS Code SecretStorage (OS Keychain)' };
  }

  if (process.env.AIREWARDS_API_KEY && process.env.AIREWARDS_API_KEY.trim().length > 0) {
    return {
      key: process.env.AIREWARDS_API_KEY.trim(),
      source: 'Environment variable (AIREWARDS_API_KEY)',
    };
  }

  try {
    const configPath = join(homedir(), '.airewards', 'config.json');
    if (existsSync(configPath)) {
      const parsed = JSON.parse(readFileSync(configPath, 'utf8'));
      if (typeof parsed?.apiKey === 'string' && parsed.apiKey.trim().length > 0) {
        return { key: parsed.apiKey.trim(), source: '~/.airewards/config.json' };
      }
    }
  } catch {
    // Ignore read errors
  }

  return { key: undefined, source: 'None configured' };
}

async function getEffectiveApiKey(context: vscode.ExtensionContext): Promise<string | undefined> {
  const details = await getApiKeyDetails(context);
  return details.key;
}

export function activate(context: vscode.ExtensionContext): void {
  let baseUrl: string;
  try {
    baseUrl = resolveBaseUrl();
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Invalid API URL';
    void vscode.window.showErrorMessage(`AIRewards is disabled: ${message}`);
    return;
  }

  const client = new AirewardsApiClient(baseUrl, () => getEffectiveApiKey(context));
  const manager = new AdManager(client, detectPlatform());
  client.setLogger((msg) => manager.log(msg));
  context.subscriptions.push(manager);

  const promptSetApiKey = async () => {
    const currentKey = await getEffectiveApiKey(context);
    const apiKey = await vscode.window.showInputBox({
      title: currentKey ? 'Update AIRewards API Key' : 'Set AIRewards API Key',
      prompt: `Paste the ${API_KEY_PREFIX}… key from Profile → Developer Settings`,
      placeHolder: `${API_KEY_PREFIX}xxxxxxxxxxxx`,
      password: true,
      ignoreFocusOut: true,
      validateInput: (value) =>
        value.trim().startsWith(API_KEY_PREFIX)
          ? undefined
          : `AIRewards API keys start with "${API_KEY_PREFIX}"`,
    });

    if (!apiKey) return;

    await context.secrets.store(API_KEY_SECRET, apiKey.trim());
    void vscode.window.showInformationMessage('AIRewards API key updated successfully.');
  };

  context.subscriptions.push(
    vscode.commands.registerCommand(SET_API_KEY_COMMAND, promptSetApiKey),
    vscode.commands.registerCommand('airewards.updateApiKey', promptSetApiKey),
    vscode.commands.registerCommand('airewards.diagnose', async () => {
      const info = await getApiKeyDetails(context);
      await manager.diagnose(info);
    }),
    vscode.commands.registerCommand('airewards.fetchAdNow', () => manager.fetchAdNow()),
    vscode.commands.registerCommand(OPEN_AD_COMMAND, () => manager.openCurrentAd()),

    // Fires for store and delete alike — from our command, another window, or
    // a keychain sync — so the poller always reflects the current key.
    context.secrets.onDidChange((event) => {
      if (event.key === API_KEY_SECRET) manager.onApiKeyChanged();
    }),
  );

  // Watch for ~/.airewards/config.json changes (e.g. from CLI `set-api-key`)
  try {
    const configDir = join(homedir(), '.airewards');
    if (existsSync(configDir)) {
      const watcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(configDir, 'config.json'),
      );
      watcher.onDidChange(() => {
        manager.log('Detected update in ~/.airewards/config.json');
        manager.onApiKeyChanged();
      });
      watcher.onDidCreate(() => {
        manager.log('Detected creation of ~/.airewards/config.json');
        manager.onApiKeyChanged();
      });
      context.subscriptions.push(watcher);
    }
  } catch {
    // Optional watcher
  }

  manager.start();

  // Retry startup poll shortly after launch in case SecretStorage was still unlocking
  const initialRetryTimer = setTimeout(() => {
    manager.log('Running startup verification poll...');
    void manager.poll();
  }, 2_500);
  context.subscriptions.push({ dispose: () => clearTimeout(initialRetryTimer) });
}

export function deactivate(): void {
  // Disposal is handled via context.subscriptions.
}
