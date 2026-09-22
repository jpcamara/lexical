/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import type {CollabElementNode} from '../../CollabElementNode';

import {
  type Binding,
  createBinding,
  type Provider,
  syncLexicalUpdateToYjs,
  syncYjsChangesToLexical,
  type UserState,
} from '@lexical/yjs';
import {
  $createLineBreakNode,
  $createParagraphNode,
  $createRangeSelection,
  $createTextNode,
  $getRoot,
  $getSelection,
  $getState,
  $isRangeSelection,
  $setSelection,
  $setState,
  COMMAND_PRIORITY_EDITOR,
  CONTROLLED_TEXT_INSERTION_COMMAND,
  createEditor,
  createState,
  type LexicalEditor,
  type ParagraphNode,
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
  type Text as YText,
  XmlText,
  type YEvent,
} from 'yjs';

const settle = () => new Promise<void>(resolve => setImmediate(resolve));
const review = createState('review', {
  parse: value => (typeof value === 'string' ? value : ''),
});
function $paragraph(): ParagraphNode {
  return $getRoot().getFirstChildOrThrow<ParagraphNode>();
}

type Peer = {
  name: string;
  doc: Doc;
  editor: LexicalEditor;
  binding: Binding;
  cleanup: (() => void)[];
  text: () => string;
  update: (fn: () => void) => void;
};

// A queued transport gives every Yjs observer its own editor update, as in a
// network provider. Packets can be duplicated or reordered independently.
function network() {
  const peers: Peer[] = [];
  const pending: {from: Peer; to: Peer; update: Uint8Array}[] = [];
  function peer(name: string) {
    const doc = new Doc();
    doc.clientID = peers.length + 1;
    const editor = createEditor({
      namespace: name,
      onError: error => {
        throw error;
      },
    });
    let state: UserState | null = null;
    const provider: Provider = {
      awareness: {
        getLocalState: () => state,
        getStates: () => new Map(),
        off() {},
        on() {},
        setLocalState: value => {
          state = value;
        },
        setLocalStateField: (key, value) => {
          if (state) state[key] = value;
        },
      },
      connect() {},
      disconnect() {},
      off() {},
      on() {},
    };
    const binding = createBinding(
      editor,
      provider,
      name,
      doc,
      new Map([[name, doc]]),
    );
    const cleanup: (() => void)[] = [];
    cleanup.push(
      editor.registerCommand(
        CONTROLLED_TEXT_INSERTION_COMMAND,
        text => {
          const selection = $getSelection();
          assert.ok($isRangeSelection(selection));
          assert.equal(typeof text, 'string');
          selection.insertText(text as string);
          return true;
        },
        COMMAND_PRIORITY_EDITOR,
      ),
    );
    cleanup.push(
      editor.registerUpdateListener(
        ({
          prevEditorState,
          editorState,
          dirtyElements,
          dirtyLeaves,
          normalizedNodes,
          tags,
        }) => {
          syncLexicalUpdateToYjs(
            binding,
            provider,
            prevEditorState,
            editorState,
            dirtyElements,
            dirtyLeaves,
            normalizedNodes,
            tags,
          );
        },
      ),
    );
    binding.root.getSharedType().observeDeep((events, transaction) => {
      if (transaction.origin !== binding)
        syncYjsChangesToLexical(
          binding,
          provider,
          events as YEvent<YText>[],
          false,
        );
    });
    const result: Peer = {
      binding,
      cleanup,
      doc,
      editor,
      name,
      text: () => editor.read('latest', () => $getRoot().getTextContent()),
      update: fn => editor.update(fn, {discrete: true}),
    };
    doc.on('update', (update, origin) => {
      if (origin !== 'network')
        for (const target of peers)
          if (target !== result)
            pending.push({from: result, to: target, update});
    });
    peers.push(result);
    return result;
  }
  async function deliver(index = 0, duplicate = false) {
    assert.ok(index >= 0 && index < pending.length, 'expected a queued packet');
    const {to, update} = pending.splice(index, 1)[0];
    applyUpdate(to.doc, update, 'network');
    if (duplicate) applyUpdate(to.doc, update, 'network');
    await settle();
  }
  async function flush(random = () => 0) {
    await settle();
    for (let i = 0; i < 1000; i++) {
      if (!pending.length) {
        await settle();
        if (!pending.length) return;
      }
      await deliver(Math.floor(random() * pending.length), true);
    }
    assert.fail('updates did not settle');
  }
  function converged(expected: string) {
    const texts = peers.map(p => p.text());
    assert.equal(
      new Set(texts).size,
      1,
      `editors disagree: ${JSON.stringify(texts)}`,
    );
    assert.deepEqual(
      [...texts[0]].sort(),
      [...expected].sort(),
      `characters changed: ${texts[0]}`,
    );
    const first = encodeStateAsUpdate(peers[0].doc);
    for (const p of peers)
      assert.deepEqual(
        encodeStateAsUpdate(p.doc),
        first,
        `${p.name}: shared document diverged`,
      );
  }
  async function seed() {
    peers[0].update(() => $getRoot().append($createParagraphNode()));
    await flush();
  }
  function close() {
    for (const p of peers) {
      for (const dispose of p.cleanup.reverse()) dispose();
      p.doc.destroy();
    }
  }
  return {close, converged, deliver, flush, peer, peers, pending, seed};
}

// Browser reproduction: A arrives while B and C still have an element caret
// from the empty paragraph. Each controlled insertion used to replace A with
// an independently created BA / CA, yielding two As after convergence.
test('preserves shared text at an element caret', async () => {
  const n = network();
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
