import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { usageHostContract } from "./usage-host-contract.js";

const PROVIDER_ID = "acp-antigravity";
const LIST_RESOURCES = "provider-usage.v1.listResources";
const GET_RESOURCE = "provider-usage.v1.getResource";

const usageState = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("ok"),
    plan: z.null(),
    accountEmail: z.string().nullable(),
    planLabel: z.string().nullable(),
    windows: z.array(z.object({
      kind: z.enum(["five-hour", "daily", "weekly", "custom"]).default("custom"),
      id: z.string().min(1),
      label: z.string().min(1),
      usedPercent: z.number().nonnegative(),
      resetsAt: z.string().nullable(),
      model: z.string().nullable(),
      cost: z.null(),
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
          kind: window.kind ?? "custom",
          id: window.id ?? `antigravity-${index}`,
          label: window.label,
          usedPercent: window.usedPercent,
          resetsAt: window.resetsAt,
          model: window.model ?? (window.label.includes("Gemini") ? "Gemini" : window.label.includes("Claude") ? "Claude & GPT" : null),
          cost: null,
        })),
      } };
      if (state.status === "error") return { ...base, usage: { status: "error" as const, plan: null, accountEmail: null, planLabel: null, message: state.message } };
      return { ...base, usage: { status: state.status, plan: null, accountEmail: null, planLabel: null } };
    },
  }, { experimental_discoverable: true, experimental_description: "Adds Antigravity and Gemini quota windows to BB Provider Usage." });

  // `bb antigravity-quota [--json]`
  bb.cli.register({
    name: "antigravity-quota",
    summary: "Show Antigravity & Gemini quota usage (5h and weekly limits)",
    commands: [{ name: "show", summary: "Show current quota", usage: "bb antigravity-quota [--json]" }],
    async run(argv) {
      const json = argv.includes("--json");
      const hosts = (await bb.sdk.hosts.list()).filter((h) => h.status === "connected");
      if (hosts.length === 0) {
        return { exitCode: 1, stdout: "No connected hosts found." };
      }
      const hostId = hosts[0].id;
      const state = await usageHost.call("usage.readAntigravity", {}, { hostId, timeoutMs: 20_000 });
      if (json) return { exitCode: 0, stdout: JSON.stringify(state) };
      if (state.status !== "ok") {
        const msg = "message" in state ? (state as any).message : "";
        return { exitCode: 1, stdout: `Antigravity quota unavailable: ${state.status} ${msg}`.trim() };
      }
      const lines = [
        state.accountEmail ? `Account: ${state.accountEmail}` : null,
        ...state.windows.map(
          (w) => `${w.label.padEnd(32)} ${String(w.usedPercent).padStart(5)}% used  resets ${w.resetsAt ?? "—"}`
        ),
      ].filter(Boolean);
      return { exitCode: 0, stdout: lines.join("\n") };
    },
  });
}
