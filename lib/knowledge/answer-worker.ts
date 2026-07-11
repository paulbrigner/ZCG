import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";

const lambda = new LambdaClient({});

export async function invokeKnowledgeAnswerWorker(jobId: string) {
  const functionName = process.env.ZCG_KNOWLEDGE_ANSWER_WORKER_FUNCTION_NAME;

  if (!functionName) {
    throw new Error("ZCG_KNOWLEDGE_ANSWER_WORKER_FUNCTION_NAME is not configured.");
  }

  const result = await lambda.send(
    new InvokeCommand({
      FunctionName: functionName,
      InvocationType: "Event",
      Payload: Buffer.from(JSON.stringify({ jobId }))
    })
  );

  if (result.StatusCode && result.StatusCode >= 300) {
    throw new Error(`Knowledge answer worker invoke failed with status ${result.StatusCode}.`);
  }

  return {
    functionName,
    invocationStatusCode: result.StatusCode ?? null
  };
}
