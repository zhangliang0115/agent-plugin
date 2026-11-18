/**
 * In-memory proposal cache (08 §3.5): 10 minute TTL, 50 entries, consumed only
 * after a successful apply. Restarting the process loses drafts; the UI simply
 * generates again.
 * @module
 */

import { randomUUID } from 'node:crypto';

import { systemClock, type Clock } from '../ports.ts';
import { AI_PROPOSAL_MAX, AI_PROPOSAL_TTL_MS } from './constants.ts';
import type { ProposalServer } from './validate.ts';

export interface StoredProposal {
  id: string;
  server: ProposalServer;
  explanation: string;
  warnings: string[];
  expiresAt: number;
}

export type ProposalLookup =
  | { kind: 'ok'; proposal: StoredProposal }
  | { kind: 'expired'; proposal: StoredProposal }
  | { kind: 'missing' };

export interface ProposalStore {
  put(input: {
    server: ProposalServer;
    explanation: string;
    warnings: string[];
  }): StoredProposal;
  lookup(id: string): ProposalLookup;
  /** Removes a proposal; call only after the server write committed. */
  take(id: string): void;
  size(): number;
}

export interface ProposalStoreOptions {
  ttlMs?: number;
  maxEntries?: number;
  clock?: Clock;
}

export function createProposalStore(options: ProposalStoreOptions = {}): ProposalStore {
  const ttlMs = options.ttlMs ?? AI_PROPOSAL_TTL_MS;
  const maxEntries = options.maxEntries ?? AI_PROPOSAL_MAX;
  const clock = options.clock ?? systemClock;
  const entries = new Map<string, StoredProposal>();

  function purgeExpired(now: number): void {
    for (const [id, entry] of entries) {
      if (entry.expiresAt <= now) entries.delete(id);
    }
  }

  /** Map insertion order is the LRU order because `lookup` re-inserts a hit. */
  function touch(id: string, entry: StoredProposal): void {
    entries.delete(id);
    entries.set(id, entry);
  }

  return {
    put(input) {
      const now = clock.now();
      purgeExpired(now);
      while (entries.size >= maxEntries) {
        const oldest = entries.keys().next();
        if (oldest.done === true) break;
        entries.delete(oldest.value);
      }
      const proposal: StoredProposal = {
        id: `prop_${randomUUID().replaceAll('-', '')}`,
        server: input.server,
        explanation: input.explanation,
        warnings: [...input.warnings],
        expiresAt: now + ttlMs,
      };
      entries.set(proposal.id, proposal);
      return proposal;
    },
    lookup(id) {
      const entry = entries.get(id);
      if (entry === undefined) return { kind: 'missing' };
      if (entry.expiresAt <= clock.now()) {
        entries.delete(id);
        return { kind: 'expired', proposal: entry };
      }
      touch(id, entry);
      return { kind: 'ok', proposal: entry };
    },
    take(id) {
      entries.delete(id);
    },
    size() {
      return entries.size;
    },
  };
}
