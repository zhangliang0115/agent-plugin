/** Alert configuration bundle: narrow settings access plus the webhook SecretStore key (06 §4.1). @module */

import type { DatabaseSync } from 'node:sqlite';

import type { SecretStore } from '../secrets/store.ts';
import {
  createAlertSettingsStore,
  normalizeAlertConfig,
  WECOM_WEBHOOK_SECRET,
} from '../reports/config.ts';
import type { AlertConfig, AlertSettingsStore } from '../reports/types.ts';

export interface AlertConfigSnapshot {
  config: AlertConfig;
  revision: number;
  corrupt: boolean;
}

/**
 * Everything the admin API and the dispatcher need from configuration. The
 * webhook value is read only by the dispatcher; the admin surface uses
 * `webhookConfigured()` so the plaintext never enters a response.
 */
export interface AlertConfigStore {
  readonly secretName: string;
  /** Normalized config plus the global `meta.revision`. */
  read(): Promise<AlertConfigSnapshot>;
  /** Raw settings read, used by PUT to run the If-Match precondition. */
  readSettings(): Promise<{ raw: unknown; revision: number; corrupt: boolean }>;
  webhookConfigured(): Promise<boolean>;
  getWebhook(): Promise<string | undefined>;
  setWebhook(value: string): Promise<void>;
  deleteWebhook(): Promise<void>;
  writeSettings(config: AlertConfig, expectedRevision: number): Promise<number>;
}

export interface AlertConfigStoreDeps {
  db: DatabaseSync;
  secrets: SecretStore;
}

export function createAlertConfigStore(deps: AlertConfigStoreDeps): AlertConfigStore {
  const settings: AlertSettingsStore = createAlertSettingsStore(deps.db);

  return {
    secretName: WECOM_WEBHOOK_SECRET,

    async read() {
      const state = await settings.read();
      return {
        config: normalizeAlertConfig(state.raw),
        revision: state.revision,
        corrupt: state.corrupt,
      };
    },

    async readSettings() {
      return settings.read();
    },

    async webhookConfigured() {
      // 06 §5.3: list names, never call get() for a boolean.
      const names = await deps.secrets.listNames();
      return names.includes(WECOM_WEBHOOK_SECRET);
    },

    async getWebhook() {
      return deps.secrets.get(WECOM_WEBHOOK_SECRET);
    },

    async setWebhook(value) {
      await deps.secrets.set(WECOM_WEBHOOK_SECRET, value);
    },

    async deleteWebhook() {
      await deps.secrets.delete(WECOM_WEBHOOK_SECRET);
    },

    async writeSettings(config, expectedRevision) {
      return settings.write({ alerts: config }, expectedRevision);
    },
  };
}
