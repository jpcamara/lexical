/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {
  type Binding,
  createBinding,
  type Provider,
  syncLexicalUpdateToYjs,
  syncYjsChangesToLexical,
  type UserState,
} from '@lexical/yjs';
import {
  $createParagraphNode,
  $createRangeSelection,
  $getRoot,
  $getSelection,
  $isRangeSelection,
  $setSelection,
  COMMAND_PRIORITY_EDITOR,
  CONTROLLED_TEXT_INSERTION_COMMAND,
  createEditor,
  type LexicalEditor,
  type ParagraphNode,
} from 'lexical';
import assert from 'node:assert/strict';
import {
  applyUpdate,
  Doc,
  encodeStateAsUpdate,
  type Text as YText,
  XmlText,
  type YEvent,
} from 'yjs';

// Shared harness for the v1 binding tests that simulate several peers.

export const settle = () => new Promise<void>(resolve => setImmediate(resolve));

export function $paragraph(): ParagraphNode {
  return $getRoot().getFirstChildOrThrow<ParagraphNode>();
}

export type Peer = {
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
export function network() {
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

// The text each peer's Y.Doc holds, read from the shared types rather than the
// editor. In v1 text is stored as string inserts, and metadata as Y.Maps.
export function sharedText(type: XmlText): string {
  return type
    .toDelta()
    .map(({insert}: {insert: unknown}) =>
      typeof insert === 'string'
        ? insert
        : insert instanceof XmlText
          ? sharedText(insert)
          : '',
    )
    .join('');
}

export function countOf(text: string, character: string): number {
  return [...text].filter(c => c === character).length;
}

// Each peer clicks into the empty paragraph, leaving an element caret, and
// types through the controlled text insertion command, as a browser would.
export function $clickIntoEmptyParagraph() {
  const key = $paragraph().getKey();
  const selection = $createRangeSelection();
  selection.anchor.set(key, 0, 'element');
  selection.focus.set(key, 0, 'element');
  $setSelection(selection);
}
export function typeCharacter(p: Peer, character: string) {
  p.update(() => {
    p.editor.dispatchCommand(CONTROLLED_TEXT_INSERTION_COMMAND, character);
  });
}
