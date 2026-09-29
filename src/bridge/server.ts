import { randomUUID } from "node:crypto";
import { WebSocketServer, type WebSocket } from "ws";
import {
  type AgentActivity,
  type BridgeRequest,
  type BridgeResponse,
  type CapabilityDescriptor,
  type HelloMessage,
  isRequest,
} from "../protocol.js";

const port = Number(process.env.BRIDGE_PORT ?? 8765);
const browserMcpPort = Number(process.env.BRIDGE_BROWSERMCP_PORT ?? 9009);
const browserMcpMode = process.env.BRIDGE_EXTENSION_PROTOCOL === "browsermcp";
const token = process.env.BRIDGE_TOKEN;
const localModelAdvisorEnabled = process.env.BRIDGE_AI_SCHEDULER !== "0";
const advisorTimeoutMs = 800;
const advisorMinQueue = readLimit("BRIDGE_AI_SCHEDULER_MIN_QUEUE", 4);
const limits = {
  agentConnections: readLimit("BRIDGE_MAX_AGENTS", 64),
  globalQueued: readLimit("BRIDGE_MAX_QUEUED", 2000),
  perTabQueued: readLimit("BRIDGE_MAX_QUEUED_PER_TAB", 250),
  perAgentPerTab: readLimit("BRIDGE_MAX_QUEUED_PER_AGENT_PER_TAB", 25),
  activeRequests: readLimit("BRIDGE_MAX_ACTIVE_REQUESTS", 256),
  slowAgentBufferedBytes: readLimit("BRIDGE_MAX_AGENT_BUFFERED_BYTES", 1_048_576),
  queueWaitMs: readLimit("BRIDGE_MAX_QUEUE_WAIT_MS", 300000),
};
const extensionClients = new Set<WebSocket>();
const browserMcpClients = new Set<WebSocket>();
const agentClients = new Set<WebSocket>();
const pending = new Map<string, Pending>();
const queues = new Map<string, Queue>();
const activities = new Map<string, AgentActivity>();
const missedEvents = new Map<WebSocket, number>();
const activityHistory: AgentActivity[] = [];
const maxActivityHistory = 200;

type Pending = {
  socket: WebSocket;
  timer: NodeJS.Timeout;
  queueKey?: string;
  cancelled?: boolean;
  agentId: string;
  plannerQueueKey?: string;
  protocol?: "bridge" | "browsermcp";
  wrapSnapshot?: boolean;
};
type Job = { request: BridgeRequest; socket: WebSocket; queueKey: string; enqueuedAt: number; queueTimer?: NodeJS.Timeout };
type Queue = {
  active: boolean;
  activeRequestId?: string;
  jobs: Job[];
  lastAgentId?: string;
  consecutiveJobs: number;
  drainTimer?: NodeJS.Timeout;
  advisorState: "disabled" | "idle" | "planning" | "ready" | "fallback";
  advisorOrder?: string[];
  advisorLastStartedAt?: number;
};
let plannerInFlight = 0;

function readLimit(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function boundedNumber(value: number | undefined, fallback: number, min: number, max: number): number {
  return value !== undefined && Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : fallback;
}

const tools: CapabilityDescriptor[] = [
  {
    name: "browser.execute",
    description: "Execute an AutoGLM-style browser action against a selected tab.",
    capabilities: ["tabs", "navigation", "dom", "input", "screenshot", "storage", "network", "debugger"],
    inputSchema: {
      type: "object",
      required: ["command"],
      properties: {
        command: { type: "string" },
        args: { type: "object" },
        target: { type: "object" },
        priority: { type: "number" },
        estimatedSteps: { type: "number" },
        estimatedCostMs: { type: "number" },
        preemptible: { type: "boolean" },
        deadlineAt: { type: "number" },
        queueTimeoutMs: { type: "number" },
      },
    },
  },
  {
    name: "browser.observe",
    description: "Return a compact semantic page observation with stable element refs.",
    capabilities: ["tabs", "dom", "screenshot"],
    inputSchema: { type: "object", properties: { screenshot: { type: "boolean" } } },
  },
  {
    name: "browser.inspect",
    description: "Return tabs, available commands, debugger state, and bridge diagnostics.",
    capabilities: ["tabs", "debugger"],
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "bridge.aiStatus",
    description: "Check optional Chrome on-device LanguageModel availability in the connected extension.",
    capabilities: ["debugger"],
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "bridge.queueStatus",
    description: "Inspect per-tab scheduler state for multi-agent coordination.",
    capabilities: ["tabs"],
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "bridge.cancel",
    description: "Cancel an agent-owned queued request without affecting other agents.",
    capabilities: ["tabs"],
    inputSchema: { type: "object", required: ["requestId"], properties: { requestId: { type: "string" } } },
  },
  {
    name: "bridge.agentStatus",
    description: "Inspect active and recent operations from all connected agents.",
    capabilities: ["tabs"],
    inputSchema: { type: "object", properties: {} },
  },
];

function send(socket: WebSocket, message: unknown): void {
  if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(message));
}
function broadcast(message: unknown): void {
  for (const socket of agentClients) {
    if (socket.bufferedAmount > limits.slowAgentBufferedBytes) {
      missedEvents.set(socket, (missedEvents.get(socket) ?? 0) + 1);
      continue;
    }
    const missed = missedEvents.get(socket) ?? 0;
    if (missed > 0) {
      send(socket, { type: "event", event: "bridge.eventsMissed", payload: { count: missed, recoverWith: "bridge.agentStatus+bridge.queueStatus" } });
      missedEvents.delete(socket);
    }
    send(socket, message);
  }
}

