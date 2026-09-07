import { randomBytes } from "node:crypto";
import http, { type IncomingMessage, type ServerResponse } from "node:http";

import {
  constantTimePersonalBrowserTokenMatch,
  isAllowedPersonalBrowserControlHost,
  readPersonalBrowserBearerToken,
} from "./personalBrowserSecurity";

const MAX_CONTROL_BODY_BYTES = 64 * 1024;
const PERSONAL_BROWSER_MCP_PATH = "/mcp";
const PERSONAL_BROWSER_MCP_PROTOCOL_VERSION = "2025-06-18";

export type PersonalBrowserControlOperation =
  | "status"
  | "snapshot"
  | "navigate"
  | "click"
  | "type"
  | "press"
  | "request_human_input"
  | "scroll";

export type PersonalBrowserControlCredentials = {
  controlUrl: string;
  token: string;
  projectId: string;
};

export class PersonalBrowserControlError extends Error {
  readonly statusCode: number;
  readonly code: string;

  constructor(statusCode: number, code: string, message: string) {
    super(message);
    this.name = "PersonalBrowserControlError";
    this.statusCode = statusCode;
    this.code = code;
  }
}

type ControlBinding = {
  projectId: string;
  token: string;
  generation: number;
};

type PersonalBrowserControlServerOptions = {
  handle: (operation: PersonalBrowserControlOperation, payload: unknown) => Promise<unknown>;
  logger?: (level: "info" | "warn" | "error", message: string, payload?: Record<string, unknown>) => void;
};

function writeJson(response: ServerResponse, statusCode: number, payload: unknown) {
  const body = JSON.stringify(payload);
  response.writeHead(statusCode, {
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "X-Content-Type-Options": "nosniff",
  });
  response.end(body);
}

function writeEmpty(response: ServerResponse, statusCode: number) {
  response.writeHead(statusCode, {
    "Cache-Control": "no-store",
    "Content-Length": "0",
    "X-Content-Type-Options": "nosniff",
  });
  response.end();
}

type McpRequest = {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  params?: unknown;
};

type McpToolDefinition = {
  name: PersonalBrowserControlOperation;
  description: string;
  inputSchema: Record<string, unknown>;
};

const PERSONAL_BROWSER_MCP_TOOLS: McpToolDefinition[] = [
  {
    name: "request_human_input",
    description: "Stop agent control and ask the user to fill one to eight highlighted fields from the latest snapshot. Never supply, request or repeat field values. This ends the current turn; the user explicitly continues in a fresh turn.",
    inputSchema: {
      type: "object", additionalProperties: false, required: ["indices"],
      properties: { indices: { type: "array", minItems: 1, maxItems: 8, uniqueItems: true, items: { type: "integer", minimum: 0, maximum: 499 } } },
    },
  },
  {
    name: "status",
    description: "Read Personal Browser readiness and the approved current page status.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "snapshot",
    description:
      "Read the approved page URL, title, visible text, and fresh indexed interactive elements.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "navigate",
    description: "Navigate the visible Personal Browser page to an absolute HTTP(S) URL.",
    inputSchema: {
      type: "object",
      properties: { url: { type: "string", maxLength: 4096 } },
      required: ["url"],
      additionalProperties: false,
    },
  },
  {
    name: "click",
    description: "Click one indexed target from the latest Personal Browser snapshot.",
    inputSchema: {
      type: "object",
      properties: {
        index: { type: "integer", minimum: 0, maximum: 499 },
      },
      required: ["index"],
      additionalProperties: false,
    },
  },
  {
    name: "type",
    description:
      "Type non-sensitive text into a target from the latest snapshot, optionally submitting it.",
    inputSchema: {
      type: "object",
      properties: {
        index: { type: "integer", minimum: 0, maximum: 499 },
        text: { type: "string", maxLength: 16384 },
        submit: { type: "boolean" },
      },
      required: ["index", "text"],
      additionalProperties: false,
    },
  },
  {
    name: "press",
    description: "Press one allowed key on an indexed target from the latest snapshot.",
    inputSchema: {
      type: "object",
      properties: {
        index: { type: "integer", minimum: 0, maximum: 499 },
        key: { type: "string", maxLength: 32 },
      },
      required: ["index", "key"],
      additionalProperties: false,
    },
  },
  {
    name: "scroll",
    description: "Scroll the visible page by bounded CSS-pixel deltas.",
    inputSchema: {
      type: "object",
      properties: {
        x: { type: "number" },
        y: { type: "number" },
      },
      additionalProperties: false,
    },
  },
];

