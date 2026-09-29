export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export type Capability =
  | "tabs"
  | "navigation"
  | "dom"
  | "input"
  | "screenshot"
  | "storage"
  | "network"
  | "debugger"
  | "downloads"
  | "cookies";

export type BrowserAction =
  | "observe"
  | "getText"
  | "getHtml"
  | "click"
  | "type"
  | "key"
  | "scroll"
  | "wait"
  | "evaluate";

export interface BridgeRequest {
  id: string;
  type: "request";
  method: string;
  params?: Record<string, JsonValue>;
  tabId?: number;
  timeoutMs?: number;
  agentId?: string;
  priority?: number;
  estimatedSteps?: number;
  estimatedCostMs?: number;
  preemptible?: boolean;
  deadlineAt?: number;
  queueTimeoutMs?: number;
}

export interface BridgeResponse {
  id: string;
  type: "response";
  ok: boolean;
  result?: JsonValue;
  error?: { code: string; message: string; details?: JsonValue };
}

export interface BridgeEvent {
  type: "event";
  event: string;
  tabId?: number;
  payload: JsonValue;
}

export interface QueueSnapshot {
  key: string;
  active: boolean;
  queued: Array<{ id: string; agentId?: string; tabId?: number; priority: number; estimatedSteps: number; estimatedCostMs: number; effectiveScore: number; waitMs: number }>;
  activeRequestId?: string;
  scheduling?: { policy: string; lastAgentId?: string; consecutiveJobs: number };
}

export interface AgentActivity {
  agentId: string;
  requestId: string;
  method: string;
  tabId?: number;
  state: "queued" | "running" | "completed" | "failed" | "cancelled";
  startedAt?: number;
  updatedAt: number;
  summary?: string | undefined;
}

export interface Observation {
  url: string;
  title: string;
  viewport: { width: number; height: number; scrollX: number; scrollY: number };
  elements: Array<{
    ref: string;
    role: string;
    text: string;
    rect: { x: number; y: number; width: number; height: number };
    attributes: Record<string, string>;
  }>;
}

export interface CapabilityDescriptor {
  name: string;
  description: string;
  capabilities: Capability[];
  inputSchema: Record<string, JsonValue>;
}

export interface HelloMessage {
  type: "hello";
  version: 1;
  client: string;
  capabilities: Capability[];
}

export function isRequest(value: unknown): value is BridgeRequest {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<BridgeRequest>;
  return candidate.type === "request" && typeof candidate.id === "string" && typeof candidate.method === "string";
}