function requestExists(id: string): boolean {
  return pending.has(id) || [...queues.values()].some((queue) => queue.jobs.some((job) => job.request.id === id));
}

function announce(activity: AgentActivity): void {
  activities.set(activity.requestId, activity);
  activityHistory.push(activity);
  if (activityHistory.length > maxActivityHistory) activityHistory.shift();
  broadcast({ type: "event", event: "agent.activity", payload: activity });
}

function activitySummary(request: BridgeRequest): string | undefined {
  const command = request.params?.command;
  return typeof command === "string" ? command : undefined;
}

function estimateSteps(request: BridgeRequest): number {
  return Math.round(boundedNumber(request.estimatedSteps, 1, 1, 1000));
}

function estimateCostMs(request: BridgeRequest): number {
  return Math.round(boundedNumber(request.estimatedCostMs, 1000, 50, 300000));
}

function effectiveScore(job: Job, now = Date.now()): number {
  const request = job.request;
  const waitedMs = now - job.enqueuedAt;
  const basePriority = boundedNumber(request.priority, 0, -100, 100);
  const ageBonus = Math.min(100, waitedMs / 1000 / 5);
  const shortJobBonus = 30 / Math.sqrt(estimateSteps(request));
  const costPenalty = Math.min(30, estimateCostMs(request) / 10000);
  const deadlineBonus = request.deadlineAt && request.deadlineAt > now
    ? Math.min(50, (request.deadlineAt - now) < estimateCostMs(request) * 3 ? 50 : 0)
    : request.deadlineAt && request.deadlineAt <= now ? 100 : 0;
  return basePriority + ageBonus + shortJobBonus + deadlineBonus - costPenalty;
}

function response(id: string, ok: true, result?: unknown): BridgeResponse;
function response(id: string, ok: false, result: undefined, error: NonNullable<BridgeResponse["error"]>): BridgeResponse;
function response(id: string, ok: boolean, result?: unknown, error?: NonNullable<BridgeResponse["error"]>): BridgeResponse {
  if (ok) return { id, type: "response", ok: true, ...(result === undefined ? {} : { result: result as never }) };
  return { id, type: "response", ok: false, error: error ?? { code: "unknown", message: "Unknown bridge error" } };
}

function fail(id: string, code: string, message: string): BridgeResponse {
  return response(id, false, undefined, { code, message });
}

function queueKey(request: BridgeRequest): string | undefined {
  if (browserMcpMode && request.method === "browser.observe") return "browsermcp:selected-tab";
  if (request.method === "browser.observe" || request.method === "browser.inspect") return undefined;
  if (browserMcpMode && request.method.startsWith("browser.")) return "browsermcp:selected-tab";
  return `tab:${request.tabId ?? "active"}`;
}

function activeBrowserMcp(): WebSocket | undefined {
  return [...browserMcpClients].at(-1);
}

