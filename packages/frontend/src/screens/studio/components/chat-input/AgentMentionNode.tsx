import type { EditorConfig, LexicalNode, NodeKey, SerializedTextNode } from "lexical";
import { TextNode } from "lexical";

export const AGENT_MENTION_CLASS =
  "inline-flex items-center rounded-full px-2 py-0.5 font-semibold leading-none ring-1 align-baseline bg-secondary-50 text-secondary-700 ring-secondary-200 dark:bg-secondary-500/15 dark:text-secondary-200 dark:ring-secondary-500/30";

export type SerializedAgentMentionNode = SerializedTextNode & {
  type: "agent-mention";
  version: 1;
  handle: string;
  displayName: string;
};

export class AgentMentionNode extends TextNode {
  __handle: string;
  __displayName: string;

  static getType(): string {
    return "agent-mention";
  }

  static clone(node: AgentMentionNode): AgentMentionNode {
    return new AgentMentionNode(node.__handle, node.__displayName, node.__key);
  }

  static importJSON(serializedNode: SerializedAgentMentionNode): AgentMentionNode {
    const node = $createAgentMentionNode({
      handle: serializedNode.handle,
      displayName: serializedNode.displayName,
    });
    node.setFormat(serializedNode.format);
    node.setDetail(serializedNode.detail);
    node.setMode(serializedNode.mode);
    node.setStyle(serializedNode.style);
    return node;
  }

  constructor(handle: string, displayName: string, key?: NodeKey) {
    super(`@${handle}`, key);
    this.__handle = handle;
    this.__displayName = displayName;
  }

  getHandle(): string {
    return this.__handle;
  }

  getDisplayName(): string {
    return this.__displayName;
  }

  createDOM(config: EditorConfig): HTMLElement {
    const dom = super.createDOM(config);
    dom.className = AGENT_MENTION_CLASS;
    return dom;
  }

  updateDOM(prevNode: this, dom: HTMLElement, config: EditorConfig): boolean {
    dom.className = AGENT_MENTION_CLASS;
    return super.updateDOM(prevNode, dom, config);
  }

  exportJSON(): SerializedAgentMentionNode {
    return {
      ...super.exportJSON(),
      type: "agent-mention",
      version: 1,
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

export function $createAgentMentionNode(params: { handle: string; displayName: string }): AgentMentionNode {
  return new AgentMentionNode(params.handle, params.displayName);
}

export function $isAgentMentionNode(node: LexicalNode | null | undefined): node is AgentMentionNode {
  return node instanceof AgentMentionNode;
}
