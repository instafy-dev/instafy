type BrowserUseClipboardEntry = {
  mime_type: string;
  text?: string;
  base64?: string;
};

type BrowserUseClipboardItem = {
  entries: BrowserUseClipboardEntry[];
  presentation_style?: string;
};

type BrowserUseClipboardState = {
  installed: boolean;
  items: BrowserUseClipboardItem[];
};

type ClipboardItemLike = {
  readonly types: readonly string[];
  readonly presentationStyle?: string;
  getType(type: string): Promise<Blob>;
};

type BrowserUseFakeClipboard = {
  readonly __browserUseFakeClipboard: true;
  read(): Promise<ClipboardItemLike[]>;
  readText(): Promise<string>;
  write(items: Iterable<ClipboardItemLike>): Promise<void>;
  writeText(text: string): Promise<void>;
  addEventListener(): void;
  dispatchEvent(): boolean;
  removeEventListener(): void;
};

type BrowserUseWindow = Window & {
  __browserUseFakeClipboard?: BrowserUseClipboardState;
  __browserUseFakeClipboardCleanup?: () => void;
};

function encodeBase64(bytes: ArrayBuffer): string {
  const view = new Uint8Array(bytes);
  const chunkSize = 32_768;
  let binary = "";
  for (let index = 0; index < view.length; index += chunkSize) {
    binary += String.fromCharCode(...view.subarray(index, index + chunkSize));
  }
  return btoa(binary);
}

function decodeBase64(value: string): ArrayBuffer {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes.buffer;
}

function entryToBlob(entry: BrowserUseClipboardEntry): Blob {
  if (typeof entry.text === "string") {
    return new Blob([entry.text], { type: entry.mime_type });
  }
  return new Blob([decodeBase64(entry.base64 ?? "")], { type: entry.mime_type });
}

function storedItemToClipboardItem(item: BrowserUseClipboardItem): ClipboardItemLike {
  return {
    types: item.entries.map((entry) => entry.mime_type),
    presentationStyle: item.presentation_style ?? "unspecified",
    async getType(mimeType: string) {
      const entry = item.entries.find((candidate) => candidate.mime_type === mimeType);
      if (!entry) {
        throw new DOMException(`No fake clipboard entry for ${mimeType}`, "NotFoundError");
      }
      return entryToBlob(entry);
    },
  };
}

async function clipboardItemsToStoredItems(items: Iterable<ClipboardItemLike>): Promise<BrowserUseClipboardItem[]> {
  const storedItems: BrowserUseClipboardItem[] = [];
  for (const item of Array.from(items)) {
    const entries: BrowserUseClipboardEntry[] = [];
    for (const mimeType of item.types) {
      const blob = await item.getType(mimeType);
      if (mimeType.startsWith("text/")) {
        entries.push({ mime_type: mimeType, text: await blob.text() });
      } else {
        entries.push({ mime_type: mimeType, base64: encodeBase64(await blob.arrayBuffer()) });
      }
    }
    storedItems.push({
      entries,
      presentation_style: item.presentationStyle ?? "unspecified",
    });
  }
  return storedItems;
}

export function installBrowserUseVirtualClipboardForAutomation(): boolean {
  if (typeof window === "undefined" || typeof navigator === "undefined") {
    return false;
  }

  const browserWindow = window as BrowserUseWindow;
  const existingClipboard = navigator.clipboard as (Navigator["clipboard"] & { __browserUseFakeClipboard?: true }) | undefined;
  if (browserWindow.__browserUseFakeClipboard?.installed === true && existingClipboard?.__browserUseFakeClipboard === true) {
    return true;
  }

  const hadOwnClipboard = Object.prototype.hasOwnProperty.call(navigator, "clipboard");
  const originalDescriptor = Object.getOwnPropertyDescriptor(navigator, "clipboard");
  const state = browserWindow.__browserUseFakeClipboard ?? { installed: false, items: [] };
  const readText = () => {
    return state.items.flatMap((item) => item.entries).find((entry) => entry.mime_type === "text/plain")?.text ?? "";
  };
  const fakeClipboard: BrowserUseFakeClipboard = {
    __browserUseFakeClipboard: true,
    async read() {
      return state.items.map(storedItemToClipboardItem);
    },
    async readText() {
      return readText();
    },
    async write(items) {
      state.items = await clipboardItemsToStoredItems(items);
    },
    async writeText(text) {
      state.items = [
        {
          entries: [{ mime_type: "text/plain", text }],
          presentation_style: "unspecified",
        },
      ];
    },
    addEventListener() {},
    dispatchEvent() {
      return true;
    },
    removeEventListener() {},
  };
  const getFakeClipboard = () => fakeClipboard;

  try {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      get: getFakeClipboard,
    });
  } catch (_error) {
    return false;
  }

  state.installed = true;
  browserWindow.__browserUseFakeClipboard = state;
  browserWindow.__browserUseFakeClipboardCleanup = () => {
    if (Object.getOwnPropertyDescriptor(navigator, "clipboard")?.get !== getFakeClipboard) {
      return;
    }
    if (hadOwnClipboard && originalDescriptor) {
      Object.defineProperty(navigator, "clipboard", originalDescriptor);
    } else {
      Reflect.deleteProperty(navigator, "clipboard");
    }
    state.items = [];
    state.installed = false;
    delete browserWindow.__browserUseFakeClipboard;
    delete browserWindow.__browserUseFakeClipboardCleanup;
  };
  return true;
}
