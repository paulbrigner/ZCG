import fs from "node:fs/promises";
import { importReconciliationDecisions } from "../lib/reconciliation/decisions";

type ImportPayload = {
  decisions?: unknown;
};

async function main() {
  const filePath = process.argv[2];

  if (!filePath) {
    throw new Error("Usage: npm run reconciliation:import -- /path/to/reconciliation-decisions.json");
  }

  const raw = await fs.readFile(filePath, "utf8");
  const payload = JSON.parse(raw) as ImportPayload;

  if (!Array.isArray(payload.decisions)) {
    throw new Error("Import file must contain a decisions array.");
  }

  const decisions = payload.decisions as Parameters<typeof importReconciliationDecisions>[0];
  const result = await importReconciliationDecisions(decisions);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
