import { test } from 'node:test';
import assert from 'node:assert/strict';

import { TYPERT } from '../src/typert.ts';

// These checks mirror what DSH's typert-loader requires of a host face
// (dsh-typert-loader lib/index.js, validateTypertManifest). A manifest that fails there stops the
// whole desktop app from starting, so the shape is pinned here.

test('declares the host face of this package', () => {
  assert.equal(TYPERT.package, '@zhangliang0115/mcp-ui');
  assert.equal(TYPERT.face, 'host');
  assert.ok(Array.isArray(TYPERT.schemas));
});

test('every service has documentation tags, members and a types array', () => {
  for (const service of TYPERT.model.services) {
    assert.ok(Array.isArray(service.tags), 'tags');
    assert.ok(service.key.length > 0 && service.exportName.length > 0);
    assert.ok(Array.isArray(service.members) && service.members.length > 0, 'members');
    for (const member of service.members) assert.ok(member.name.length > 0 && member.signature.length > 0 && member.kind.length > 0);
    const types = (service as { types?: unknown }).types;
    assert.ok(Array.isArray(types), 'types must be an array');
    for (const type of types as ReadonlyArray<{ name: string; declaration: string }>) assert.ok(type.name.length > 0 && type.declaration.length > 0);
  }
});

test('events and objects are arrays', () => {
  assert.ok(Array.isArray(TYPERT.model.events));
  assert.ok(Array.isArray(TYPERT.model.objects));
});

test('the watch invocation is a direct stream with a strict result codec', () => {
  const [watch] = TYPERT.invocations;
  assert.equal(watch?.id, '@zhangliang0115/mcp-ui#mcpTools/watch');
  assert.equal(watch?.service, 'mcpTools');
  assert.equal(watch?.namespace, 'mcpTools');
  assert.equal(watch?.method, 'watch');
  assert.equal(watch?.mode, 'stream');
  assert.equal(watch?.invocation.kind, 'direct');
  assert.equal(watch?.result.mode, 'strict');
  assert.ok((watch?.result.typeSymbol ?? '').length > 0);
  assert.equal(typeof watch?.result.create, 'function');
});
