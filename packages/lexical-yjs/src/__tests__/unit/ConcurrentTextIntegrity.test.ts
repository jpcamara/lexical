/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import type {CollabElementNode} from '../../CollabElementNode';

import {
  $createLineBreakNode,
  $createTextNode,
  $getState,
  $setState,
  createState,
  type TextNode,
} from 'lexical';
import assert from 'node:assert/strict';
import {test} from 'vitest';
import {
  applyUpdate,
  decodeUpdate,
  Doc,
  encodeStateAsUpdate,
  Map as YMap,
  XmlText,
} from 'yjs';

import {
  $clickIntoEmptyParagraph,
  $paragraph,
  countOf,
  network,
  settle,
  sharedText,
  typeCharacter,
} from './collabNetwork';

const review = createState('review', {
  parse: value => (typeof value === 'string' ? value : ''),
});

// Real normalization cleanup overtakes the insertion it depends on. Exercise
// plain and formatted text, and another local edit while the header is absent.
test.each([false, true])(
  'preserves orphan text with formatting=%s',
  async formatted => {
    const n = network();
    const [a, b, c] = ['A', 'B', 'C'].map(n.peer);
    try {
      await n.seed();
      for (const p of [a, b, c])
        p.update(() => {
          const node = $createTextNode(p.name);
          if (formatted) {
            node.toggleFormat('bold');
            node.setStyle('color: red;');
            $setState(node, review, 'approved');
          }
          $paragraph().append(node);
        });
      await n.deliver(
        n.pending.findIndex(item => item.from === c && item.to === b),
      );
      const cleanup = n.pending.findIndex(
        item =>
          item.from === b &&
          item.to === c &&
          decodeUpdate(item.update).structs.length === 0,
      );
      assert.notEqual(
        cleanup,
        -1,
        'B must have normalized the adjacent B/C text nodes',
      );
      await n.deliver(cleanup);
      assert.equal(
        c.text(),
        'C',
        'out-of-order header removal must not delete C',
      );
      // Continue delivering cleanup/repair traffic but keep B's initial insertion
      // withheld. Repair must settle instead of generating a message ping-pong.
      for (let count = 0; ; count++) {
        const index = n.pending.findIndex(
          item =>
            (item.from === c && item.to === b) ||
            (item.from === b &&
              item.to === c &&
              decodeUpdate(item.update).structs.length === 0),
        );
        if (index === -1) break;
        assert.ok(
          count < 4,
          'repair must settle while the predecessor is still missing',
        );
        await n.deliver(index);
      }
      assert.equal(c.text(), 'C');
      c.update(() => {
        const node = $paragraph().getFirstChildOrThrow<TextNode>();
        if (formatted) {
          assert.equal(node.hasFormat('bold'), true);
          assert.equal(node.getStyle(), 'color: red;');
          assert.equal($getState(node, review), 'approved');
        }
        node.selectEnd().insertText('c');
      });
      await n.flush();
      n.converged('ABCc');
      const reader = n.peer('reader');
      applyUpdate(reader.doc, encodeStateAsUpdate(a.doc), 'network');
      await n.flush();
      n.converged('ABCc');
    } finally {
      n.close();
    }
  },
);

// A repair can arrive before the original text header. Once both integrate,
// the original header is empty. Lexical removes its node during normalization;
// the binding must remove that cache entry before the next local edit.
test('reconciles an empty header before the next local edit', async () => {
  const n = network();
  const [a, b, c] = ['A', 'B', 'C'].map(n.peer);
  try {
    await n.seed();
    for (const p of [a, b, c])
      p.update(() => $paragraph().append($createTextNode(p.name)));
    await n.deliver(
      n.pending.findIndex(item => item.from === c && item.to === a),
    );
    const insertion = n.pending.find(item => item.from === c && item.to === b)!;
    const beforeRepair = new Set(n.pending);
    await n.deliver(
      n.pending.findIndex(
        item =>
          item.from === a &&
          item.to === c &&
          decodeUpdate(item.update).structs.length === 0,
      ),
    );
    const repair = n.pending.findIndex(
      item => item.from === c && item.to === b && !beforeRepair.has(item),
    );
    assert.notEqual(repair, -1, 'C emitted a replacement header');
    await n.deliver(repair);
    await n.deliver(n.pending.indexOf(insertion));
    b.update(() => $paragraph().selectEnd().insertText('B'));
    await n.flush();
    n.converged('ABBC');
  } finally {
    n.close();
  }
});

