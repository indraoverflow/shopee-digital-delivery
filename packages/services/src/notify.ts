import { createHmac } from "node:crypto";
import { loadSettings } from "./settings.js";
import type { ServiceDeps } from "./types.js";
import { nowOf } from "./types.js";

/**
 * Outbound notifications for the handful of events an operator wants to know
 * about without refreshing a dashboard.
 *
 * A single webhook, signed with HMAC when a secret is set, is enough to reach
 * Slack, n8n, or the WhatsApp gateway already running on this host, and it adds
 * no dependency. Delivery is best effort: a notification outage must never
 * break a claim, so failures are logged and swallowed.
 */

export const NOTIFY_EVENTS = [
  "claim.completed",
  "claim.revoked",
  "fulfillment.out_of_stock",
  "sync.failed",
  "manual_request.created",
] as const;
export type NotifyEventType = (typeof NOTIFY_EVENTS)[number];

export interface NotifyEvent {
  type: NotifyEventType;
  title: string;
  /** Plain key/value context; no secrets, no buyer contact details. */
  data: Record<string, string | number | boolean | null>;
}

export interface NotifyResult {
  delivered: boolean;
  reason?: "disabled" | "no_url" | "filtered" | "http_error" | "exception";
  status?: number;
}

export function signNotification(secret: string, body: string): string {
  return createHmac("sha256", secret).update(body).digest("hex");
}

export async function notify(
  deps: ServiceDeps,
  event: NotifyEvent,
  fetchImpl: typeof fetch = fetch,
): Promise<NotifyResult> {
  const settings = await loadSettings(deps);
  const config = settings.notify;

  if (!config.enabled) return { delivered: false, reason: "disabled" };
  if (!config.webhookUrl) return { delivered: false, reason: "no_url" };
  if (config.events.length > 0 && !config.events.includes(event.type))
    return { delivered: false, reason: "filtered" };

  const body = JSON.stringify({
    type: event.type,
    title: event.title,
    data: event.data,
    at: nowOf(deps).toISOString(),
    source: "qansa-delivery",
  });

  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (config.secret)
    headers["x-qansa-signature"] = signNotification(config.secret, body);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5_000);
  try {
    const response = await fetchImpl(config.webhookUrl, {
      method: "POST",
      headers,
      body,
      signal: controller.signal,
    });
    if (!response.ok) {
      deps.logger.warn(
        { event: event.type, status: response.status },
        "notification rejected",
      );
      return {
        delivered: false,
        reason: "http_error",
        status: response.status,
      };
    }
    return { delivered: true, status: response.status };
  } catch (error) {
    deps.logger.warn(
      {
        event: event.type,
        err: error instanceof Error ? error.message : String(error),
      },
      "notification failed",
    );
    return { delivered: false, reason: "exception" };
  } finally {
    clearTimeout(timeout);
  }
}
