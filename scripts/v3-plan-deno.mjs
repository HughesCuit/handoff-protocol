// Deno-side migration planner used by the v3 migration evaluator to verify
// Node/Deno output equality. Reads a migration-inputs JSON file (path given
// as the first argument), runs the shared pure planner, and prints the
// normalized plan outputs as JSON on stdout.
import { planV2ToV3Migration } from "./migrate-v3.mjs";

const inputsPath = Deno.args[0];
if (!inputsPath) {
  console.error("usage: v3-plan-deno.mjs <inputs.json>");
  Deno.exit(2);
}
const inputs = JSON.parse(await Deno.readTextFile(inputsPath));
const plan = planV2ToV3Migration(inputs);
console.log(JSON.stringify({
  needed: plan.needed,
  reason: plan.reason ?? null,
  outputs: plan.outputs ?? null,
}));
