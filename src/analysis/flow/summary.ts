import ts from 'typescript';
import { elementKey } from '../../state/element.js';
import type { StateElement } from '../../state/element.js';
import type { Frame } from '../../state/resolve.js';
import { OaState } from '../oa/flow.js';
import type { CallNode } from '../calls.js';
import { AnalysisContext, entryFrame } from '../context.js';
import type { Activation, Label } from '../context.js';
import { frameForCall, isDeclaredWithin } from '../frames.js';
import { FlowWalker } from '../walker.js';
import type { FunctionWithBody } from '../../scenario/functions.js';

export type AccessKind = 'read' | 'write';

/** A read or write of a state element somewhere in a function or the functions it calls. */
export interface Access {
  kind: AccessKind;
  /** In terms of the function the summary belongs to (its `this`, parameters, globals). */
  element: StateElement;
  /**
   * Who changed the statement that accesses: Left, Right, or Base. A Base access inherits the
   * label of the call site when the summary is applied (and again at every call level above).
   */
  label: Label;
  /** The access itself, wherever it is (possibly in a callee). */
  node: ts.Node;
  functionName: string;
  /** Call sites from the summarised function down to the access, outermost first. */
  via: readonly string[];
}

/** Flow-insensitive facts about a function: the set of accesses it may perform. */
export class Summary {
  readonly accesses = new Map<string, Access>();

  /** Returns whether the access was new. */
  add(access: Access): boolean {
    const key = `${access.kind}|${elementKey(access.element)}|${access.label}`;
    if (this.accesses.has(key)) return false;
    this.accesses.set(key, access);
    return true;
  }
}

interface CallEdge {
  node: CallNode;
  /** Label of the statement containing the call, as seen from the calling function. */
  label: Label;
  targets: Array<{ fn: FunctionWithBody; frame: Frame }>;
}

interface Facts {
  accesses: Access[];
  edges: CallEdge[];
}

/** Keeps elements finite across recursion: deeper paths are cut to this many segments. */
const MAX_PATH = 4;
/** Upper bound on functions summarised in one run. */
const MAX_FUNCTIONS = 3000;

/** Collects the local accesses and call edges of one function. */
class FactsWalker extends FlowWalker<OaState> {
  private facts: Facts = { accesses: [], edges: [] };

  constructor(
    context: AnalysisContext,
    private readonly self: FunctionWithBody,
  ) {
    super(context);
  }

  collect(): Facts {
    this.facts = { accesses: [], edges: [] };
    const name = this.ctx.functionName(this.self);
    const act: Activation<OaState> = {
      fn: this.self,
      name,
      frame: entryFrame(),
      context: 'Base',
      depth: 0,
      callChain: [],
      returns: [],
      jumpTargets: [],
      stack: new Set([this.self]),
    };
    this.runBody(act, new OaState());
    return this.facts;
  }

  protected join(a: OaState, b: OaState): OaState {
    return OaState.join(a, b);
  }

  protected unreachable(): OaState {
    const state = new OaState();
    state.dead = true;
    return state;
  }

  protected override onRead(raw: StateElement, site: ts.Node, act: Activation<OaState>): void {
    this.access('read', raw, site, act);
  }

  protected onWrite(raw: StateElement, site: ts.Node, act: Activation<OaState>): void {
    this.access('write', raw, site, act);
  }

  private access(kind: AccessKind, element: StateElement, site: ts.Node, act: Activation<OaState>) {
    this.facts.accesses.push({
      kind,
      element,
      label: this.ctx.labelAt(site, 'Base'),
      node: site,
      functionName: act.name,
      via: [],
    });
  }

  protected onCall(node: CallNode, act: Activation<OaState>): void {
    const resolved = this.ctx.calls.resolve(node);
    if (resolved.kind === 'external') return;
    if (resolved.kind === 'unresolved') {
      this.ctx.limits.add('unresolved-call', node);
      return;
    }
    this.facts.edges.push({
      node,
      label: this.ctx.labelAt(node, 'Base'),
      targets: resolved.targets.map((fn) => ({
        fn,
        frame: frameForCall(this.ctx, node, fn, act.frame),
      })),
    });
  }
}

/**
 * Function summaries over the call graph. Each function's summary holds its own accesses plus
 * those of everything it may call, rewritten to the caller's terms; recursive groups of functions
 * (strongly connected components) are solved together by iterating to a fixed point.
 */
