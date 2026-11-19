import type { EditorConfig, LexicalNode, NodeKey, SerializedTextNode } from "lexical";
import { TextNode } from "lexical";
import { MENTION_CLASSES } from "../../../../components/mentionStyles";

export const USER_MENTION_CLASS = MENTION_CLASSES.person;

export type SerializedUserMentionNode = SerializedTextNode & {
  type: "user-mention";
  version: 1;
  userId: string;
  handle: string;
  displayName: string;
};

export class UserMentionNode extends TextNode {
  __userId: string;
  __handle: string;
  __displayName: string;

  static getType(): string {
    return "user-mention";
  }

  static clone(node: UserMentionNode): UserMentionNode {
    return new UserMentionNode(node.__userId, node.__handle, node.__displayName, node.__key);
  }

  static importJSON(serializedNode: SerializedUserMentionNode): UserMentionNode {
    const node = $createUserMentionNode({
      userId: serializedNode.userId,
      handle: serializedNode.handle,
      displayName: serializedNode.displayName,
    });
    node.setFormat(serializedNode.format);
    node.setDetail(serializedNode.detail);
    node.setMode(serializedNode.mode);
    node.setStyle(serializedNode.style);
    return node;
  }

  constructor(userId: string, handle: string, displayName: string, key?: NodeKey) {
    super(`@${handle}`, key);
    this.__userId = userId;
    this.__handle = handle;
    this.__displayName = displayName;
  }

  getUserId(): string {
    return this.__userId;
  }

  getHandle(): string {
    return this.__handle;
  }

  getDisplayName(): string {
    return this.__displayName;
  }

  createDOM(config: EditorConfig): HTMLElement {
    const dom = super.createDOM(config);
    dom.className = USER_MENTION_CLASS;
    return dom;
  }

  updateDOM(_prevNode: this, dom: HTMLElement, config: EditorConfig): boolean {
    dom.className = USER_MENTION_CLASS;
    return super.updateDOM(_prevNode, dom, config);
  }

  exportJSON(): SerializedUserMentionNode {
    return {
      ...super.exportJSON(),
      type: "user-mention",
      version: 1,
      userId: this.__userId,
      handle: this.__handle,
      displayName: this.__displayName,
    };
  }

  isTextEntity(): boolean {
    return true;
  }

  canInsertTextBefore(): boolean {
    return false;
  }

  canInsertTextAfter(): boolean {
    return false;
  }
}

export function $createUserMentionNode(params: {
  userId: string;
  handle: string;
  displayName: string;
}): UserMentionNode {
  return new UserMentionNode(params.userId, params.handle, params.displayName);
}

export function $isUserMentionNode(node: LexicalNode | null | undefined): node is UserMentionNode {
  return node instanceof UserMentionNode;
}
