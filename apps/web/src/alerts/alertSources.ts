import { type ChartIndicator, scriptInputs } from '@tradingnerd/chart';
import { type CompileOptions, compileCached, type ScriptProgram } from '@tradingnerd/pine';
import { type AlertCondition, type AlertScript, conditionLabel } from './alertModel';

/** A script an alert can be made on: one on the chart that makes alert events. */
export interface AlertSource {
  /** The chart indicator's id (the dialog's choice). */
  id: string;
  title: string;
  script: AlertScript;
  /** The Condition dropdown's choices for it, in TradingView's order. */
  conditions: readonly AlertCondition[];
}

/**
 * What the Create Alert dialog offers for a script (Help Center, Alerts on alert() function; Pine
 * docs, Alerts): an indicator's "Any alert() function call" when it calls alert(), then each of
 * its alertcondition() calls; a strategy's order fills, with or without its alert() calls.
 * alertcondition() in a strategy makes no alert ("alerts cannot be created from them").
 */
export function conditionsOf(program: ScriptProgram): AlertCondition[] {
  if (program.strategy) {
    return program.hasAlertCalls
      ? [{ kind: 'fills-calls' }, { kind: 'fills' }, { kind: 'calls-only' }]
      : [{ kind: 'fills' }];
  }
  return [
    ...(program.hasAlertCalls ? [{ kind: 'calls' } as const] : []),
    ...program.alertConditions.map((c, index) => ({
      kind: 'condition' as const,
      index,
      title: c.title,
    })),
  ];
}

/** The chart's scripts that make alert events, as the dialog lists them. */
export function alertSources(
  indicators: readonly ChartIndicator[],
  options: CompileOptions & { revision?: string },
): AlertSource[] {
  const out: AlertSource[] = [];
  for (const indicator of indicators) {
    if (indicator.kind !== 'script' || !indicator.script) continue;
    const compiled = compileCached(indicator.script.source, options);
    if (!compiled.ok) continue;
    const conditions = conditionsOf(compiled.program);
    if (conditions.length === 0) continue;
    const inputs = indicator.settings.inputs;
    const described = compiled.program.describe(scriptInputs(compiled.program, inputs));
    const title = described.shorttitle || described.title || 'Script';
    out.push({
      id: indicator.id,
      title,
      script: { title, source: indicator.script.source, inputs },
      conditions,
    });
  }
  return out;
}

/** A condition's key in the dialog's dropdown. */
export const conditionKey = (condition: AlertCondition): string =>
  condition.kind === 'condition' ? `condition:${condition.index}` : condition.kind;

/** The dropdown's options for a list of conditions. */
export const conditionOptions = (conditions: readonly AlertCondition[]) =>
  conditions.map((condition) => ({
    value: conditionKey(condition),
    label: conditionLabel(condition),
  }));