function mcpError(id: unknown, code: number, message: string, data?: unknown) {
  return {
    jsonrpc: "2.0",
    id: id ?? null,
    error: {
      code,
      message,
      ...(data === undefined ? {} : { data }),
    },
  };
}

function requireMcpRequest(value: unknown): McpRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new PersonalBrowserControlError(400, "invalid_mcp_request", "MCP request must be an object.");
  }
  return value as McpRequest;
}

function requireMcpToolArguments(value: unknown): Record<string, unknown> {
  if (value === undefined) {
    return {};
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new PersonalBrowserControlError(
      400,
      "invalid_mcp_arguments",
      "Personal Browser tool arguments must be an object.",
    );
  }
  return value as Record<string, unknown>;
}

const PERSONAL_BROWSER_MCP_ARGUMENT_KEYS: Record<
  PersonalBrowserControlOperation,
  ReadonlySet<string>
> = {
  status: new Set(),
  snapshot: new Set(),
  navigate: new Set(["url"]),
  click: new Set(["index"]),
  type: new Set(["index", "text", "submit"]),
  press: new Set(["index", "key"]),
  scroll: new Set(["x", "y"]),
  request_human_input: new Set(["indices"]),
};

function rejectUnknownMcpToolArguments(
  operation: PersonalBrowserControlOperation,
  args: Record<string, unknown>,
) {
  const allowed = PERSONAL_BROWSER_MCP_ARGUMENT_KEYS[operation];
  const unknown = Object.keys(args).find((key) => !allowed.has(key));
  if (unknown) {
    throw new PersonalBrowserControlError(
      400,
      "invalid_mcp_arguments",
      `Personal Browser ${operation} does not accept argument ${unknown}.`,
    );
  }
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const contentType = request.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") {
    throw new PersonalBrowserControlError(415, "unsupported_media_type", "Expected application/json.");
  }
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_CONTROL_BODY_BYTES) {
      throw new PersonalBrowserControlError(413, "payload_too_large", "Request body is too large.");
    }
    chunks.push(buffer);
  }
  if (chunks.length === 0) {
    return {};
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new PersonalBrowserControlError(400, "invalid_json", "Request body is not valid JSON.");
  }
}

function resolveOperation(method: string | undefined, pathname: string): PersonalBrowserControlOperation | null {
  if (method === "GET" && pathname === "/v1/status") return "status";
  if (method === "GET" && pathname === "/v1/snapshot") return "snapshot";
  if (method !== "POST") return null;
  if (pathname === "/v1/navigate") return "navigate";
  if (pathname === "/v1/request-human-input") return "request_human_input";
  if (pathname === "/v1/click") return "click";
  if (pathname === "/v1/type") return "type";
  if (pathname === "/v1/press") return "press";
  if (pathname === "/v1/scroll") return "scroll";
  return null;
}

export class PersonalBrowserControlServer {
  private readonly handleOperation: PersonalBrowserControlServerOptions["handle"];
  private readonly logger: NonNullable<PersonalBrowserControlServerOptions["logger"]>;
  private server: http.Server | null = null;
  private port: number | null = null;
  private binding: ControlBinding | null = null;
  private bindingGeneration = 0;

  constructor(options: PersonalBrowserControlServerOptions) {
    this.handleOperation = options.handle;
    this.logger = options.logger ?? (() => undefined);
  }

