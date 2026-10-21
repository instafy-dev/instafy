// A mock Instafy controller for the agent executor tests. It behaves like packages/runtime-controller where the
// binder depends on it:
//   POST /projects/:space/conversations/blank -> {conversationId, initialParticipantUserIds} (the site's thread)
//        enforcing the real rules (conversations.rs resolve_thread_columns): threadKind without
//        parentConversationId -> 400; an unknown parent -> 404; a parent in another space -> 403
//   POST /conversations/:id/messages          -> {conversationId, runId, jobId, promptId, status: "queued"}
//                                                 ({status: "recorded"} with no runId when recordOnly is set)
//   GET  /conversations/:id/runs?limit=        -> [{id, status}], status queued -> in_progress -> success
//   GET  /conversations/:id/messages?limit=    -> {messages}, NEWEST FIRST, each with createdAt, at most `limit`
//   POST /jobs/:jobId/cancel                   -> the run becomes canceled
// While a run works it posts a status message, a tool call and a prose assistant message without messageType,
// like runtime-agent does mid-run. Each dispatch takes the next scripted reply: a string (the final assistant
// message) or null (never replies).
// Conversations exist only when seeded (`seed`, by default the owner's conv_owner in space_1) or created through
// /blank; messages and runs of any other conversation answer 404, as the real controller does.
// replyAfterRunSeen: the reply is posted only after GET /runs has returned the run as in_progress, so a test can
// rely on the binder observing that status however slowly the machine runs (timers alone race under load).
import http from "node:http";

export const TOKEN = "test-controller-token";

