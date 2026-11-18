/** v8 state snapshots with a hard size limit. @module */
import { deserialize, serialize } from 'node:v8';

import { LIMITS } from '../constants.ts';

/** Why a snapshot was not produced. Empty buffers are used for both cases. */
export type StateSnapshotSkip = 'serialize' | 'too-large';

export interface StateSnapshot {
  /** Empty when `skipped` is set; otherwise never larger than the limit. */
  buf: ArrayBuffer;
  skipped?: StateSnapshotSkip;
}

export interface RestoredState {
  value: unknown;
  restored: 'lastGood' | 'none';
}

function emptyBuffer(): ArrayBuffer {
  return new ArrayBuffer(0);
}

/** Copies a `Buffer`/`Uint8Array` into an independent `ArrayBuffer` for transfer. */
export function toArrayBuffer(data: Uint8Array): ArrayBuffer {
  if (data.byteOffset === 0 && data.byteLength === data.buffer.byteLength) {
    return data.buffer as ArrayBuffer;
  }
  return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
}

/**
 * Serializes the sandbox `state` object.
 * Failures never throw: unserializable values report `serialize`, values over
 * the limit report `too-large`, and both return an empty buffer.
 */
export function serializeState(value: unknown, limitBytes: number = LIMITS.stateBytes): StateSnapshot {
  let data: Buffer;
  try {
    data = serialize(value);
  } catch {
    return { buf: emptyBuffer(), skipped: 'serialize' };
  }
  if (data.byteLength > limitBytes) return { buf: emptyBuffer(), skipped: 'too-large' };
  return { buf: toArrayBuffer(data) };
}

/** Restores a snapshot. Any failure (bad bytes, empty, oversized) yields `none`. */
export function restoreState(
  buf: ArrayBuffer | null | undefined,
  limitBytes: number = LIMITS.stateBytes,
): RestoredState {
  if (buf === null || buf === undefined || buf.byteLength === 0 || buf.byteLength > limitBytes) {
    return { value: undefined, restored: 'none' };
  }
  try {
    return { value: deserialize(new Uint8Array(buf)), restored: 'lastGood' };
  } catch {
    return { value: undefined, restored: 'none' };
  }
}
