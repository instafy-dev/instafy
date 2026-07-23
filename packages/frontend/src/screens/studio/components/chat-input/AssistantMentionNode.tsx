import type { EditorConfig, LexicalNode, NodeKey, SerializedTextNode } from "lexical";
import { TextNode } from "lexical";
import type { AssistantMentionToken } from "../../../../conversations/assistantMentions";
import { getAssistantMentionClass, resolveAssistantMentionToken } from "../assistantMentionUI";

export type SerializedAssistantMentionNode = SerializedTextNode & {
  type: "assistant-mention";
  version: 1;
};

export class AssistantMentionNode extends TextNode {
  static getType(): string {
    return "assistant-mention";
  }

  static clone(node: AssistantMentionNode): AssistantMentionNode {
    return new AssistantMentionNode(node.__text, node.__key);
  }

  static importJSON(serializedNode: SerializedAssistantMentionNode): AssistantMentionNode {
    const node = $createAssistantMentionNode(serializedNode.text as AssistantMentionToken);
    node.setFormat(serializedNode.format);
    node.setDetail(serializedNode.detail);
    node.setMode(serializedNode.mode);
    node.setStyle(serializedNode.style);
    return node;
  }

  constructor(text: string, key?: NodeKey) {
    super(text, key);
  }

  createDOM(config: EditorConfig): HTMLElement {
    const dom = super.createDOM(config);
    const token = resolveAssistantMentionToken(this.getTextContent());
    dom.className = getAssistantMentionClass(token);
    return dom;
  }

  updateDOM(prevNode: this, dom: HTMLElement, config: EditorConfig): boolean {
    const prevToken = resolveAssistantMentionToken(prevNode.getTextContent());
    const nextToken = resolveAssistantMentionToken(this.getTextContent());
    if (prevToken !== nextToken) {
      dom.className = getAssistantMentionClass(nextToken);
    }
    return super.updateDOM(prevNode, dom, config);
  }

  exportJSON(): SerializedAssistantMentionNode {
    return {
      ...super.exportJSON(),
      type: "assistant-mention",
      version: 1
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

export function $createAssistantMentionNode(token: AssistantMentionToken): AssistantMentionNode {
  return new AssistantMentionNode(token);
}

export function $isAssistantMentionNode(
  node: LexicalNode | null | undefined
): node is AssistantMentionNode {
  return node instanceof AssistantMentionNode;
}
