import assert from 'node:assert/strict';
import test from 'node:test';

import { Toolkit, toolkit } from '../../src/toolkit/index.ts';
import type { Extension } from '../../src/toolkit/index.ts';

test('provide/get/has scope services by key, with no global state', () => {
  const first = toolkit();
  const second = toolkit();
  first.provide('palette', { types: 1 });

  assert.equal(first.has('palette'), true);
  assert.equal(second.has('palette'), false, 'a second toolkit shares nothing');
  assert.deepEqual(first.get<{ types: number }>('palette'), { types: 1 });
  assert.equal(first.get('missing'), undefined);
});

test('effects are released in LIFO order', async () => {
  const order: string[] = [];
  const kit = toolkit();
  kit.effect(() => 'a', (value) => void order.push(`release ${value}`));
  kit.effect(
    () => 'b',
    async (value) => {
      await Promise.resolve();
      order.push(`release ${value}`);
    },
  );

  const failures = await kit.dispose();
  assert.deepEqual(failures, []);
  assert.deepEqual(order, ['release b', 'release a']);
  assert.equal(kit.disposed, true);
});

test('a failing disposer is reported without stopping the others', async () => {
  const order: string[] = [];
  const kit = toolkit();
  kit.defer(() => void order.push('first'));
  kit.defer(() => {
    throw new Error('boom');
  });
  kit.defer(() => void order.push('third'));

  const failures = await kit.dispose();
  assert.deepEqual(order, ['third', 'first']);
  assert.deepEqual(failures.map((error) => error.message), ['boom']);
});

test('an extension whose dependency is missing is skipped and named', () => {
  const kit = toolkit();
  const ran: string[] = [];
  const needsInstance: Extension<Toolkit> = {
    name: 'runtime-probe',
    requires: ['liveInstance'],
    apply: () => {
      ran.push('runtime-probe');
    },
  };

  assert.equal(kit.use(needsInstance), false);
  assert.deepEqual(kit.skipped, [{ name: 'runtime-probe', missing: ['liveInstance'] }]);
  assert.deepEqual(ran, [], 'a skipped extension must not run');

  kit.provide('liveInstance', {});
  assert.equal(kit.use(needsInstance), true);
  assert.deepEqual(ran, ['runtime-probe']);
});

test('an extension may register its own undo, which is also LIFO', async () => {
  const kit = toolkit();
  const order: string[] = [];
  kit.use({
    name: 'with-undo',
    apply: () => {
      order.push('apply');
      return () => {
        order.push('undo');
      };
    },
  });
  kit.defer(() => void order.push('outer'));

  await kit.dispose();
  assert.deepEqual(order, ['apply', 'outer', 'undo']);
});

test('a disposed toolkit refuses further use', async () => {
  const kit = toolkit();
  await kit.dispose();
  assert.throws(() => kit.provide('x', 1), /disposed/);
  assert.throws(() => kit.use({ name: 'x', apply: () => undefined }), /disposed/);
  assert.deepEqual(await kit.dispose(), [], 'disposing twice is a no-op');
});