function browserMcpCall(request: BridgeRequest): { type: string; payload: Record<string, unknown>; wrapSnapshot?: boolean } | undefined {
  if (request.method === "browser.observe") return { type: "browser_snapshot", payload: {}, wrapSnapshot: true };
  if (request.method === "browser.inspect") return undefined;
  if (request.method !== "browser.execute") return undefined;
  const params = request.params ?? {};
  const args = params.args && typeof params.args === "object" && !Array.isArray(params.args)
    ? params.args as Record<string, unknown>
    : {};
  const command = params.command;
  const element = args.element;
  switch (command) {
    case "navigate": return { type: "browser_navigate", payload: { url: args.url } };
    case "click":
      return typeof element === "string" ? { type: "browser_click", payload: { element } } : undefined;
    case "type":
      return typeof element === "string" && typeof args.text === "string" ? { type: "browser_type", payload: { element, text: args.text } } : undefined;
    case "key": return { type: "browser_press_key", payload: { key: args.key } };
    case "wait": return { type: "browser_wait", payload: { time: Number(args.ms ?? 250) / 1000 } };
    case "screenshot": return { type: "browser_screenshot", payload: {} };
    case "observe": return { type: "browser_snapshot", payload: {}, wrapSnapshot: true };
    case "hover": return { type: "browser_hover", payload: { element } };
    case "drag": return { type: "browser_drag", payload: { startElement: args.startElement, endElement: args.endElement } };
    case "selectOption": return { type: "browser_select_option", payload: { element, values: args.values } };
    case "getConsoleLogs": return { type: "browser_get_console_logs", payload: {} };
    case "goBack": return { type: "browser_go_back", payload: {} };
    case "goForward": return { type: "browser_go_forward", payload: {} };
    default: return undefined;
  }
}

function dispatchBrowserMcp(job: Job, extension: WebSocket): void {
  const call = browserMcpCall(job.request);
  if (!call) {
    const error = fail(job.request.id, "unsupported_by_browsermcp", `Browser MCP adapter does not support ${job.request.method}/${String(job.request.params?.command ?? "")}`);
    send(job.socket, error);
    const queue = queues.get(job.queueKey);
    if (queue) {
      queue.active = false;
      delete queue.activeRequestId;
      broadcast({ type: "event", event: "request.completed", payload: { id: job.request.id, queue: job.queueKey, agentId: job.request.agentId ?? "anonymous", ok: false } });
      drain(job.queueKey);
    }
    return;
  }
  const timeoutMs = Math.round(boundedNumber(job.request.timeoutMs, 30000, 100, 300000));
  const timer = setTimeout(() => finish(job.request.id, fail(job.request.id, "timeout", `Browser MCP extension did not respond within ${timeoutMs}ms`)), timeoutMs);
  pending.set(job.request.id, {
    socket: job.socket,
    timer,
    queueKey: job.queueKey,
    agentId: job.request.agentId ?? "anonymous",
    protocol: "browsermcp",
    ...(call.wrapSnapshot === undefined ? {} : { wrapSnapshot: call.wrapSnapshot }),
  });
  send(extension, { id: job.request.id, type: call.type, payload: call.payload });
}

function handleBrowserMcpResponse(message: unknown): void {
  if (!message || typeof message !== "object") return;
  const envelope = message as { type?: unknown; payload?: unknown };
  if (envelope.type !== "messageResponse" || !envelope.payload || typeof envelope.payload !== "object") return;
  const payload = envelope.payload as { requestId?: unknown; result?: unknown; error?: unknown };
  if (typeof payload.requestId !== "string") return;
  const item = pending.get(payload.requestId);
  if (!item || item.protocol !== "browsermcp") return;
  const result: BridgeResponse = payload.error
    ? { id: payload.requestId, type: "response", ok: false, error: { code: "browsermcp_error", message: typeof payload.error === "string" ? payload.error : JSON.stringify(payload.error) } }
    : {
      id: payload.requestId,
      type: "response",
      ok: true,
      result: (item.wrapSnapshot ? { snapshot: payload.result } : payload.result) as never,
    };
  finish(payload.requestId, result);
}

