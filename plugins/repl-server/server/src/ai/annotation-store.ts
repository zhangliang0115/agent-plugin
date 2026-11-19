/**
 * Pending auto-annotation previews (08 §4.7): one per server, 30 minute TTL,
 * at most 20 entries, plus the per-process `(serverId, toolsHash)` attempt set
 * that stops a refresh loop from paying for the same annotation twice.
 * @module
 */

import { systemClock, type Clock } from '../ports.ts';
import { AI_ANNOTATION_MAX, AI_ANNOTATION_TTL_MS } from './constants.ts';
import type { DictionarySuggestion, NormalizedToolOverride } from './validate.ts';

export interface AnnotationProposed {
  summary: string | null;
  category: string | null;
  categorySuggestion: DictionarySuggestion | null;
  tags: string[];
  tagSuggestions: DictionarySuggestion[];
  toolOverrides: NormalizedToolOverride[];
}

export interface PendingAnnotationMeta {
  model: string | null;
  durationMs: number;
  promptVersion: number;
  costUsd: number | null;
}

export interface PendingAnnotation {
  serverId: string;
  proposed: AnnotationProposed;
  warnings: string[];
  omittedTools: number;
  createdAt: string;
  expiresAt: number;
  /** Internal: lets `onToolsIndexed` keep a pending draft for an unchanged tool set. */
  toolsHash: string;
  meta: PendingAnnotationMeta;
}

export interface PendingAnnotationView {
  serverId: string;
  proposed: AnnotationProposed;
  warnings: string[];
  omittedTools: number;
  createdAt: string;
}

export interface AnnotationStore {
  put(input: Omit<PendingAnnotation, 'expiresAt'>): PendingAnnotation;
  get(serverId: string): PendingAnnotation | null;
  list(): PendingAnnotation[];
  deleteByServer(serverId: string): void;
  hasAttempt(key: string): boolean;
  markAttempt(key: string): void;
}

export interface AnnotationStoreOptions {
  ttlMs?: number;
  maxEntries?: number;
  clock?: Clock;
}

export function createAnnotationStore(options: AnnotationStoreOptions = {}): AnnotationStore {
  const ttlMs = options.ttlMs ?? AI_ANNOTATION_TTL_MS;
  const maxEntries = options.maxEntries ?? AI_ANNOTATION_MAX;
  const clock = options.clock ?? systemClock;
  const entries = new Map<string, PendingAnnotation>();
  const attempts = new Set<string>();

  function purgeExpired(now: number): void {
    for (const [serverId, entry] of entries) {
      if (entry.expiresAt <= now) entries.delete(serverId);
    }
  }

  return {
    put(input) {
      const now = clock.now();
      purgeExpired(now);
      entries.delete(input.serverId);
      while (entries.size >= maxEntries) {
        const oldest = entries.keys().next();
        if (oldest.done === true) break;
        entries.delete(oldest.value);
      }
      const entry: PendingAnnotation = { ...input, expiresAt: now + ttlMs };
      entries.set(entry.serverId, entry);
      return entry;
    },
    get(serverId) {
      const entry = entries.get(serverId);
      if (entry === undefined) return null;
      if (entry.expiresAt <= clock.now()) {
        entries.delete(serverId);
        return null;
      }
      return entry;
    },
    list() {
      purgeExpired(clock.now());
      return [...entries.values()];
    },
    deleteByServer(serverId) {
      entries.delete(serverId);
    },
    hasAttempt(key) {
      return attempts.has(key);
    },
    markAttempt(key) {
      attempts.add(key);
    },
  };
}
