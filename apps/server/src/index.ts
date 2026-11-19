import { configErrors } from "./lib/config";

const errors = configErrors();
if (errors.length) {
  console.error("Amuse can't start:\n" + errors.map((e) => "  - " + e).join("\n") + "\nSee .env.example for every setting.");
  process.exit(1);
}

const path = await import("node:path");
const { runMigrations } = await import("@amuse/db");
await runMigrations(process.env.AMUSE_MIGRATIONS_DIR ?? path.resolve(import.meta.dirname, "../../../lib/db/migrations"));

const { default: app } = await import("./app");
const { logger } = await import("./lib/logger");
const { startScheduler } = await import("./agent/scheduler");
const { MODELS } = await import("./lib/config");

const port = Number(process.env.PORT ?? 3000);
// Docker sets HOST=0.0.0.0 inside the container; docker-compose.yml publishes the port on 127.0.0.1 only.
const host = process.env.HOST ?? "127.0.0.1";
const { hasActionEvidence, interruptedRun, isLoopback, recoveryDecision, scheduledRunState, skippedOccurrence } = await import("./agent/robustness");
const { historyToolNames, replayParts } = await import("./agent/history");
if (process.env.AMUSE_CONTAINER === "1")
  logger.info({ host }, "Running in a container. Amuse has no login, so publish its port on 127.0.0.1 only (docker-compose.yml does).");
else if (!isLoopback(host))
  logger.warn(
    { host },
    "WARNING: Amuse has no authentication. Non-loopback binding exposes full control; restrict access with a loopback port mapping or firewall.",
  );
const { db, activityTable, agentsTable, chatsTable, messagesTable, runsTable, approvalsTable, scheduledTasksTable, settingsTable } = await import("@amuse/db");
const { and, eq, inArray } = await import("drizzle-orm");
await db.transaction(async (tx) => {
  const interrupted = await tx
    .select()
    .from(runsTable)
    .where(inArray(runsTable.status, ["running", "waiting_approval"]));
  const interruptedIds = new Set(interrupted.map((run) => run.id));
  const jobs = await tx.select().from(scheduledTasksTable);
  for (const job of jobs) {
    const state = scheduledRunState(job.lastResult);
    if (!state || state.kind !== "run" || !interruptedIds.has(state.runId)) continue;
    const approvals = await tx.select().from(approvalsTable).where(eq(approvalsTable.runId, state.runId));
    const activity = await tx.select().from(activityTable).where(eq(activityTable.runId, state.runId));
    const messages = await tx.select().from(messagesTable).where(eq(messagesTable.runId, state.runId));
    const names = messages.flatMap((message) => [
      ...historyToolNames(replayParts(message.parts)),
      ...message.parts.flatMap((part) =>
        part && typeof part === "object" && "type" in part && part.type === "tool_attempt" && "names" in part && Array.isArray(part.names)
          ? part.names.filter((name): name is string => typeof name === "string")
          : [],
      ),
    ]);
    const acted = hasActionEvidence(approvals, activity, names);
    const decision = recoveryDecision(job.lastResult, acted);
    if (!decision) continue;
    if (!decision.retry) {
      const [settings] = await tx.select({ timezone: settingsTable.timezone }).from(settingsTable).where(eq(settingsTable.userId, job.userId));
      const skipped = skippedOccurrence(job, acted, settings?.timezone ?? "America/Los_Angeles");
      await tx.update(scheduledTasksTable).set(skipped.update).where(eq(scheduledTasksTable.id, job.id));
      let [main] = await tx
        .select()
        .from(chatsTable)
        .where(and(eq(chatsTable.userId, job.userId), eq(chatsTable.kind, "main")));
      if (!main) [main] = await tx.insert(chatsTable).values({ userId: job.userId, kind: "main", title: "Main" }).returning();
      // The notice and non-run marker commit together, preventing duplicate notices on restart.
      await tx.insert(messagesTable).values({
        userId: job.userId,
        chatId: main.id,
        role: "assistant",
        content: skipped.message,
        proactive: true,
        parts: [{ type: "restart_skipped", taskId: job.id, runId: state.runId }],
      });
      continue;
    }
    await tx
      .update(scheduledTasksTable)
      .set({
        enabled: decision.retry,
        ...(decision.retry ? { nextRunAt: new Date() } : {}),
        lastResult: decision.lastResult,
      })
      .where(eq(scheduledTasksTable.id, job.id));
  }
  await tx
    .update(runsTable)
    .set(interruptedRun())
    .where(inArray(runsTable.status, ["running", "waiting_approval"]));
  await tx.update(approvalsTable).set({ status: "expired", resolvedAt: new Date() }).where(eq(approvalsTable.status, "pending"));
  await tx.update(agentsTable).set({ status: "Idle" });
});

if (process.env.AMUSE_MCP_CONFIG) {
  const { startMcp } = await import("./agent/mcp");
  const { registerTools } = await import("./agent/loop");
  registerTools(await startMcp());
}

app.listen(port, host, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }
  logger.info({ url: `http://localhost:${port}`, model: MODELS.agent }, "Amuse is running");
  startScheduler();
});
