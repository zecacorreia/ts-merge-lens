import ts from 'typescript';
import type { LimitationSummary } from '../../limitations.js';
import type { ChangedUnit } from '../../scenario/changed-units.js';
import { displayElement, observes } from '../../state/element.js';
import type { StateElement } from '../../state/element.js';
import type { CallNode } from '../calls.js';
import { AnalysisContext, entryFrame } from '../context.js';
import type { Activation, AnalysisInput, Label } from '../context.js';
import { frameForCall } from '../frames.js';
import { OaState } from '../oa/flow.js';
import type { Side } from '../oa/flow.js';
import { FlowWalker } from '../walker.js';
import { SummaryTable } from './summary.js';

/** A place in the Merge attributed to one side. */
export interface Endpoint {
  side: Side;
  node: ts.Node;
  functionName: string;
  /** Call sites followed from the analysed unit to reach the node, outermost first. */
  callChain: readonly string[];
}

/**
 * - DF: `source` wrote `element`, and `sink`, a read by the other side, may observe that value.
 * - CF: `sink`, a statement of one side, only runs under a condition that `source` influences:
 *   either the condition itself was changed by the source's side (no `element`), or it reads
 *   `element`, which the source wrote. `predicate` is the condition.
 */
export interface FlowFinding {
  type: 'DF' | 'CF';
  element?: string;
  source: Endpoint;
  sink: Endpoint;
  predicate?: { node: ts.Node; functionName: string };
  lowConfidence: boolean;
}

export interface FlowInput extends AnalysisInput {
  units: readonly ChangedUnit[];
}

export interface FlowResult {
  findings: FlowFinding[];
  limitations: LimitationSummary[];
  skipped: string[];
}

export function analyzeFlow(input: FlowInput, context = new AnalysisContext(input)): FlowResult {
  return new FlowAnalysis(context, input, new SummaryTable(context)).run();
}

type FlowActivation = Activation<OaState>;

interface Read {
  element: StateElement;
}

/** Something that can influence a condition: a write that reaches it, or its own change. */
interface CfSource {
  side: Side;
  endpoint: Endpoint;
  element?: StateElement;
}

interface Predicate {
  owner: ts.Node;
  sources: CfSource[];
  condition: { node: ts.Node; functionName: string } | undefined;
  /** A changed statement already reported under this condition; nested ones are not repeated. */
  reported: ts.Node | undefined;
}

class FlowAnalysis extends FlowWalker<OaState> {
  private readonly findings = new Map<string, FlowFinding>();
  private readonly predicates: Predicate[] = [];
  private pending: Predicate | undefined;
  private collector: Read[] | undefined;

  constructor(
    context: AnalysisContext,
    private readonly input: FlowInput,
    private readonly summaries: SummaryTable,
  ) {
    super(context);
  }

  run(): FlowResult {
    const skipped: string[] = [];
    for (const unit of this.input.units) {
      const fn = this.ctx.locate(unit);
      if (!fn) {
        skipped.push(unit.key);
        continue;
      }
      const entry: FlowActivation = {
        fn,
        name: unit.name,
        frame: entryFrame(),
        context: 'Base',
        depth: 0,
        callChain: [],
        returns: [],
        jumpTargets: [],
        stack: new Set([fn]),
      };
      this.predicates.length = 0;
      this.runBody(entry, new OaState());
    }
    return {
      findings: [...this.findings.values()],
      limitations: this.ctx.limits.summary(),
      skipped,
    };
  }

  protected join(a: OaState, b: OaState): OaState {
    return OaState.join(a, b);
  }

  protected unreachable(): OaState {
    const state = new OaState();
    state.dead = true;
    return state;
  }

  // ---- data flow -------------------------------------------------------------------------

  protected onWrite(raw: StateElement, site: ts.Node, act: FlowActivation, st: OaState): void {
    const element = this.ctx.resolver.rebase(raw, act.frame, 'write');
    if (!element) return;
    const label = this.ctx.labelAt(site, act.context);
    if (label === 'Base') {
      st.killCovered(element);
      return;
    }
    st.removeCovered(label === 'L' ? 'R' : 'L', element);
    st.add({
      side: label,
      element,
      node: site,
      functionName: act.name,
      callChain: act.callChain,
    });
  }

  protected override onRead(raw: StateElement, site: ts.Node, act: FlowActivation, st: OaState) {
    const element = this.ctx.resolver.rebase(raw, act.frame, 'reference');
    if (!element) return;
    const label = this.ctx.labelAt(site, act.context);
    this.observe(element, label, { node: site, functionName: act.name, chain: act.callChain }, st);
  }

  /** A read of `element` by code labelled `label`: collect it, and check it against writes. */
  private observe(
    element: StateElement,
    label: Label,
    where: { node: ts.Node; functionName: string; chain: readonly string[] },
    st: OaState,
  ): void {
    this.collector?.push({ element });
    if (label === 'Base') return;
    const opposite: Side = label === 'L' ? 'R' : 'L';
    for (const write of st.writes(opposite).values()) {
      if (!observes(element, write.element)) continue;
      this.record({
        type: 'DF',
        element: displayElement(element),
        source: write,
        sink: {
          side: label,
          node: where.node,
          functionName: where.functionName,
          callChain: where.chain,
        },
        lowConfidence: element.lowConfidence || write.element.lowConfidence,
      });
    }
  }