  async start(): Promise<void> {
    if (this.server && this.port) {
      return;
    }
    const server = http.createServer((request, response) => {
      void this.handleRequest(request, response);
    });
    server.headersTimeout = 10_000;
    server.requestTimeout = 15_000;
    server.keepAliveTimeout = 2_000;
    server.on("clientError", (_error, socket) => {
      socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      throw new Error("Personal Browser control server did not receive a loopback port.");
    }
    this.server = server;
    this.port = address.port;
    this.logger("info", "[instafy-desktop] personal-browser-control-listening", {
      host: "127.0.0.1",
      port: address.port,
    });
  }

  async bindProject(projectId: string): Promise<PersonalBrowserControlCredentials> {
    await this.start();
    if (!this.port) {
      throw new Error("Personal Browser control server is unavailable.");
    }
    this.binding = {
      projectId,
      token: randomBytes(32).toString("base64url"),
      generation: ++this.bindingGeneration,
    };
    return this.getCredentials(projectId)!;
  }

  getCredentials(projectId: string): PersonalBrowserControlCredentials | null {
    if (!this.binding || !this.port || this.binding.projectId !== projectId) {
      return null;
    }
    return {
      controlUrl: `http://127.0.0.1:${this.port}`,
      token: this.binding.token,
      projectId: this.binding.projectId,
    };
  }

  clearBinding() {
    this.bindingGeneration += 1;
    this.binding = null;
  }

  async stop(): Promise<void> {
    this.clearBinding();
    const server = this.server;
    this.server = null;
    this.port = null;
    if (!server) {
      return;
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private authenticate(request: IncomingMessage): ControlBinding {
    const binding = this.binding;
    const port = this.port;
    if (!binding || !port) {
      throw new PersonalBrowserControlError(401, "browser_not_bound", "No Personal Browser is bound.");
    }
    if (request.headers.origin) {
      throw new PersonalBrowserControlError(403, "browser_origin_blocked", "Browser-origin requests are denied.");
    }
    if (!isAllowedPersonalBrowserControlHost(request.headers.host, port)) {
      throw new PersonalBrowserControlError(403, "invalid_host", "Control request Host is invalid.");
    }
    const providedToken = readPersonalBrowserBearerToken(request.headers.authorization);
    if (!constantTimePersonalBrowserTokenMatch(providedToken, binding.token)) {
      throw new PersonalBrowserControlError(401, "invalid_token", "Control token is invalid.");
    }
    const requestedProjectId = request.headers["x-instafy-project-id"];
    if (typeof requestedProjectId !== "string" || requestedProjectId !== binding.projectId) {
      throw new PersonalBrowserControlError(403, "project_mismatch", "Control token is not valid for this project.");
    }
    return binding;
  }

  private async handleRequest(request: IncomingMessage, response: ServerResponse) {
    try {
      const authenticatedBinding = this.authenticate(request);
      const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
      if (requestUrl.search || requestUrl.hash) {
        throw new PersonalBrowserControlError(400, "invalid_route", "Control routes do not accept query parameters.");
      }
      if (requestUrl.pathname === PERSONAL_BROWSER_MCP_PATH) {
        if (request.method !== "POST") {
          throw new PersonalBrowserControlError(
            405,
            "method_not_allowed",
            "Personal Browser MCP accepts POST requests only.",
          );
        }
        const payload = requireMcpRequest(await readJsonBody(request));
        if (!this.bindingIsCurrent(authenticatedBinding)) {
          throw new PersonalBrowserControlError(401, "stale_token", "Control token has been rotated.");
        }
        const mcpResponse = await this.handleMcpRequest(authenticatedBinding, payload);
        if (mcpResponse === null) {
          writeEmpty(response, 202);
        } else {
          writeJson(response, 200, mcpResponse);
        }
        return;
      }
      const operation = resolveOperation(request.method, requestUrl.pathname);
      if (!operation) {
        throw new PersonalBrowserControlError(404, "route_not_found", "Control route does not exist.");
      }
      const payload = request.method === "POST" ? await readJsonBody(request) : {};
      if (!this.bindingIsCurrent(authenticatedBinding)) {
        throw new PersonalBrowserControlError(401, "stale_token", "Control token has been rotated.");
      }
      const result = await this.dispatchAuthenticated(authenticatedBinding, operation, payload);
      // This terminal operation deliberately revokes its own binding. Its
      // response contains a fixed acknowledgment, never stale page contents.
      if (!this.bindingIsCurrent(authenticatedBinding) && !(operation === "request_human_input" && (result as { humanInputRequired?: boolean })?.humanInputRequired === true)) {
        throw new PersonalBrowserControlError(401, "stale_token", "Control token has been rotated.");
      }
      writeJson(response, 200, { ok: true, ...((result ?? {}) as object) });
    } catch (error) {
      const known = error instanceof PersonalBrowserControlError;
      const statusCode = known ? error.statusCode : 500;
      const code = known ? error.code : "internal_error";
      const message = known ? error.message : "Personal Browser control failed.";
      if (!known) {
        this.logger("error", "[instafy-desktop] personal-browser-control-failed", {
          message: error instanceof Error ? error.message : String(error),
        });
      }
      writeJson(response, statusCode, { ok: false, error: { code, message } });
    }
  }

  private async handleMcpRequest(
    authenticated: ControlBinding,
    request: McpRequest,
  ): Promise<Record<string, unknown> | null> {
    const id = request.id;
    const method = typeof request.method === "string" ? request.method : "";
    if (request.jsonrpc !== "2.0" || !method) {
      return mcpError(id, -32600, "Invalid JSON-RPC request.");
    }

    if (method.startsWith("notifications/")) {
      return null;
    }

    if (method === "initialize") {
      return {
        jsonrpc: "2.0",
        id: id ?? null,
        result: {
          protocolVersion: PERSONAL_BROWSER_MCP_PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "instafy-personal-browser", version: "1.0.0" },
          instructions:
            "Use snapshot before indexed actions. The user must resume control and approve each origin; sensitive typing is blocked.",
        },
      };
    }

    if (method === "ping") {
      return { jsonrpc: "2.0", id: id ?? null, result: {} };
    }

    if (method === "tools/list") {
      return {
        jsonrpc: "2.0",
        id: id ?? null,
        result: { tools: PERSONAL_BROWSER_MCP_TOOLS },
      };
    }

    if (method !== "tools/call") {
      return mcpError(id, -32601, "MCP method not found.");
    }

    const params =
      request.params && typeof request.params === "object" && !Array.isArray(request.params)
        ? (request.params as Record<string, unknown>)
        : null;
    const toolName = typeof params?.name === "string" ? params.name.trim() : "";
    const tool = PERSONAL_BROWSER_MCP_TOOLS.find((candidate) => candidate.name === toolName);
    if (!tool) {
      return mcpError(id, -32602, "Unknown Personal Browser tool.");
    }

    let args: Record<string, unknown>;
    try {
      args = requireMcpToolArguments(params?.arguments);
      rejectUnknownMcpToolArguments(tool.name, args);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Invalid tool arguments.";
      return mcpError(id, -32602, message);
    }

    try {
      const result = await this.dispatchAuthenticated(authenticated, tool.name, args);
      if (!this.bindingIsCurrent(authenticated) && !(tool.name === "request_human_input" && (result as { humanInputRequired?: boolean })?.humanInputRequired === true)) {
        throw new PersonalBrowserControlError(401, "stale_token", "Control token has been rotated.");
      }
      const structured = (result ?? {}) as Record<string, unknown>;
      return {
        jsonrpc: "2.0",
        id: id ?? null,
        result: {
          content: [{ type: "text", text: JSON.stringify(structured) }],
          structuredContent: structured,
          isError: false,
        },
      };
    } catch (error) {
      const known = error instanceof PersonalBrowserControlError;
      const code = known ? error.code : "personal_browser_failed";
      const message = known ? error.message : "Personal Browser tool failed.";
      if (!known) {
        this.logger("error", "[instafy-desktop] personal-browser-mcp-tool-failed", {
          tool: tool.name,
          message: error instanceof Error ? error.message : String(error),
        });
      }
      return mcpError(id, -32000, message, { code });
    }
  }

  private bindingIsCurrent(authenticated: ControlBinding): boolean {
    const current = this.binding;
    return Boolean(
      current &&
        current.generation === authenticated.generation &&
        current.projectId === authenticated.projectId &&
        constantTimePersonalBrowserTokenMatch(authenticated.token, current.token),
    );
  }

  private async dispatchAuthenticated(
    authenticated: ControlBinding,
    operation: PersonalBrowserControlOperation,
    payload: unknown,
  ): Promise<unknown> {
    // Keep generation validation immediately adjacent to dispatch. Authentication
    // and request-body parsing can both yield while Pause/project switch rotates it.
    if (!this.bindingIsCurrent(authenticated)) {
      throw new PersonalBrowserControlError(401, "stale_token", "Control token has been rotated.");
    }
    return this.handleOperation(operation, payload);
  }
}