export async function startMockController({
  replies = [], runningAfterMs = 20, replyAfterMs = 60, statusMessage = "Opening the page", midRunProse = "Let me open the page and look.",
  recordOnly = false, tokens = [TOKEN], seed = { conv_owner: "space_1" }, replyAfterRunSeen = false,
} = {}) {
  const conversations = new Map();
  const requests = [];
  const cancelled = [];
  let counter = 0;
  let threads = 0;
  let clock = Date.parse("2026-10-01T10:00:00Z");
  const queue = [...replies];
  const stamp = () => new Date((clock += 1000)).toISOString();

  const conversation = (id) => {
    if (!conversations.has(id)) {
      conversations.set(id, {
        messages: [{ id: "old_1", role: "assistant", content: '{"schema":"uw.records@1","records":[]}', runId: "run_old", createdAt: stamp(), metadata: {} }],
        runs: [],
      });
    }
    return conversations.get(id);
  };
  for (const [id, space] of Object.entries(seed)) conversation(id).meta = { space, parentConversationId: null, threadKind: null };
  const known = (id) => conversations.has(id);
  const push = (conv, message) => conv.messages.push({ metadata: {}, createdAt: stamp(), ...message });

  function startRun(conv, body) {
    counter += 1;
    const runId = `run_${counter}`;
    const jobId = `job_${counter}`;
    const run = { id: runId, jobId, status: "queued" };
    conv.runs.push(run);
    push(conv, { id: `msg_user_${counter}`, role: "user", content: body.promptText, runId });
    const reply = queue.length ? queue.shift() : null;
    const n = counter;
    setTimeout(() => {
      if (run.status !== "queued") return;
      run.status = "in_progress";
      push(conv, { id: `msg_status_${n}`, role: "assistant", content: statusMessage, runId, metadata: { messageType: "status" } });
      push(conv, { id: `msg_tool_${n}`, role: "assistant", content: "browser.open(...)", runId, metadata: { messageType: "mcp_tool_call" } });
      if (midRunProse) push(conv, { id: `msg_mid_${n}`, role: "assistant", content: midRunProse, runId });
    }, runningAfterMs);
    if (reply !== null) {
      const finish = () =>
        setTimeout(() => {
          if (run.status === "canceled") return;
          push(conv, { id: `msg_reply_${n}`, role: "assistant", content: reply, runId });
          run.status = "success";
        }, replyAfterMs);
      if (replyAfterRunSeen) run.onSeenRunning = finish;
      else finish();
    }
    return run;
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://mock");
    let body = "";
    for await (const chunk of req) body += chunk;
    const parsed = body ? JSON.parse(body) : null;
    requests.push({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), body: parsed, auth: req.headers.authorization });
    const send = (status, value) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(value));
    };
    if (!tokens.some((token) => req.headers.authorization === `Bearer ${token}`)) return send(401, { error: "unauthorized" });
    let m;
    if (req.method === "POST" && (m = url.pathname.match(/^\/projects\/([^/]+)\/conversations\/blank$/))) {
      const space = decodeURIComponent(m[1]);
      const parent = typeof parsed?.parentConversationId === "string" && parsed.parentConversationId.trim() ? parsed.parentConversationId.trim() : null;
      const threadKind = typeof parsed?.threadKind === "string" && parsed.threadKind.trim() ? parsed.threadKind.trim().toLowerCase() : null;
      if (!parent && threadKind) return send(400, { error: "threadKind requires parentConversationId" });
      if (parent && !known(parent)) return send(404, { error: "conversation not found" });
      if (parent && conversations.get(parent).meta?.space !== space) return send(403, { error: "parent conversation does not belong to this project" });
      threads += 1;
      const id = `conv_thread_${threads}`;
      conversation(id).messages = [];
      conversations.get(id).meta = { ...parsed, space, parentConversationId: parent, threadKind: parent ? threadKind : null };
      return send(200, { conversationId: id, initialParticipantUserIds: [] });
    }
    if ((m = url.pathname.match(/^\/conversations\/([^/]+)\/(?:messages|runs)$/)) && !known(m[1])) {
      return send(404, { error: "conversation not found" });
    }
    if (req.method === "POST" && (m = url.pathname.match(/^\/conversations\/([^/]+)\/messages$/))) {
      const conv = conversation(m[1]);
      if (recordOnly) {
        push(conv, { id: `msg_user_rec_${requests.length}`, role: "user", content: parsed.promptText });
        return send(200, { conversationId: m[1], jobId: null, status: "recorded" });
      }
      const run = startRun(conv, parsed);
      return send(200, { conversationId: m[1], runId: run.id, jobId: run.jobId, promptId: `p_${run.id}`, status: "queued" });
    }
    if (req.method === "POST" && (m = url.pathname.match(/^\/jobs\/([^/]+)\/cancel$/))) {
      for (const conv of conversations.values()) {
        for (const run of conv.runs) if (run.jobId === m[1] && ["queued", "in_progress"].includes(run.status)) run.status = "canceled";
      }
      cancelled.push(m[1]);
      return send(200, { canceledJobIds: [m[1]] });
    }
    if (req.method === "GET" && (m = url.pathname.match(/^\/conversations\/([^/]+)\/runs$/))) {
      const runs = [...conversation(m[1]).runs].reverse().slice(0, Number(url.searchParams.get("limit") || 100));
      const body = runs.map(({ id, jobId, status }) => ({ id, jobId, status }));
      for (const run of runs) {
        if (run.status === "in_progress" && run.onSeenRunning) {
          const finish = run.onSeenRunning;
          delete run.onSeenRunning;
          finish();
        }
      }
      return send(200, body);
    }
    if (req.method === "GET" && (m = url.pathname.match(/^\/conversations\/([^/]+)\/messages$/))) {
      const limit = Number(url.searchParams.get("limit") || 50);
      const newest = [...conversation(m[1]).messages].reverse().slice(0, limit);
      return send(200, { messages: newest, nextCursor: null, hasMore: false });
    }
    return send(404, { error: "not found" });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    requests,
    cancelled,
    conversations,
    tokens,
    runs: () => [...conversations.values()].flatMap((c) => c.runs),
    close: () => new Promise((resolve) => {
      server.closeAllConnections?.();
      server.close(resolve);
    }),
  };
}
