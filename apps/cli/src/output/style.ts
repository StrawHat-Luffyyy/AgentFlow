import { styleText } from "node:util";
import type { CliIO } from "../io.js";

type Format = Parameters<typeof styleText>[0];

const STATUS_FORMAT: Record<string, Format> = {
  SUCCEEDED: "green",
  APPROVED: "green",
  FAILED: "red",
  TIMED_OUT: "red",
  REJECTED: "red",
  WAITING_APPROVAL: "yellow",
  NEEDS_ATTENTION: "yellow",
  PAUSED: "yellow",
  PAUSE_REQUESTED: "yellow",
  CANCEL_REQUESTED: "yellow",
  RETRY_WAIT: "yellow",
  PENDING: "yellow",
  RUNNING: "cyan",
  QUEUED: "cyan",
  CANCELLED: "dim",
  EXPIRED: "dim",
};

export function colorEnabled(io: CliIO, flag: boolean): boolean {
  if (!flag) return false;
  if (io.env.NO_COLOR !== undefined && io.env.NO_COLOR !== "") return false;
  if (io.env.TERM === "dumb") return false;
  return io.stdout.isTTY === true;
}

export function paint(format: Format, text: string, color: boolean): string {
  return color ? styleText(format, text, { validateStream: false }) : text;
}

export function paintStatus(status: string, color: boolean): string {
  const format = STATUS_FORMAT[status];
  return format ? paint(format, status, color) : status;
}