// Two peers can repair the same text at the same time. Both headers then
// precede it and one of them is empty. The peer that created the empty one
// removes it, so no editor keeps an empty text node.
test('removes a duplicate repair header', async () => {
  const n = network();
  const [a, b, c] = ['A', 'B', 'C'].map(n.peer);
  try {
    await n.seed();
    a.update(() => $paragraph().append($createTextNode('Hello')));
    await n.flush();
    b.update(() => $paragraph().selectEnd().insertText('Word'));
    c.update(() => $paragraph().getFirstChildOrThrow().remove());
    // A and B each receive C's deletion after B's insertion, so each one
    // finds "Word" without a header and repairs it before hearing from the
    // other.
    await n.deliver(n.pending.findIndex(p => p.from === b && p.to === a));
    await n.deliver(n.pending.findIndex(p => p.from === c && p.to === a));
    await n.deliver(n.pending.findIndex(p => p.from === c && p.to === b));
    await n.flush();
    n.converged('Word');
    for (const p of n.peers) {
      p.editor.read(() => {
        assert.deepEqual(
          $paragraph()
            .getChildren()
            .map(node => node.getTextContent()),
          ['Word'],
          `${p.name} children`,
        );
      });
    }
  } finally {
    n.close();
  }
});

// A missing header after a linebreak must preserve the second run's format.
test('preserves the correct formatting after a linebreak', async () => {
  const n = network();
  const a = n.peer('A');
  try {
    await n.seed();
    a.update(() =>
      $paragraph().append(
        $createTextNode('prefix').toggleFormat('italic'),
        $createLineBreakNode(),
        $createTextNode('keep').toggleFormat('bold').setStyle('color: blue;'),
      ),
    );
    const paragraph = (
      a.binding.root._children[0] as CollabElementNode
    ).getSharedType();
    const snapshot = encodeStateAsUpdate(a.doc);
    const replica = new Doc();
    applyUpdate(replica, snapshot);
    let deletion!: Uint8Array;
    replica.on('update', update => {
      deletion = update;
    });
    (replica.get('root', XmlText).toDelta()[0].insert as XmlText).delete(8, 1); // prefix header + six characters + linebreak
    applyUpdate(a.doc, deletion, 'network');
    await settle();
    assert.equal(a.text(), 'prefix\nkeep');
    a.editor.getEditorState().read(() => {
      const node = $paragraph().getLastChildOrThrow<TextNode>();
      assert.equal(node.hasFormat('bold'), true);
      assert.equal(node.hasFormat('italic'), false);
      assert.equal(node.getStyle(), 'color: blue;');
    });
    assert.ok(
      paragraph
        .toDelta()
        .find(
          (d: {insert: unknown}) =>
            d.insert instanceof YMap && d.insert.get('__format') === 1,
        ),
    );
    replica.destroy();
  } finally {
    n.close();
  }
});

// Seeded permutations include cleanup-before-insertion and duplicate delivery.
// Compare both the rendered editor and the actual Y.Doc on every peer.
test.each(Array.from({length: 100}, (_, i) => i + 1))(
  'preserves every character under delivery schedule %s',
  async seed => {
    const n = network();
    let state = seed;
    const random = () =>
      (state = (1664525 * state + 1013904223) >>> 0) / 2 ** 32;
    try {
      ['A', 'B', 'C'].map(n.peer);
      await n.seed();
      for (const p of n.peers)
        p.update(() => $paragraph().selectEnd().insertText(p.name));
      // Keep typing while earlier updates (including normalization) are queued.
      for (let burst = 1; burst < 8; burst++) {
        for (const p of n.peers) {
          if (n.pending.length && random() < 0.7)
            await n.deliver(Math.floor(random() * n.pending.length), true);
          p.update(() => $paragraph().selectEnd().insertText(p.name));
        }
      }
      await n.flush(random);
      n.converged('ABC'.repeat(8));
    } finally {
      n.close();
    }
  },
);

test.each(Array.from({length: 50}, (_, i) => 1000 + i))(
  'three peers typing under seeded delivery schedule %s show the same text',
  async seed => {
    const n = network();
    let state = seed;
    const random = () =>
      (state = (1664525 * state + 1013904223) >>> 0) / 2 ** 32;
    const typed: Record<string, number> = {A: 4, B: 6, C: 5};
    try {
      const peers = ['A', 'B', 'C'].map(n.peer);
      await n.seed();
      for (const p of peers) p.update($clickIntoEmptyParagraph);
      const remaining = {...typed};
      while (peers.some(p => remaining[p.name] > 0)) {
        for (const p of peers) {
          // Deliver a random queued packet, sometimes twice, before typing.
          while (n.pending.length && random() < 0.5) {
            await n.deliver(
              Math.floor(random() * n.pending.length),
              random() < 0.3,
            );
          }
          if (remaining[p.name] > 0) {
            remaining[p.name]--;
            typeCharacter(p, p.name);
          }
        }
      }
      await n.flush(random);
      const texts = peers.map(p => p.text());
      const shared = peers.map(p => sharedText(p.binding.root.getSharedType()));
      assert.equal(
        new Set([...texts, ...shared]).size,
        1,
        `peers disagree: editors ${JSON.stringify(texts)}, docs ${JSON.stringify(shared)}`,
      );
      for (const [character, count] of Object.entries(typed)) {
        assert.equal(
          countOf(texts[0], character),
          count,
          `${character} in ${JSON.stringify(texts[0])}`,
        );
      }
    } finally {
      n.close();
    }
  },
);
