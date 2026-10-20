import type { LimitationSummary } from '../../limitations.js';
import type { ChangedUnit } from '../../scenario/changed-units.js';
import type { FunctionWithBody } from '../../scenario/functions.js';
import { displayElement, overlaps } from '../../state/element.js';
import type { StateElement } from '../../state/element.js';
import type { CallNode } from '../calls.js';
import { AnalysisContext, entryFrame } from '../context.js';
import type { Activation, AnalysisInput } from '../context.js';
import { frameForCall, isDeclaredWithin } from '../frames.js';
import { FlowWalker } from '../walker.js';
import type ts from 'typescript';
import { OaState } from './flow.js';
import type { Side, WriteSite } from './flow.js';

/** `earlier` wrote an element and `later`, executed afterwards, overwrote it. */
export interface OaFinding {
  /** The overwritten element, as written by `later`. */
  element: string;
  earlier: WriteSite;
  later: WriteSite;
  lowConfidence: boolean;
}

export interface OaInput extends AnalysisInput {
  units: readonly ChangedUnit[];
  /** Maximum call nesting followed from a unit; 0 gives the intraprocedural analysis. */
  depth: number;
}

export interface OaResult {
  findings: OaFinding[];
  limitations: LimitationSummary[];
  /** Units that could not be located in the program, as `file#name`. */
  skipped: string[];
}

/** Upper bound on callee bodies inlined per unit, to stop call-graph blow-up. */
const MAX_INLINED_CALLS = 5000;

type OaActivation = Activation<OaState>;

export function analyzeOa(input: OaInput, context = new AnalysisContext(input)): OaResult {
  return new OaAnalysis(context, input).run();
}

class OaAnalysis extends FlowWalker<OaState> {
  private readonly findings = new Map<string, OaFinding>();
  private inlinedCalls = 0;

  constructor(
    context: AnalysisContext,
    private readonly input: OaInput,
  ) {
    super(context);
  }

  run(): OaResult {
    const skipped: string[] = [];
    for (const unit of this.input.units) {
      const fn = this.ctx.locate(unit);
      if (!fn) {
        skipped.push(unit.key);
        continue;
      }
      this.inlinedCalls = 0;
      const entry: OaActivation = {
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

  // ---- writes ----------------------------------------------------------------------------

  /** Applies the OA rules to a write of `raw` made by the statement containing `site`. */
  protected onWrite(raw: StateElement, site: ts.Node, act: OaActivation, st: OaState): void {
    const element = this.ctx.resolver.rebase(raw, act.frame, 'write');
    if (!element) return;
    const label = this.ctx.labelAt(site, act.context);
    if (label === 'Base') {
      st.killCovered(element);
      return;
    }
    const later: WriteSite = {
      side: label,
      element,
      node: site,
      functionName: act.name,
      callChain: act.callChain,
    };
    const opposite: Side = label === 'L' ? 'R' : 'L';
    for (const earlier of st.writes(opposite).values()) {
      if (overlaps(earlier.element, element)) this.record(earlier, later);
    }
    st.removeCovered(opposite, element);
    st.add(later);
  }

  private record(earlier: WriteSite, later: WriteSite): void {
    const where = (s: WriteSite): string =>
      `${s.side}@${s.node.getSourceFile().fileName}:${s.node.pos}`;
    const key = `${where(earlier)}>${where(later)}>${displayElement(later.element)}`;
    if (this.findings.has(key)) return;
    this.findings.set(key, {
      element: displayElement(later.element),
      earlier,
      later,
      lowConfidence: earlier.element.lowConfidence || later.element.lowConfidence,
    });
  }

  // ---- calls -----------------------------------------------------------------------------

  /** Inlines the body of the called function(s), if they can be resolved and the limits allow. */
  protected onCall(node: CallNode, act: OaActivation, st: OaState): void {
    const resolved = this.ctx.calls.resolve(node);
    if (resolved.kind === 'external') return;
    if (resolved.kind === 'unresolved') {
      this.ctx.limits.add('unresolved-call', node);
      return;
    }
    if (act.depth >= this.input.depth) {
      this.ctx.limits.add('depth-limit', node);
      return;
    }
    const [only, ...others] = resolved.targets;
    if (only && others.length === 0) {
      this.inline(only, node, act, st);
      return;
    }
    // Dynamic dispatch: any implementation may run, so join the outcome of each one.
    let joined: OaState | undefined;
    for (const target of resolved.targets) {
      const branch = st.clone();
      this.inline(target, node, act, branch);
      joined = joined ? OaState.join(joined, branch) : branch;
    }
    if (joined) st.assign(joined);
  }

  private inline(target: FunctionWithBody, node: CallNode, act: OaActivation, st: OaState): void {
    if (act.stack.has(target)) return; // recursion: the cycle was already entered
    if (this.inlinedCalls >= MAX_INLINED_CALLS) {
      this.ctx.limits.add('budget', node);
      return;
    }
    this.inlinedCalls++;

    const callee: OaActivation = {
      fn: target,
      name: this.ctx.functionName(target),
      frame: frameForCall(this.ctx, node, target, act.frame),
      context: this.ctx.labelAt(node, act.context),
      depth: act.depth + 1,
      callChain: [...act.callChain, `${act.name} (${this.ctx.describe(node)})`],
      returns: [],
      jumpTargets: [],
      stack: act.stack,
    };
    act.stack.add(target);
    try {
      this.runBody(callee, st);
    } finally {
      act.stack.delete(target);
    }
    // Locals of the callee do not outlive the call.
    st.dropRoots((root) => root !== 'this' && isDeclaredWithin(root, target));
  }
}
