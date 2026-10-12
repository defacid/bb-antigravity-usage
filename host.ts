import { experimental_defineHostEntry } from "@get-bb/plugin-sdk";
import { readAntigravityUsage } from "./antigravity-usage.js";
import { hostUsageState, usageHostContract } from "./usage-host-contract.js";

export default experimental_defineHostEntry({
  contract: usageHostContract,
  handlers: {
    async "usage.readAntigravity"() {
      // Host bundles do not include the provider-bridge SDK entry point. `agy`
      // is resolved by execFile against the host daemon's PATH instead.
      const result = await readAntigravityUsage({ agyCli: "agy" });
      return hostUsageState.parse(result.supported
        ? result.usage
        : { status: "error", message: "Antigravity usage is unsupported.", accountEmail: null, planLabel: null });
    },
  },
});
