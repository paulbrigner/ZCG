import {
  ReconciliationBusyError,
  runGrantReconciliation
} from "../lib/reconciliation/grants";

runGrantReconciliation()
  .then((result) => {
    console.log(JSON.stringify(result, null, 2));
  })
  .catch((error) => {
    if (error instanceof ReconciliationBusyError) {
      console.log(JSON.stringify({
        ok: false,
        busy: true,
        skipped: true,
        error: error.message,
        lockedUntil: error.lockedUntil
      }, null, 2));
      return;
    }

    console.error(error);
    process.exitCode = 1;
  });
