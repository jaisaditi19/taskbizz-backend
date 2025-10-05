import "dotenv/config";
import { Queue } from "bullmq";
import { bullConnection } from "../src/utils/redisClient";

async function main() {
  const sendQueue = new Queue("send-email", bullConnection as any);

  await sendQueue.add("send-occurrence-email", {
    orgId: "1",
    dbName: "TestAJ",
    occurrenceId: "a6546451-ba8c-47d2-9a4b-91bfd26ca842",
  });

  console.log("Test job enqueued");
  await sendQueue.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