function schedule(job: Job): void {
  let queue = queues.get(job.queueKey);
  if (!queue) {
    queue = { active: false, jobs: [], consecutiveJobs: 0, advisorState: localModelAdvisorEnabled ? "idle" : "disabled" };
    queues.set(job.queueKey, queue);
  }
  const agentId = job.request.agentId ?? "anonymous";
  const globalQueued = [...queues.values()].reduce((total, current) => total + current.jobs.length, 0);
  const agentQueuedOnTab = queue.jobs.filter((candidate) =>
    candidate.socket === job.socket || (candidate.request.agentId ?? "anonymous") === agentId,
  ).length;
  const rejection = globalQueued >= limits.globalQueued
    ? { code: "bridge_overloaded", message: "Bridge queue is full", limit: limits.globalQueued }
    : queue.jobs.length >= limits.perTabQueued
      ? { code: "tab_queue_full", message: "Queue for this browser tab is full", limit: limits.perTabQueued }
      : agentQueuedOnTab >= limits.perAgentPerTab
        ? { code: "agent_queue_quota", message: "Agent queue quota for this tab is full", limit: limits.perAgentPerTab }
        : pending.has(job.request.id) || [...queues.values()].some((current) => current.jobs.some((candidate) => candidate.request.id === job.request.id))
          ? { code: "duplicate_request_id", message: "Request id is already active or queued", limit: 0 }
          : undefined;
  if (rejection) {
    if (!queue.active && queue.jobs.length === 0) queues.delete(job.queueKey);
    send(job.socket, response(job.request.id, false, undefined, {
      code: rejection.code,
      message: rejection.message,
      details: { retryAfterMs: 1000, limit: rejection.limit, queueKey: job.queueKey },
    }));
    broadcast({ type: "event", event: "bridge.overloaded", payload: { agentId, requestId: job.request.id, queueKey: job.queueKey, ...rejection, retryAfterMs: 1000 } });
    return;
  }
  if (pending.size >= limits.activeRequests) {
    if (!queue.active && queue.jobs.length === 0) queues.delete(job.queueKey);
    send(job.socket, response(job.request.id, false, undefined, {
      code: "active_request_limit",
      message: "Bridge has reached its active browser request limit",
      details: { retryAfterMs: 1000, limit: limits.activeRequests },
    }));
    return;
  }
  const queueTimeoutMs = Math.round(boundedNumber(job.request.queueTimeoutMs, limits.queueWaitMs, 100, limits.queueWaitMs));
  job.queueTimer = setTimeout(() => {
    const currentQueue = queues.get(job.queueKey);
    if (!currentQueue) return;
    const index = currentQueue.jobs.indexOf(job);
    if (index < 0) return;
    currentQueue.jobs.splice(index, 1);
    const activity = activities.get(job.request.id);
    if (activity) announce({ ...activity, state: "failed", updatedAt: Date.now(), summary: "queue_wait_timeout" });
    activities.delete(job.request.id);
    send(job.socket, fail(job.request.id, "queue_wait_timeout", "Request exceeded the maximum queue wait time"));
    if (!currentQueue.active && currentQueue.jobs.length === 0) queues.delete(job.queueKey);
    broadcast({ type: "event", event: "queue.changed", payload: { key: job.queueKey, queuedCount: currentQueue.jobs.length, active: currentQueue.active } });
  }, queueTimeoutMs);
  queue.jobs.push(job);
  announce({
    agentId: job.request.agentId ?? "anonymous",
    requestId: job.request.id,
    method: job.request.method,
    ...(job.request.tabId === undefined ? {} : { tabId: job.request.tabId }),
    state: "queued",
    updatedAt: Date.now(),
    ...(activitySummary(job.request) ? { summary: activitySummary(job.request) } : {}),
  });

  broadcast({
    type: "event",
    event: "queue.changed",
    payload: { key: job.queueKey, queuedCount: queue.jobs.length, active: queue.active, requestId: job.request.id, agentId },
  });
  requestLocalPlan(job.queueKey);
  drain(job.queueKey);
}

