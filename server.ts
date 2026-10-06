import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { usageHostContract } from "./usage-host-contract.js";

const PROVIDER_ID = "acp-antigravity";
const LIST_RESOURCES = "provider-usage.v1.listResources";
const GET_RESOURCE = "provider-usage.v1.getResource";

const usageState = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("ok"), plan: z.null(), accountEmail: z.string().nullable(), planLabel: z.string().nullable(),
    windows: z.array(z.object({
      kind: z.enum(["five-hour", "weekly", "daily", "custom"]), id: z.string().min(1), label: z.string().min(1),
      usedPercent: z.number().nonnegative(), resetsAt: z.string().nullable(), model: z.string().nullable(), cost: z.null(),
    })),
  }),
  ...(["not_installed", "unauthenticated", "expired"] as const).map((status) => z.object({
    status: z.literal(status), plan: z.null(), accountEmail: z.null(), planLabel: z.null(),
  })),
  z.object({ status: z.literal("error"), plan: z.null(), accountEmail: z.null(), planLabel: z.null(), message: z.string() }),
]);

const contract = defineRpcContract({
  [LIST_RESOURCES]: {
    input: z.object({}),
    output: z.object({ label: z.string().min(1).optional(), resources: z.array(z.object({
      accountKey: z.string().min(1).nullable(), id: z.string().min(1), providerId: z.string().min(1), label: z.string().min(1),
      scope: z.object({ kind: z.literal("host"), hostId: z.string().min(1), hostName: z.string().min(1) }),
    })) }),
  },
  [GET_RESOURCE]: {
    input: z.object({ resourceId: z.string().min(1), refresh: z.boolean() }),
    output: z.object({ accountKey: z.string().min(1).nullable(), observedAt: z.number().int().nonnegative().nullable(), usage: usageState }),
  },
});

export default function plugin(bb: BbPluginApi): void {
  const usageHost = bb.hosts.experimental_client({ contract: usageHostContract });
  bb.rpc.register(contract, {
    [LIST_RESOURCES]: async () => ({
      resources: (await bb.sdk.hosts.list()).filter((host) => host.status === "connected").map((host) => ({
        accountKey: null, id: host.id, providerId: PROVIDER_ID, label: "Antigravity",
        scope: { kind: "host" as const, hostId: host.id, hostName: host.name },
      })),
    }),
    [GET_RESOURCE]: async ({ resourceId }) => {
      const state = await usageHost.call("usage.readAntigravity", {}, { hostId: resourceId, timeoutMs: 20_000 });
      const base = { accountKey: null, observedAt: Date.now() };
      if (state.status === "ok") return { ...base, usage: {
        status: "ok" as const, plan: null, accountEmail: state.accountEmail, planLabel: state.planLabel,
        windows: state.windows.map((window, index) => ({
          kind: "custom" as const,
          id: `antigravity-${index}`,
          label: window.label,
          usedPercent: window.usedPercent,
          resetsAt: window.resetsAt,
          model: null,
          cost: null,
        })),
      } };
      if (state.status === "error") return { ...base, usage: { status: "error" as const, plan: null, accountEmail: null, planLabel: null, message: state.message } };
      return { ...base, usage: { status: state.status, plan: null, accountEmail: null, planLabel: null } };
    },
  }, { experimental_discoverable: true, experimental_description: "Adds Antigravity quota windows to BB Provider Usage." });
}
