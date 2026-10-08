/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $getSelection,
  $isRangeSelection,
  createEditor,
  type LexicalEditor,
  type ParagraphNode,
  type TextNode,
} from 'lexical';
import {test} from 'vitest';
import {
  applyUpdate,
  Doc,
  encodeStateAsUpdate,
  mergeUpdates,
  type Text as YText,
  type YEvent,
} from 'yjs';

import {
  createBinding,
  type Provider,
  syncLexicalUpdateToYjs,
  syncYjsChangesToLexical,
} from '..';

// Applies remote v1 updates to one long paragraph made of many formatted
// text runs. Each measured iteration integrates one update from another
// peer and commits the resulting editor update. The updates are recorded
// before timing, so the sender's own work is not measured.
const RUNS = [100, 1000] as const;
const RUN_TEXT = 'abcdefgh';
const ITERATIONS = 400;
const WARMUP = 50;

let _benchSink: unknown;

type Peer = {doc: Doc; editor: LexicalEditor; dispose: () => void};

function createPeer(name: string): Peer {
  const doc = new Doc();
  const editor = createEditor({
    namespace: name,
    onError(error) {
      throw error;
    },
  });
  const noop = () => {};
  const provider: Provider = {
    awareness: {
      getLocalState: () => null,
      getStates: () => new Map(),
      off: noop,
      on: noop,
      setLocalState: noop,
      setLocalStateField: noop,
    },
    connect: noop,
    disconnect: noop,
    off: noop,
    on: noop,
  };
  const binding = createBinding(
    editor,
    provider,
    name,
    doc,
    new Map([[name, doc]]),
  );
  const removeListener = editor.registerUpdateListener(
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
  );
  const root = binding.root.getSharedType();
  const observer: Parameters<typeof root.observeDeep>[0] = (
    events,
    transaction,
  ) => {
    if (transaction.origin !== binding) {
      syncYjsChangesToLexical(
        binding,
        provider,
        events as YEvent<YText>[],
        false,
      );
    }
  };
  root.observeDeep(observer);
  return {
    dispose: () => {
      removeListener();
      root.unobserveDeep(observer);
      doc.destroy();
    },
    doc,
    editor,
  };
}

function $runs(): TextNode[] {
  return $getRoot()
    .getFirstChildOrThrow<ParagraphNode>()
    .getChildren<TextNode>();
}

function $describe(): string {
  return JSON.stringify(
    $runs().map(node => [node.getTextContent(), node.getFormat()]),
  );
}

// A run with at least four characters, spread across the paragraph.
function $spreadRun(i: number): TextNode {
  const nodes = $runs();
  for (let j = 0; j < nodes.length; j++) {
    const node = nodes[(i * 37 + j) % nodes.length];
    if (node.getTextContentSize() >= 4) {
      return node;
    }
  }
  throw new Error('No run is long enough');
}

const WORKLOADS: Record<string, (i: number) => void> = {
  // One character deleted from a different run each time.
  'delete in the middle': i => {
    $spreadRun(i).select(2, 3).removeText();
  },

  // Formatting part of a run splits it with deletes and embed inserts.
  // Removing that format again merges the three runs back together.
  'format part of a run': i => {
    if (i % 2 === 0) {
      const [, middle] = $spreadRun(i).splitText(1, 3);
      middle.toggleFormat('underline').select();
    } else {
      const middle = $runs().find(node => node.hasFormat('underline'))!;
      middle.toggleFormat('underline').select();
    }
  },
  // Text appended to the last run: a retain and a string insert.
  'type at the end': () => {
    $runs().at(-1)!.select().insertText('x');
  },

  // Text inserted inside a run in the middle of the paragraph.
  'type in the middle': () => {
    const nodes = $runs();
    nodes[nodes.length >> 1].select(2, 2).insertText('x');
  },
};

for (const runs of RUNS) {
  for (const [workload, $edit] of Object.entries(WORKLOADS)) {
    test(`runs=${runs} :: ${workload}`, async ({bench}) => {
      let sender: Peer;
      let receiver: Peer;
      let updates: Uint8Array[];
      let next: number;

      await bench(
        workload,
        {
          afterAll: () => {
            // Warmup and timing each stop before the last recorded update.
            while (next < updates.length) {
              applyUpdate(receiver.doc, updates[next++], 'remote');
            }
            if (
              sender.editor.read($describe) !== receiver.editor.read($describe)
            ) {
              throw new Error('The receiver did not apply every update');
            }
            sender.dispose();
            receiver.dispose();
          },
          beforeAll: () => {
            sender = createPeer('sender');
            receiver = createPeer('receiver');
            sender.editor.update(
              () => {
                const paragraph = $createParagraphNode();
                for (let i = 0; i < runs; i++) {
                  // Adjacent runs differ in format, so they never merge.
                  paragraph.append($createTextNode(RUN_TEXT).setFormat(i % 3));
                }
                $getRoot().append(paragraph);
              },
              {discrete: true},
            );
            applyUpdate(receiver.doc, encodeStateAsUpdate(sender.doc));
            receiver.editor.read(() => {
              if ($getRoot().getTextContentSize() !== runs * RUN_TEXT.length) {
                throw new Error('Unexpected document size');
              }
            });
            updates = [];
            next = 0;
            let pending: Uint8Array[] = [];
            sender.doc.on('update', update => pending.push(update));
            for (let i = 0; i < ITERATIONS + WARMUP; i++) {
              pending = [];
              sender.editor.update(
                () => {
                  $edit(i);
                  if (!$isRangeSelection($getSelection())) {
                    throw new Error('Expected a range selection');
                  }
                },
                {discrete: true},
              );
              if (pending.length === 0) {
                throw new Error('The edit did not change the document');
              }
              updates.push(mergeUpdates(pending));
            }
          },
        },
        () => {
          applyUpdate(receiver.doc, updates[next++], 'remote');
          // A read commits the pending editor update.
          _benchSink = receiver.editor.read(() =>
            $getRoot().getTextContentSize(),
          );
        },
      ).run({
        iterations: ITERATIONS,
        throws: true,
        time: 0,
        warmupIterations: WARMUP,
        warmupTime: 0,
      });
    });
  }
}
