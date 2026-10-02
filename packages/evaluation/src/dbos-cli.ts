import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  configureDbosReferenceCrash,
  dbosReferenceInput,
  runDbosReferenceSubset,
} from "./dbos-reference.js";
import { defaultEvaluationWorkload } from "./workload.js";

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

const systemDatabaseUrl = argument("--database-url") ?? process.env.DBOS_SYSTEM_DATABASE_URL;
if (!systemDatabaseUrl) throw new Error("Set DBOS_SYSTEM_DATABASE_URL or pass --database-url");
const workflowId = argument("--workflow-id") ?? "agentflow-evaluation-reference-v1";
const crashAfter = argument("--crash-after") ?? null;
configureDbosReferenceCrash(crashAfter);
const output = await runDbosReferenceSubset({
  systemDatabaseUrl,
  workflowId,
  input: dbosReferenceInput(defaultEvaluationWorkload),
});
const invocationDirectory = process.env.INIT_CWD ?? process.cwd();
const outputPath = resolve(invocationDirectory, argument("--output") ?? "evaluation-results/dbos-reference.json");
await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(output, null, 2)}\n`, "utf8");
console.log(JSON.stringify({ workflowId, outputPath, steps: output.steps.length }, null, 2));
