import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import {
  LexicalTypeaheadMenuPlugin,
  MenuOption,
  type MenuTextMatch,
} from "@lexical/react/LexicalTypeaheadMenuPlugin";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { $createTextNode, $insertNodes, $isTextNode, type TextNode } from "lexical";
import { filterChatSlashCommands, type ChatSlashCommandOption } from "../../../../conversations/slashCommands";
import { ComposerSuggestionMenu, ComposerSuggestionOption } from "./ComposerSuggestions";

const SLASH_MENU_MAX_HEIGHT_PX = 280;
const SLASH_MENU_MAX_WIDTH_PX = 360;
const SLASH_MENU_MIN_HEIGHT_PX = 120;
const SLASH_MENU_VIEWPORT_PADDING_PX = 8;
const SLASH_MENU_ANCHOR_GAP_PX = 6;
const SLASH_COMMAND_TRIGGER_REGEX = /(^|\n)\s*(\/[a-z]*(?:[ :][a-z]*)?)$/i;

type SlashMenuLayout = {
  placeAbove: boolean;
  maxHeight: number;
};

class SlashCommandOption extends MenuOption {
  command: string;
  description: string;

  constructor({ command, description }: ChatSlashCommandOption) {
    super(command);
    this.command = command;
    this.description = description;
  }
}

type SlashCommandsMenuProps = {
  anchorElement: HTMLElement;
  options: SlashCommandOption[];
  selectedIndex: number | null;
  selectOptionAndCleanUp: (option: SlashCommandOption) => void;
  setHighlightedIndex: (index: number) => void;
};

function resolveSlashMenuLayout(anchorElement: HTMLElement): SlashMenuLayout {
  const rect = anchorElement.getBoundingClientRect();
  const viewportHeight = window.innerHeight;
  const spaceBelow = viewportHeight - rect.bottom - SLASH_MENU_VIEWPORT_PADDING_PX - SLASH_MENU_ANCHOR_GAP_PX;
  const spaceAbove = rect.top - SLASH_MENU_VIEWPORT_PADDING_PX - SLASH_MENU_ANCHOR_GAP_PX;
  const placeAbove = spaceBelow < 180 && spaceAbove > spaceBelow;
  const availableHeight = Math.max(
    SLASH_MENU_MIN_HEIGHT_PX,
    placeAbove ? spaceAbove : spaceBelow,
  );
  const maxHeight = Math.min(SLASH_MENU_MAX_HEIGHT_PX, availableHeight);
  return { placeAbove, maxHeight };
}

function matchSlashCommand(text: string): MenuTextMatch | null {
  const match = SLASH_COMMAND_TRIGGER_REGEX.exec(text);
  if (!match || match.index === undefined) {
    return null;
  }
  const replaceableString = match[2] ?? "";
  const leadOffset = text.length - replaceableString.length;
  const matchingString = replaceableString.slice(1);
  return {
    leadOffset,
    matchingString,
    replaceableString,
  };
}