function requestLocalPlan(key: string): void {
  if (browserMcpMode) return;
  const queue = queues.get(key);
  const extension = [...extensionClients][0];
  if (!queue || !localModelAdvisorEnabled || queue.jobs.length < advisorMinQueue || queue.advisorState === "planning") return;
  if (Date.now() - (queue.advisorLastStartedAt ?? 0) < 2000 || plannerInFlight >= 1 || !extension) return;
  queue.advisorState = "planning";
  queue.advisorLastStartedAt = Date.now();
  plannerInFlight += 1;
  broadcast({ type: "event", event: "scheduler.advisor", payload: { queueKey: key, state: "planning", provider: "optional-chrome-local-model", timeoutMs: advisorTimeoutMs } });
  const id = `planner:${randomUUID()}`;
  const timer = setTimeout(() => {
    const pendingPlan = pending.get(id);
    if (!pendingPlan) return;
    pending.delete(id);
    plannerInFlight = Math.max(0, plannerInFlight - 1);
    const targetQueue = queues.get(key);
    if (targetQueue) {
      targetQueue.advisorState = "fallback";
      broadcast({ type: "event", event: "scheduler.advisor", payload: { queueKey: key, state: "fallback", reason: "advisor_timeout", policy: "deterministic" } });
      drain(key);
    }
  }, advisorTimeoutMs);
  pending.set(id, { socket: extension, timer, agentId: "local-model-advisor", plannerQueueKey: key });
  send(extension, {
    id,
    type: "request",
    method: "bridge.schedulerPlan",
    params: {
      queueKey: key,
      tasks: queue.jobs.map((job) => ({
        id: job.request.id,
        agentId: job.request.agentId ?? "anonymous",
        command: activitySummary(job.request) ?? job.request.method,
        priority: boundedNumber(job.request.priority, 0, -100, 100),
        estimatedSteps: estimateSteps(job.request),
        estimatedCostMs: estimateCostMs(job.request),
        waitMs: Date.now() - job.enqueuedAt,
        deadlineAt: job.request.deadlineAt ?? null,
      })),
    },
  });
}

function handlePlannerResponse(id: string, result: BridgeResponse): boolean {
  const item = pending.get(id);
  if (!item?.plannerQueueKey) return false;
  clearTimeout(item.timer);
  pending.delete(id);
  plannerInFlight = Math.max(0, plannerInFlight - 1);
  const queue = queues.get(item.plannerQueueKey);
  const order = result.ok && result.result && typeof result.result === "object"
    ? (result.result as { order?: unknown }).order
    : undefined;
  if (queue && Array.isArray(order) && order.every((id): id is string => typeof id === "string")) {
    const queuedIds = new Set(queue.jobs.map((job) => job.request.id));
    const validOrder = [...new Set(order)].filter((id) => queuedIds.has(id));
    if (validOrder.length > 0) {
      queue.advisorOrder = validOrder;
      queue.advisorState = "ready";
      broadcast({ type: "event", event: "scheduler.advisor", payload: { queueKey: item.plannerQueueKey, state: "ready", order: validOrder, appliedAs: "bounded_tiebreaker" } });
      drain(item.plannerQueueKey);
      return true;
    }
  }
  if (queue) {
    queue.advisorState = "fallback";
    broadcast({ type: "event", event: "scheduler.advisor", payload: { queueKey: item.plannerQueueKey, state: "fallback", reason: "invalid_or_unavailable_advice", policy: "deterministic" } });
    drain(item.plannerQueueKey);
  }
  return true;
}

function queueSnapshot(key: string): unknown {
  const queue = queues.get(key);
  if (!queue) return { key, active: false, queued: [] };
  return {
    key,
    active: queue.active,
    ...(queue.activeRequestId ? { activeRequestId: queue.activeRequestId } : {}),
    scheduling: {
      policy: "priority+aging+short-job+deadline+agent-fairness",
      localModelAdvisor: queue.advisorState,
      ...(queue.lastAgentId ? { lastAgentId: queue.lastAgentId } : {}),
      consecutiveJobs: queue.consecutiveJobs,
    },
    queued: queue.jobs
      .map((job) => ({ job, score: effectiveScore(job) }))
      .sort((a, b) => b.score - a.score)
      .map(({ job, score }) => {
        const { request } = job;
        return {
          id: request.id,
          ...(request.agentId ? { agentId: request.agentId } : {}),
          ...(request.tabId === undefined ? {} : { tabId: request.tabId }),
          priority: request.priority ?? 0,
          estimatedSteps: estimateSteps(request),
          estimatedCostMs: estimateCostMs(request),
          effectiveScore: Math.round(score * 100) / 100,
          waitMs: Date.now() - job.enqueuedAt,
        };
      }),
  };
}

function allQueueSnapshots(): unknown[] {
  return [...queues.keys()].map(queueSnapshot);
}

