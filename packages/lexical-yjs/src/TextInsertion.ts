/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {
  $getSelection,
  $isRangeSelection,
  $isTextNode,
  $normalizeSelection__EXPERIMENTAL,
  COMMAND_PRIORITY_HIGH,
  CONTROLLED_TEXT_INSERTION_COMMAND,
  type LexicalEditor,
} from 'lexical';

/**
 * Moves a collapsed element caret onto the simple, mergeable text node beside
 * it before text is inserted. Returns false so that the editor's own handler
 * still performs the insertion.
 *
 * A peer's caret can still be an element point in an empty paragraph after
 * remote text arrives there. Inserting at that point creates a new TextNode,
 * and normalization then merges the remote text into it, so the remote text
 * is written back to Yjs under a new identity. When several peers do this at
 * the same time, each of them writes its own copy of the shared characters.
 * Typing into the existing TextNode keeps its identity.
 *
 * Element points beside unmergeable or special text nodes are intentional
 * boundaries and are left alone.
 *
 * Register it in every collaborative editor, next to the listeners that sync
 * the editor with Yjs. It returns a function that unregisters it.
 */
export function registerCollabTextInsertion(editor: LexicalEditor): () => void {
  return editor.registerCommand(
    CONTROLLED_TEXT_INSERTION_COMMAND,
    () => {
      const selection = $getSelection();
      if (
        $isRangeSelection(selection) &&
        selection.isCollapsed() &&
        selection.anchor.type === 'element'
      ) {
        const element = selection.anchor.getNode();
        const offset = selection.anchor.offset;
        const child = element.getChildAtIndex(
          offset === element.getChildrenSize() ? offset - 1 : offset,
        );
        if (
          $isTextNode(child) &&
          child.isSimpleText() &&
          !child.isUnmergeable()
        ) {
          $normalizeSelection__EXPERIMENTAL(selection);
        }
      }
      return false;
    },
    COMMAND_PRIORITY_HIGH,
  );
}
