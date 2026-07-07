import { exportReconciliationDecisions } from "../lib/reconciliation/decisions";

async function main() {
  const payload = await exportReconciliationDecisions();
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