function drain(key: string): void {
  const queue = queues.get(key);
  if (!queue || queue.active) return;
  const browserMcp = browserMcpMode ? activeBrowserMcp() : undefined;
  const extension = browserMcp ? undefined : [...extensionClients][0];
  const targetSocket = browserMcp ?? extension;
  if (targetSocket && targetSocket.bufferedAmount > limits.slowAgentBufferedBytes) {
    if (!queue.drainTimer) {
      queue.drainTimer = setTimeout(() => {
        delete queue.drainTimer;
        drain(key);
      }, 100);
    }
    return;
  }
  const now = Date.now();
  const fairnessThreshold = 3;
  let bestIndex = 0;
  let bestScore = Number.NEGATIVE_INFINITY;
  queue.jobs.forEach((candidate, index) => {
    let score = effectiveScore(candidate, now);
    const advisorRank = queue.advisorOrder?.indexOf(candidate.request.id) ?? -1;
    if (advisorRank >= 0) score += Math.max(0, 8 - advisorRank);
    const agentId = candidate.request.agentId ?? "anonymous";
    if (agentId === queue.lastAgentId && queue.consecutiveJobs >= fairnessThreshold && queue.jobs.some((other) => (other.request.agentId ?? "anonymous") !== agentId)) {
      score -= 25;
    }
    if (score > bestScore) {
      bestScore = score;
      bestIndex = index;
    }
  });
  const job = queue.jobs.splice(bestIndex, 1)[0];
  if (!job) {
    queues.delete(key);
    return;
  }
  if (queue.advisorOrder) queue.advisorOrder = queue.advisorOrder.filter((id) => id !== job.request.id);
  if (job.queueTimer) clearTimeout(job.queueTimer);
  if (job.socket.readyState !== job.socket.OPEN) {
    drain(key);
    return;
  }
  if (!targetSocket) {
    if (browserMcpMode) {
      if (!queue.drainTimer) {
        queue.drainTimer = setTimeout(() => {
          delete queue.drainTimer;
          drain(key);
        }, 250);
      }
      return;
    }
    send(job.socket, fail(job.request.id, "extension_unavailable", "No browser extension is connected"));
    drain(key);
    return;
  }
  queue.active = true;
  queue.activeRequestId = job.request.id;
  const agentId = job.request.agentId ?? "anonymous";
  if (queue.lastAgentId === agentId) queue.consecutiveJobs += 1;
  else {
    queue.lastAgentId = agentId;
    queue.consecutiveJobs = 1;
  }
  const current = activities.get(job.request.id);
  if (current) announce({ ...current, state: "running", startedAt: Date.now(), updatedAt: Date.now() });
  if (browserMcp) {
    dispatchBrowserMcp(job, browserMcp);
    return;
  }
  const timeoutMs = Math.round(boundedNumber(job.request.timeoutMs, 30000, 100, 300000));
  const timer = setTimeout(() => finish(job.request.id, fail(job.request.id, "timeout", `Extension did not respond within ${timeoutMs}ms`)), timeoutMs);
  pending.set(job.request.id, { socket: job.socket, timer, queueKey: key, agentId });
  send(extension!, job.request);
}

function finish(id: string, result: BridgeResponse): void {
  const item = pending.get(id);
  if (!item) return;
  if (item.plannerQueueKey) {
    handlePlannerResponse(id, result);
    return;
  }
  clearTimeout(item.timer);
  pending.delete(id);
  const current = activities.get(id);
  if (current) announce({
    ...current,
    state: result.error?.code === "cancelled" ? "cancelled" : result.ok ? "completed" : "failed",
    updatedAt: Date.now(),
  });
  activities.delete(id);
  if (!item.cancelled) send(item.socket, result);
  if (item.queueKey) {
    const queue = queues.get(item.queueKey);
    if (queue) {
      queue.active = false;
      delete queue.activeRequestId;
      drain(item.queueKey);
      broadcast({ type: "event", event: "request.completed", payload: { id, queue: item.queueKey, agentId: item.agentId, ok: result.ok } });
    }
  }
}

function discardAgent(socket: WebSocket): void {
  for (const [id, item] of pending) {
    if (item.socket === socket) finish(id, fail(id, "agent_disconnected", "Agent disconnected before the command completed"));
  }
  for (const [key, queue] of queues) {
    queue.jobs = queue.jobs.filter((job) => {
      if (job.socket !== socket) return true;
      if (job.queueTimer) clearTimeout(job.queueTimer);
      return false;
    });
    if (!queue.active && queue.jobs.length === 0) queues.delete(key);
  }
  broadcast({ type: "event", event: "queue.changed", payload: allQueueSnapshots() });
}

