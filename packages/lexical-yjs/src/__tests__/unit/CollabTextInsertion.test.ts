/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {registerCollabTextInsertion} from '@lexical/yjs';
import {
  $createRangeSelection,
  $createTextNode,
  $getSelection,
  $isRangeSelection,
  $setSelection,
  CONTROLLED_TEXT_INSERTION_COMMAND,
  type TextNode,
} from 'lexical';
import assert from 'node:assert/strict';
import {test} from 'vitest';

import {
  $clickIntoEmptyParagraph,
  $paragraph,
  countOf,
  network,
  type Peer,
  sharedText,
  typeCharacter,
} from './collabNetwork';

// Peers that register the collaborative text insertion handler, as
// CollaborationPlugin does.
function collaborativeNetwork() {
  const n = network();
  const peer = (name: string): Peer => {
    const p = n.peer(name);
    p.cleanup.push(registerCollabTextInsertion(p.editor));
    return p;
  };
  return {...n, peer};
}

// Browser reproduction: A arrives while B and C still have an element caret
// from the empty paragraph. Each controlled insertion used to replace A with
// an independently created BA / CA, yielding two As after convergence.
test('preserves shared text at an element caret', async () => {
  const n = collaborativeNetwork();
  const [a, b, c] = ['A', 'B', 'C'].map(n.peer);
  try {
    await n.seed();
    a.update(() => $paragraph().append($createTextNode('A')));
    await n.flush();
    for (const p of [b, c])
      p.update(() => {
        const selection = $createRangeSelection();
        const key = $paragraph().getKey();
        selection.anchor.set(key, 0, 'element');
        selection.focus.set(key, 0, 'element');
        $setSelection(selection);
        p.editor.dispatchCommand(CONTROLLED_TEXT_INSERTION_COMMAND, p.name);
      });
    await n.flush();
    n.converged('ABC');
  } finally {
    n.close();
  }
});

test('three peers typing into an empty paragraph keep one copy of each character', async () => {
  const n = collaborativeNetwork();
  const [a, b, c] = ['A', 'B', 'C'].map(n.peer);
  try {
    await n.seed();
    for (const p of [a, b, c]) p.update($clickIntoEmptyParagraph);
    typeCharacter(a, 'A');
    // A's text reaches B and C while their carets are still element carets.
    while (n.pending.some(item => item.from === a)) {
      await n.deliver(n.pending.findIndex(item => item.from === a));
    }
    for (const p of [b, c]) {
      p.editor.read(() => {
        const selection = $getSelection();
        assert.ok($isRangeSelection(selection));
        assert.equal(selection.anchor.type, 'element');
        assert.equal(selection.anchor.offset, 0);
      });
    }
    typeCharacter(b, 'B');
    typeCharacter(c, 'C');
    await n.flush();
    for (const p of n.peers) {
      for (const text of [
        p.text(),
        sharedText(p.binding.root.getSharedType()),
      ]) {
        assert.equal(text.length, 3, `${p.name} shows ${JSON.stringify(text)}`);
        for (const character of 'ABC') {
          assert.equal(
            countOf(text, character),
            1,
            `${p.name} shows ${JSON.stringify(text)}`,
          );
        }
      }
    }
  } finally {
    n.close();
  }
});

// An element caret between two differently formatted text nodes resolves onto
// the following node. The typed text must still take the caret's format, and
// the neighbouring nodes must keep theirs, on every peer.
test.each([
  [
    'bold',
    1,
    [
      ['abx', 1],
      ['cd', 2],
    ],
  ],
  [
    'italic',
    2,
    [
      ['ab', 1],
      ['xcd', 2],
    ],
  ],
  [
    'no',
    0,
    [
      ['ab', 1],
      ['x', 0],
      ['cd', 2],
    ],
  ],
] as const)(
  'typing at an element caret with %s format keeps each format',
  async (_name, format, expected) => {
    const n = collaborativeNetwork();
    const [a, b] = ['A', 'B'].map(n.peer);
    try {
      await n.seed();
      a.update(() =>
        $paragraph().append(
          $createTextNode('ab').toggleFormat('bold'),
          $createTextNode('cd').toggleFormat('italic'),
        ),
      );
      await n.flush();
      b.update(() => {
        const key = $paragraph().getKey();
        const selection = $createRangeSelection();
        selection.anchor.set(key, 1, 'element');
        selection.focus.set(key, 1, 'element');
        selection.format = format;
        $setSelection(selection);
      });
      typeCharacter(b, 'x');
      await n.flush();
      n.converged('abxcd');
      for (const p of n.peers) {
        p.editor.read(() => {
          assert.deepEqual(
            $paragraph()
              .getChildren<TextNode>()
              .map(node => [node.getTextContent(), node.getFormat()]),
            expected,
            `${p.name} formats`,
          );
        });
      }
    } finally {
      n.close();
    }
  },
);
