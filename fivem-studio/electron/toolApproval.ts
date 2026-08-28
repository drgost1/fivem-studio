import { randomUUID } from "node:crypto";

export type ToolRisk = "write" | "dangerous";

export interface ToolApprovalRequestEvent {
  type: "approval_request";
  approvalId: string;
  toolCallId: string;
  name: string;
  input: unknown;
  risk: ToolRisk;
  summary: string;
}

export interface ToolApprovalResolvedEvent {
  type: "approval_resolved";
  approvalId: string;
  approved: boolean;
  reason?: string;
}

type ApprovalEvent = ToolApprovalRequestEvent | ToolApprovalResolvedEvent;
type ApprovalEmit = (event: ApprovalEvent) => void;

interface PendingApproval {
  emit: ApprovalEmit;
  resolve: (approved: boolean) => void;
  timer: NodeJS.Timeout;
}

const pending = new Map<string, PendingApproval>();
const APPROVAL_TIMEOUT_MS = 10 * 60 * 1000;

const WRITE_TOOLS = new Set([
  "write_project_file",
  "start_resource",
  "stop_resource",
  "restart_resource",
]);

const READ_ONLY_TOOLS = new Set([
  "list_project_files",
  "read_project_file",
  "search_project",
  "get_editor_context",
  "get_runtime_identity",
  "get_console_output",
  "list_resources",
]);

/** Unknown server tools are dangerous until Studio has explicitly classified them. */
export function toolRisk(name: string): ToolRisk | null {
  if (READ_ONLY_TOOLS.has(name)) return null;
  if (WRITE_TOOLS.has(name)) return "write";
  return "dangerous";
}

export async function requestToolApproval(
  toolCallId: string,
  name: string,
  input: Record<string, unknown>,
  emit: ApprovalEmit,
): Promise<boolean> {
  const risk = toolRisk(name);
  if (!risk) return true;

  const approvalId = randomUUID();
  const summary = summarize(name, input);

  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      const entry = pending.get(approvalId);
      if (!entry) return;
      pending.delete(approvalId);
      entry.emit({
        type: "approval_resolved",
        approvalId,
        approved: false,
        reason: "Approval timed out.",
      });
      resolve(false);
    }, APPROVAL_TIMEOUT_MS);

    pending.set(approvalId, { emit, resolve, timer });
    emit({ type: "approval_request", approvalId, toolCallId, name, input, risk, summary });
  });
}

export function resolveToolApproval(approvalId: string, approved: boolean): boolean {
  const entry = pending.get(approvalId);
  if (!entry) return false;
  pending.delete(approvalId);
  clearTimeout(entry.timer);
  entry.emit({ type: "approval_resolved", approvalId, approved });
  entry.resolve(approved);
  return true;
}

export function cancelPendingToolApprovals(reason = "The agent turn was cancelled."): void {
  for (const [approvalId, entry] of pending) {
    clearTimeout(entry.timer);
    entry.emit({ type: "approval_resolved", approvalId, approved: false, reason });
    entry.resolve(false);
  }
  pending.clear();
}

function summarize(name: string, input: Record<string, unknown>): string {
  switch (name) {
    case "write_project_file":
      return `Write project file ${String(input.path ?? "(missing path)")}`;
    case "start_resource":
      return `Start resource ${String(input.name ?? "(missing name)")}`;
    case "stop_resource":
      return `Stop resource ${String(input.name ?? "(missing name)")}`;
    case "restart_resource":
      return `Restart resource ${String(input.name ?? "(missing name)")}`;
    default:
      return `Run unclassified MCP tool ${name}`;
  }
}