function cancelQueued(id: string, socket: WebSocket): boolean {
  for (const [key, queue] of queues) {
    const index = queue.jobs.findIndex((job) => job.request.id === id && job.socket === socket);
    if (index < 0) continue;
    const [removed] = queue.jobs.splice(index, 1);
    if (removed?.queueTimer) clearTimeout(removed.queueTimer);
    if (!queue.active && queue.jobs.length === 0) queues.delete(key);
    send(socket, response(id, false, undefined, { code: "cancelled", message: "Request cancelled before execution" }));
    const current = activities.get(id);
    if (current) announce({ ...current, state: "cancelled", updatedAt: Date.now() });
    activities.delete(id);
    broadcast({ type: "event", event: "queue.changed", payload: allQueueSnapshots() });
    return true;
  }
  return false;
}

const server = new WebSocketServer({ port, host: "127.0.0.1", maxPayload: 1_048_576, perMessageDeflate: false });
server.on("error", (error) => {
  console.error("[browser-agent-bridge] WebSocket server error", error);
});
if (browserMcpMode) {
  const browserMcpServer = new WebSocketServer({ port: browserMcpPort, host: "127.0.0.1", maxPayload: 1_048_576, perMessageDeflate: false });
  browserMcpServer.on("error", (error) => console.error("[browser-agent-bridge] Browser MCP WebSocket server error", error));
  browserMcpServer.on("connection", (socket) => {
    browserMcpClients.add(socket);
    console.log("[browser-agent-bridge] Browser MCP extension connected");
    for (const key of queues.keys()) drain(key);
    socket.on("message", (raw) => {
      try { handleBrowserMcpResponse(JSON.parse(raw.toString())); }
      catch { console.warn("[browser-agent-bridge] Invalid Browser MCP response JSON"); }
    });
    socket.on("close", () => {
      browserMcpClients.delete(socket);
      for (const [id, item] of pending) {
        if (item.protocol === "browsermcp") finish(id, fail(id, "extension_disconnected", "Browser MCP extension disconnected"));
      }
      for (const key of queues.keys()) drain(key);
    });
  });
}
server.on("connection", (socket, request) => {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  const queryToken = url.searchParams.get("token");
  if (token && request.headers.authorization !== `Bearer ${token}` && queryToken !== token) {
    socket.close(1008, "invalid bridge token");
    return;
  }
  const isExtension = url.searchParams.get("role") === "extension";
  if (!isExtension && agentClients.size >= limits.agentConnections) {
    send(socket, fail("connection", "agent_connection_limit", "Bridge has reached its concurrent agent connection limit"));
    socket.close(1013, "agent connection limit");
    return;
  }
  (isExtension ? extensionClients : agentClients).add(socket);
  const hello: HelloMessage = {
    type: "hello",
    version: 1,
    client: "browser-agent-bridge",
    capabilities: ["tabs", "dom", "input", "screenshot", "debugger"],
  };
  send(socket, {
    ...hello,
    role: isExtension ? "extension" : "agent",
    tools,
    scheduler: { model: browserMcpMode ? "single-selected-tab-serial" : "per-tab-serial", crossTab: browserMcpMode ? "serialized" : "parallel", adapter: browserMcpMode ? "browsermcp" : "bridge-extension", limits },
  });

  socket.on("message", (raw) => {
    let message: unknown;
    try { message = JSON.parse(raw.toString()); } catch { send(socket, fail("unknown", "invalid_json", "Message must be valid JSON")); return; }
    if (message && typeof message === "object" && (message as { type?: unknown }).type === "response") {
      const result = message as BridgeResponse;
      if (isExtension) finish(result.id, result);
      return;
    }
    if (!isRequest(message)) { send(socket, fail("unknown", "invalid_request", "Expected a request message")); return; }
    const req = message as BridgeRequest;
    if (isExtension) return;
    if (req.id.length > 128) { send(socket, fail(req.id.slice(0, 128), "invalid_request", "Request id must be at most 128 characters")); return; }
    if (req.method === "bridge.listTools") { send(socket, response(req.id, true, tools)); return; }
    if (req.method === "bridge.ping") {
      const queued = [...queues.values()].reduce((total, current) => total + current.jobs.length, 0);
      send(socket, response(req.id, true, { now: Date.now(), requestId: randomUUID(), agents: agentClients.size, queued, activeRequests: pending.size, limits }));
      return;
    }
    if (req.method === "bridge.queueStatus") { send(socket, response(req.id, true, allQueueSnapshots())); return; }
    if (req.method === "bridge.agentStatus") {
      send(socket, response(req.id, true, { active: [...activities.values()].filter((item) => item.state === "queued" || item.state === "running"), recent: activityHistory.slice(-50) }));
      return;
    }
    if (req.method === "browser.inspect" && browserMcpMode) {
      send(socket, response(req.id, true, {
        adapter: "browsermcp",
        connected: browserMcpClients.size > 0,
        target: "the tab selected and connected from the Browser MCP extension",
        tools: ["browser_snapshot", "browser_navigate", "browser_click", "browser_type", "browser_press_key", "browser_wait", "browser_screenshot", "browser_hover", "browser_drag", "browser_select_option", "browser_get_console_logs", "browser_go_back", "browser_go_forward"],
        limitations: ["single selected tab", "page text is available through accessibility snapshots", "CSS selectors and this prototype's element refs are not interchangeable with Browser MCP element descriptions"],
      }));
      return;
    }
    if (req.method === "bridge.aiStatus") {
      if (browserMcpMode) {
        send(socket, response(req.id, true, { available: false, reason: "Browser MCP does not expose Chrome LanguageModel to this bridge adapter" }));
        return;
      }
      const extension = [...extensionClients][0];
      if (!extension) { send(socket, fail(req.id, "extension_unavailable", "No browser extension is connected")); return; }
      if (pending.size >= limits.activeRequests) {
        send(socket, response(req.id, false, undefined, { code: "active_request_limit", message: "Bridge has reached its active browser request limit", details: { retryAfterMs: 1000, limit: limits.activeRequests } }));
        return;
      }
      if (requestExists(req.id)) { send(socket, fail(req.id, "duplicate_request_id", "Request id is already active or queued")); return; }
      const timeoutMs = 1500;
      const timer = setTimeout(() => finish(req.id, fail(req.id, "timeout", "Chrome local model status check timed out")), timeoutMs);
      pending.set(req.id, { socket, timer, agentId: req.agentId ?? "anonymous" });
      send(extension, req);
      return;
    }
    if (req.method === "bridge.cancel") {
      const targetId = req.params?.requestId;
      if (typeof targetId !== "string") { send(socket, fail(req.id, "invalid_request", "bridge.cancel requires params.requestId")); return; }
      if (cancelQueued(targetId, socket)) send(socket, response(req.id, true, { cancelled: true, requestId: targetId }));
      else if (pending.get(targetId)?.socket === socket) {
        const active = pending.get(targetId);
        if (active) {
          active.cancelled = true;
          send(socket, response(req.id, true, { cancelled: true, requestId: targetId, state: "running" }));
        }
      } else send(socket, fail(req.id, "not_found", "Request is not queued or owned by this agent"));
      return;
    }
    const key = queueKey(req);
    if (!key) {
      if (pending.size >= limits.activeRequests) {
        send(socket, response(req.id, false, undefined, { code: "active_request_limit", message: "Bridge has reached its active browser request limit", details: { retryAfterMs: 1000, limit: limits.activeRequests } }));
        return;
      }
      if (requestExists(req.id)) { send(socket, fail(req.id, "duplicate_request_id", "Request id is already active or queued")); return; }
      const extension = [...extensionClients][0];
      if (!extension) { send(socket, fail(req.id, "extension_unavailable", "No browser extension is connected")); return; }
      const timeoutMs = Math.round(boundedNumber(req.timeoutMs, 30000, 100, 300000));
      const timer = setTimeout(() => finish(req.id, fail(req.id, "timeout", `Extension did not respond within ${timeoutMs}ms`)), timeoutMs);
      pending.set(req.id, { socket, timer, agentId: req.agentId ?? "anonymous" });
      announce({
        agentId: req.agentId ?? "anonymous",
        requestId: req.id,
        method: req.method,
        ...(req.tabId === undefined ? {} : { tabId: req.tabId }),
        state: "running",
        startedAt: Date.now(),
        updatedAt: Date.now(),
        ...(activitySummary(req) ? { summary: activitySummary(req) } : {}),
      });
      send(extension, req);
      return;
    }
    schedule({ request: req, socket, queueKey: key, enqueuedAt: Date.now() });
  });
  socket.on("close", () => {
    (isExtension ? extensionClients : agentClients).delete(socket);
    missedEvents.delete(socket);
    if (isExtension) {
      for (const [id, item] of pending) {
        finish(id, fail(id, "extension_disconnected", "Browser extension disconnected before the command completed"));
      }
    } else {
      discardAgent(socket);
    }
  });
});

console.log(`Browser Agent Bridge listening on ws://127.0.0.1:${port}`);
