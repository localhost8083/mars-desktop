import { resolveEvalEngineValue } from "@mars/hosts/eval-engine";
import type { EvalEngine } from "@mars/hosts/eval-engine";

export type { EvalEngine } from "@mars/hosts/eval-engine";

export function resolveEvalEngine(env: NodeJS.ProcessEnv = process.env): EvalEngine {
  return resolveEvalEngineValue(env.MARS_EVAL_ENGINE);
}
