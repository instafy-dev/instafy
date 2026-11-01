//! An MCP client for tests that speaks to a server the way Codex does: JSON-RPC lines over a
//! pipe, starting with `initialize` at protocol 2025-06-18, the version Codex asks a stdio server
//! for. Tests compare whole messages, so they see exactly what Codex would read.

use std::time::Duration;

use rmcp::ErrorData as McpError;
use rmcp::ServiceExt;
use rmcp::handler::server::ServerHandler;
use rmcp::model::{CallToolRequestParams, CallToolResponse, CallToolResult};
use rmcp::service::{RequestContext, RoleServer};
use serde_json::{Value as JsonValue, json};
use tokio::io::{
    AsyncBufReadExt, AsyncWriteExt, BufReader, DuplexStream, Lines, ReadHalf, WriteHalf,
};

pub(crate) struct McpWire {
    writer: WriteHalf<DuplexStream>,
    lines: Lines<BufReader<ReadHalf<DuplexStream>>>,
    next_id: u64,
    /// The server's whole answer to `initialize`.
    pub(crate) initialized: JsonValue,
}

impl McpWire {
    /// Serves `server` on an in-memory pipe and initializes it.
    pub(crate) async fn connect<S: ServerHandler>(server: S) -> Self {
        let (client, served) = tokio::io::duplex(1 << 20);
        tokio::spawn(async move {
            let running = server
                .serve(tokio::io::split(served))
                .await
                .expect("serve the MCP server");
            let _ = running.waiting().await;
        });
        let (reader, writer) = tokio::io::split(client);
        let mut wire = Self {
            writer,
            lines: BufReader::new(reader).lines(),
            next_id: 1,
            initialized: JsonValue::Null,
        };
        wire.initialized = wire
            .request(
                "initialize",
                json!({
                    "protocolVersion": "2025-06-18",
                    "capabilities": {},
                    "clientInfo": { "name": "mcp-test-wire", "version": "1" },
                }),
            )
            .await;
        wire.send(json!({ "jsonrpc": "2.0", "method": "notifications/initialized" }))
            .await;
        wire
    }

    async fn send(&mut self, message: JsonValue) {
        let mut line = message.to_string();
        line.push('\n');
        self.writer
            .write_all(line.as_bytes())
            .await
            .expect("write to the MCP server");
        self.writer.flush().await.expect("flush");
    }

    /// Sends one request and answers with the server's whole response to it.
    pub(crate) async fn request(&mut self, method: &str, params: JsonValue) -> JsonValue {
        let id = self.next_id;
        self.next_id += 1;
        self.send(json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params }))
            .await;
        loop {
            let line = tokio::time::timeout(Duration::from_secs(20), self.lines.next_line())
                .await
                .expect("the MCP server answers")
                .expect("read the MCP server")
                .expect("the MCP server is still serving");
            let message: JsonValue = serde_json::from_str(&line).expect("one JSON-RPC message");
            if message["id"] == json!(id) {
                return message;
            }
        }
    }

    pub(crate) async fn call(&mut self, name: &str, arguments: JsonValue) -> JsonValue {
        self.request(
            "tools/call",
            json!({ "name": name, "arguments": arguments }),
        )
        .await
    }
}

/// A server that answers every call with one result.
struct Answer(CallToolResult);

impl ServerHandler for Answer {
    async fn call_tool(
        &self,
        _request: CallToolRequestParams,
        _context: RequestContext<RoleServer>,
    ) -> Result<CallToolResponse, McpError> {
        Ok(self.0.clone().into())
    }
}

/// `result` as Codex reads it: the `result` of a `tools/call` a server answered with it.
pub(crate) async fn wire_result(result: CallToolResult) -> JsonValue {
    let mut wire = McpWire::connect(Answer(result)).await;
    wire.call("any", json!({})).await["result"].take()
}