  // ---- calls: summaries ------------------------------------------------------------------

  protected onCall(node: CallNode, act: FlowActivation, st: OaState): void {
    const resolved = this.ctx.calls.resolve(node);
    if (resolved.kind === 'external') return;
    if (resolved.kind === 'unresolved') {
      this.ctx.limits.add('unresolved-call', node);
      return;
    }
    const callLabel = this.ctx.labelAt(node, act.context);
    const here = `${act.name} (${this.ctx.describe(node)})`;
    const changedSides = new Set<Side>();

    for (const target of resolved.targets) {
      const frame = frameForCall(this.ctx, node, target, act.frame);
      const accesses = [...this.summaries.get(target).accesses.values()].flatMap((access) => {
        const element = this.ctx.resolver.rebase(
          access.element,
          frame,
          access.kind === 'write' ? 'write' : 'reference',
        );
        if (!element) return [];
        const label = access.label !== 'Base' ? access.label : callLabel;
        if (access.label !== 'Base') changedSides.add(access.label === 'L' ? 'L' : 'R');
        return [{ access, element, label }];
      });
      // The order inside the callee is unknown: reads see the state before its writes.
      for (const { access, element, label } of accesses) {
        if (access.kind !== 'read') continue;
        this.observe(
          element,
          label,
          {
            node: access.node,
            functionName: access.functionName,
            chain: [...act.callChain, here, ...access.via],
          },
          st,
        );
      }
      for (const { access, element, label } of accesses) {
        if (access.kind !== 'write' || label === 'Base') continue;
        // A summary says "may write": it adds a live write but never kills one.
        st.add({
          side: label,
          element,
          node: access.node,
          functionName: access.functionName,
          callChain: [...act.callChain, here, ...access.via],
        });
      }
    }

    for (const side of changedSides) {
      this.sink(node, side, act);
    }
  }

  // ---- control flow ----------------------------------------------------------------------

  protected override condition(
    condition: ts.Expression | undefined,
    owner: ts.Node,
    act: FlowActivation,
    st: OaState,
  ): void {
    const reads: Read[] = [];
    const outer = this.collector;
    this.collector = reads;
    super.condition(condition, owner, act, st);
    this.collector = outer;
    outer?.push(...reads);

    const label = this.ctx.labelAt(owner, act.context);
    const endpoint = (side: Side): Endpoint => ({
      side,
      node: owner,
      functionName: act.name,
      callChain: act.callChain,
    });
    const sources: CfSource[] = [];
    if (label !== 'Base') sources.push({ side: label, endpoint: endpoint(label) });
    for (const side of ['L', 'R'] as const) {
      if (side === label) continue;
      for (const { element } of reads) {
        for (const write of st.writes(side).values()) {
          if (observes(element, write.element)) sources.push({ side, endpoint: write, element });
        }
      }
    }
    this.pending = {
      owner,
      sources,
      condition: { node: owner, functionName: act.name },
      reported: undefined,
    };
  }

  protected override controlled(owner: ts.Node, _act: FlowActivation, run: () => void): void {
    const entry =
      this.pending?.owner === owner
        ? this.pending
        : { owner, sources: [], condition: undefined, reported: undefined };
    this.pending = undefined;
    this.predicates.push(entry);
    try {
      run();
    } finally {
      this.predicates.pop();
    }
  }

  protected override statement(node: ts.Statement, act: FlowActivation, st: OaState): void {
    if (st.dead) return;
    if (this.predicates.length > 0 && !ts.isBlock(node)) {
      const label = this.ctx.labelAt(node, act.context);
      if (label !== 'Base') this.sink(node, label, act);
    }
    super.statement(node, act, st);
    // Leaving a statement ends the "already reported" scope of everything inside it.
    for (const predicate of this.predicates) {
      if (
        predicate.reported &&
        predicate.reported.pos >= node.pos &&
        predicate.reported.end <= node.end
      ) {
        predicate.reported = undefined;
      }
    }
  }

  /** `node`, changed by `side`, runs under every enclosing condition: report those influenced by the other side. */
  private sink(node: ts.Node, side: Side, act: FlowActivation): void {
    for (const predicate of this.predicates) {
      if (predicate.reported) continue;
      let reported = false;
      for (const source of predicate.sources) {
        if (source.side === side) continue;
        reported = true;
        this.record({
          type: 'CF',
          ...(source.element ? { element: displayElement(source.element) } : {}),
          source: source.endpoint,
          sink: { side, node, functionName: act.name, callChain: act.callChain },
          ...(predicate.condition ? { predicate: predicate.condition } : {}),
          lowConfidence: source.element?.lowConfidence ?? false,
        });
      }
      if (reported) predicate.reported = node;
    }
  }

  private record(finding: FlowFinding): void {
    const where = (e: Endpoint): string =>
      `${e.side}@${e.node.getSourceFile().fileName}:${e.node.pos}`;
    const key = `${finding.type}|${where(finding.source)}>${where(finding.sink)}|${finding.element ?? ''}`;
    if (!this.findings.has(key)) this.findings.set(key, finding);
  }
}