function SlashCommandsMenu({
  anchorElement,
  options,
  selectedIndex,
  selectOptionAndCleanUp,
  setHighlightedIndex,
}: SlashCommandsMenuProps) {
  const optionSignature = useMemo(() => options.map((option) => option.key).join("|"), [options]);

  useEffect(() => {
    if (options.length === 0) {
      return;
    }
    setHighlightedIndex(0);
  }, [optionSignature, options.length, setHighlightedIndex]);

  const anchorRect = anchorElement.getBoundingClientRect();
  const inputRect =
    typeof document !== "undefined"
      ? document.getElementById("studio-chat-input")?.getBoundingClientRect()
      : null;
  const anchorTop = inputRect ? Math.min(anchorRect.top, inputRect.top) : anchorRect.top;
  const anchorBottom = inputRect ? Math.max(anchorRect.bottom, inputRect.bottom) : anchorRect.bottom;
  const menuLayout = resolveSlashMenuLayout(anchorElement);
  const maxWidth = Math.max(
    240,
    Math.min(SLASH_MENU_MAX_WIDTH_PX, window.innerWidth - SLASH_MENU_VIEWPORT_PADDING_PX * 2),
  );
  const clampedLeft = Math.max(
    SLASH_MENU_VIEWPORT_PADDING_PX,
    Math.min(anchorRect.left, window.innerWidth - maxWidth - SLASH_MENU_VIEWPORT_PADDING_PX),
  );
  const menuStyle: CSSProperties = {
    maxHeight: menuLayout.maxHeight,
    width: maxWidth,
    left: clampedLeft,
    top: menuLayout.placeAbove
      ? Math.max(SLASH_MENU_VIEWPORT_PADDING_PX, anchorTop - SLASH_MENU_ANCHOR_GAP_PX)
      : Math.min(window.innerHeight - SLASH_MENU_VIEWPORT_PADDING_PX, anchorBottom + SLASH_MENU_ANCHOR_GAP_PX),
    transform: menuLayout.placeAbove ? "translateY(-100%)" : undefined,
  };

  return createPortal(
    <ComposerSuggestionMenu
      style={menuStyle}
      data-testid="chat-slash-command-menu"
    >
      {options.map((option, index) => (
        <ComposerSuggestionOption
          key={option.key}
          ref={option.setRefElement}
          data-command={option.command}
          isHighlighted={selectedIndex === index}
          label={option.command}
          description={option.description}
          data-testid="chat-slash-command-option"
          onClick={() => selectOptionAndCleanUp(option)}
          onMouseEnter={() => setHighlightedIndex(index)}
        />
      ))}
    </ComposerSuggestionMenu>,
    anchorElement,
  );
}

export function SlashCommandsPlugin() {
  const [editor] = useLexicalComposerContext();
  const [query, setQuery] = useState<string | null>(null);
  const suppressedSuffixRef = useRef<string | null>(null);

  const triggerMatch = useCallback((text: string) => {
    const suppressedSuffix = suppressedSuffixRef.current;
    if (suppressedSuffix) {
      if (text.endsWith(suppressedSuffix)) {
        return null;
      }
      suppressedSuffixRef.current = null;
    }
    return matchSlashCommand(text);
  }, []);

  const options = useMemo(
    () => filterChatSlashCommands(query).map((option) => new SlashCommandOption(option)),
    [query],
  );

  const onSelectOption = useCallback(
    (option: SlashCommandOption, textNodeContainingQuery: TextNode | null, closeMenu: () => void) => {
      const insertedText = `${option.command} `;
      suppressedSuffixRef.current = insertedText;
      setQuery(null);
      editor.update(() => {
        const insertedNode = $createTextNode(insertedText);
        if (textNodeContainingQuery) {
          textNodeContainingQuery.replace(insertedNode);
        } else {
          $insertNodes([insertedNode]);
        }
        const nextSibling = insertedNode.getNextSibling();
        if ($isTextNode(nextSibling)) {
          nextSibling.selectStart();
        } else {
          insertedNode.selectEnd();
        }
      });
      closeMenu();
    },
    [editor],
  );

  return (
    <LexicalTypeaheadMenuPlugin
      onQueryChange={setQuery}
      onSelectOption={onSelectOption}
      triggerFn={triggerMatch}
      options={options}
      ignoreEntityBoundary
      menuRenderFn={(anchorElementRef, { selectedIndex, selectOptionAndCleanUp, setHighlightedIndex, options }) => {
        if (!anchorElementRef.current || options.length === 0) {
          return null;
        }
        return (
          <SlashCommandsMenu
            anchorElement={anchorElementRef.current}
            options={options}
            selectedIndex={selectedIndex}
            selectOptionAndCleanUp={selectOptionAndCleanUp}
            setHighlightedIndex={setHighlightedIndex}
          />
        );
      }}
    />
  );
}
