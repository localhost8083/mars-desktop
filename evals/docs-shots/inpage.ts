import { browserScript } from "@mars/cdp";
import { evalIn } from "@mars/behaviors";
import type { Surface, EvaluateOptions } from "@mars/cdp";
export type InPageOptions = EvaluateOptions;

/** Execute a checked browser callback with one explicit argument. */
export function inPage<A, R>(surface: Surface, callback: (args: A) => R, args: A, options: InPageOptions = {}): Promise<Awaited<R>> {
  return evalIn(surface, browserScript(callback, [args]), options);
}