export class SummaryTable {
  private readonly summaries = new Map<FunctionWithBody, Summary>();
  private readonly facts = new Map<FunctionWithBody, Facts>();
  // Tarjan's algorithm state
  private readonly index = new Map<FunctionWithBody, number>();
  private readonly lowlink = new Map<FunctionWithBody, number>();
  private readonly onStack = new Set<FunctionWithBody>();
  private readonly stack: FunctionWithBody[] = [];
  private counter = 0;

  constructor(private readonly ctx: AnalysisContext) {}

  get(fn: FunctionWithBody): Summary {
    if (!this.summaries.has(fn)) this.connect(fn);
    return this.summaries.get(fn) ?? new Summary();
  }

  private factsOf(fn: FunctionWithBody): Facts {
    let facts = this.facts.get(fn);
    if (!facts) {
      facts = new FactsWalker(this.ctx, fn).collect();
      this.facts.set(fn, facts);
    }
    return facts;
  }

  /** Tarjan: summarise `fn` after everything it calls, solving each recursive group at once. */
  private connect(fn: FunctionWithBody): void {
    this.index.set(fn, this.counter);
    this.lowlink.set(fn, this.counter);
    this.counter++;
    this.stack.push(fn);
    this.onStack.add(fn);

    for (const edge of this.factsOf(fn).edges) {
      for (const { fn: callee } of edge.targets) {
        if (this.summaries.has(callee)) continue;
        if (!this.index.has(callee)) {
          if (this.facts.size >= MAX_FUNCTIONS) {
            this.ctx.limits.add('budget', edge.node);
            continue;
          }
          this.connect(callee);
          this.lowlink.set(fn, Math.min(this.lowlink.get(fn) ?? 0, this.lowlink.get(callee) ?? 0));
        } else if (this.onStack.has(callee)) {
          this.lowlink.set(fn, Math.min(this.lowlink.get(fn) ?? 0, this.index.get(callee) ?? 0));
        }
      }
    }

    if (this.lowlink.get(fn) === this.index.get(fn)) {
      const component: FunctionWithBody[] = [];
      let member: FunctionWithBody | undefined;
      do {
        member = this.stack.pop();
        if (!member) break;
        this.onStack.delete(member);
        component.push(member);
      } while (member !== fn);
      this.solve(component);
    }
  }

  private solve(component: readonly FunctionWithBody[]): void {
    for (const fn of component) {
      const summary = new Summary();
      for (const access of this.factsOf(fn).accesses) summary.add(access);
      this.summaries.set(fn, summary);
    }
    let changed = true;
    while (changed) {
      changed = false;
      for (const fn of component) {
        const summary = this.summaries.get(fn);
        if (!summary) continue;
        for (const edge of this.factsOf(fn).edges) {
          for (const { fn: callee, frame } of edge.targets) {
            const calleeSummary = this.summaries.get(callee);
            if (!calleeSummary) continue;
            for (const access of calleeSummary.accesses.values()) {
              const composed = this.compose(access, edge, callee, frame, fn);
              if (composed && summary.add(composed)) changed = true;
            }
          }
        }
      }
    }
  }

  /** The access of a callee as seen from the calling function. */
  private compose(
    access: Access,
    edge: CallEdge,
    callee: FunctionWithBody,
    frame: Frame,
    caller: FunctionWithBody,
  ): Access | undefined {
    // A local of the callee dies with the call. Check before rewriting: in recursion the
    // caller's parameters are the callee's parameters, and must survive.
    const original = access.element.root;
    if (original !== 'this' && !frame.params.has(original) && isDeclaredWithin(original, callee)) {
      return undefined;
    }
    const rebased = this.ctx.resolver.rebase(
      access.element,
      frame,
      access.kind === 'write' ? 'write' : 'reference',
    );
    if (!rebased) return undefined;
    const element: StateElement =
      rebased.path.length > MAX_PATH
        ? { ...rebased, path: rebased.path.slice(0, MAX_PATH), lowConfidence: true }
        : rebased;
    return {
      ...access,
      element,
      label: access.label !== 'Base' ? access.label : edge.label,
      via: [`${this.ctx.functionName(caller)} (${this.ctx.describe(edge.node)})`, ...access.via],
    };
  }
}
