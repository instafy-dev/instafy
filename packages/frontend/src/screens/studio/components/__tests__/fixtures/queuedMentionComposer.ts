import { $createParagraphNode, $createTextNode, $getRoot, createEditor } from "lexical";
import { $createUserMentionNode, UserMentionNode } from "../../chat-input/UserMentionNode";

export const QUEUED_MENTION_USER_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

/** A real serialized picker node, using the same Lexical schema as ChatInput. */
export function queuedMentionComposer(suffix = " please check the page", selected = true) {
  const editor = createEditor({ namespace: "queue-test", nodes: [UserMentionNode], onError: (error) => { throw error; } });
  editor.update(() => {
    $getRoot().append($createParagraphNode().append(
      selected
        ? $createUserMentionNode({ userId: QUEUED_MENTION_USER_ID, handle: "taylor", displayName: "Taylor" })
        : $createTextNode("@taylor"),
      $createTextNode(suffix),
    ));
  }, { discrete: true });
  return {
    message: editor.getEditorState().read(() => $getRoot().getTextContent()),
    editorState: JSON.stringify(editor.getEditorState().toJSON()),
  };
}
