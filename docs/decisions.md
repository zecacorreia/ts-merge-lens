# Decisions

Decisions that diverge from, or fill gaps in, the reference papers and the project prompt.
Each entry: what was decided, why, and what it costs.

## Phase 1

### D1. Left is the first parent, Right the second

For a merge commit `M = merge(P1, P2)`, `Left = P1` (the branch the merge was made on) and
`Right = P2` (the branch merged in). Base is the single merge-base of the parents. The papers
treat Left/Right symmetrically; the choice only affects labels in the report.

### D2. Which merges are discarded

Discarded, with a reason code: fewer than two parents (`not-a-merge`), more than two (`octopus`),
no common ancestor, one parent ancestor of the other (`fast-forward`), more than one merge base
(`criss-cross`) and merges that git itself cannot merge cleanly (`textual-conflict`).

The textual-conflict test replays the merge with `git merge-tree --write-tree` (git >= 2.38)
instead of trusting the recorded commit: a conflicted merge that a developer resolved by hand is
not a "silent" merge, so it is excluded even though the recorded tree looks clean.

We do **not** discard a merge whose recorded tree differs from the automatic merge when the
automatic merge is clean (the developer edited after merging, or used another strategy/option). The
analysis runs on the recorded Merge, and the report flags `matchesAutomaticMerge: false`. Discarding
would lose data we cannot judge; flagging lets the evaluation exclude them later.

### D3. Trees are exported through a private index

Base/Left/Right/Merge are materialised with `GIT_INDEX_FILE=<tmp> git read-tree` +
`git checkout-index --prefix`, so the user's repository (index, worktree, `HEAD`) is never touched
and no `git worktree` metadata is left behind. Submodules are not populated.

### D4. Experimental unit = named function changed by both sides

A unit is a function present in Base, Left, Right and Merge whose structural hash differs from
Base in **both** Left and Right. Functions are identified by qualified name
(`Class.method`, `get Class.prop`, `namespace.fn`, `Class.constructor`); overload signatures
without a body are skipped; functions nested in other functions belong to their parent; object
literal methods are not extracted. File renames are not followed (a renamed file looks like a
deletion plus an addition). Duplicate qualified names get a `#2` suffix.

### D5. Structural hashes instead of text

Equality of code is decided by an AST hash that ignores whitespace, comments, semicolons and string
quote style, and includes the attributes `forEachChild` does not expose as nodes (prefix/postfix
operators, `let`/`const`, heritage keyword, `import type`). This is what lets annotation work "by
AST position, not by line".

### D6. Annotation granularity: statement-level "units"

The prompt asks for marking "each node/instruction". We mark **units**: statements, blocks,
clauses and declarations (see `src/ast/units.ts`). Expressions inherit the origin of the innermost
enclosing unit (`FileAnnotation.originOf`). Reason: the OA algorithm of Barbosa et al. reasons over
instructions, and sub-statement marking would need an expression-level diff that the first
analyses do not use.

Origin of a unit of the Merge, with `shallow` meaning "the unit ignoring nested units":

1. shallow-equal to its aligned Base counterpart -> `Base`;
2. else shallow-equal to its Left counterpart only -> `L`; to its Right counterpart only -> `R`;
3. else (equal to both, or to neither: a textual combination of both sides) -> `LR`.

`LR` is an addition to the three labels in the prompt, needed for changes made identically by both
sides and for statements git combined from both.

The shallow comparison matters: an `if` whose condition is untouched stays `Base` when a statement
inside it is added by Left; the new statement is `L`.

### D7. Tree alignment

Alignment of two versions descends the unit tree: identical sibling subsequences are matched by an
LCS over structural hashes; between two LCS anchors, leftover siblings are paired in order when
they have the same kind and the same declared name (or, when unnamed, a Dice similarity of their
tokens >= 0.5), then aligned recursively. No move detection: a moved statement is reported as
removed plus added. This is a deliberate simplification of GumTree-style matching.

### D8. Removed units

`RemovedUnit`s are Base units with no Merge counterpart, keeping only the outermost one of a removed
subtree, with `removedBy` computed from the Base->Left and Base->Right alignments. An empty
`removedBy` means the alignments disagree (an alignment artefact, not a real removal).

### D9. Build conflicts

A diagnostic is a build conflict when the Merge has more occurrences of its signature
(`file | code | message`, position excluded) than any single other version. Positions are ignored
because they shift between versions. Consequence: errors shared by every version, notably
`Cannot find module` when `node_modules` is absent from the temporary checkouts, never produce
alerts; they can however hide type errors that cascade from the missing types. Making dependencies
available to the checkouts is deferred to the evaluation phase (it needs a safe way to link
`node_modules` without ever deleting through the link on cleanup).

If a version has no `tsconfig.json` at its root, the project is compiled with a strict default
configuration over all `.ts/.tsx` files; a `tsconfig.json` in a parent directory is never used.
Project references are not followed; `composite`/`incremental` are disabled for the check.

### D10. `src/ast/` and `src/util/` are shared helpers

They are not in the module list of the prompt. `ast/` (parsing, unit tree, structural hash) is used
by both `scenario/` and `annotate/`, and is where the OA analysis will get its node helpers;
`util/` holds file listing helpers.

### D12. TypeScript 5.9, not 7

`typescript@latest` is 7.x (native compiler) at the time of writing. The tool depends on the
JavaScript Compiler API (`createProgram`, `TypeChecker`, language service), so it is pinned to the
5.x line (`^5.9.3`), which is known to provide it. Whether 7.x offers an equivalent API was not
checked; revisit before upgrading.

### D11. CLI surface in phase 1

`--analyses` accepts `oa,df,cf,build` from the start so the interface does not change between
phases; analyses not yet implemented add a note to the report instead of failing silently.
`--format` accepts `text|json`; `sarif` arrives in phase 3. `--refactoring-filter` and `--depth`
are parsed and validated but have no effect yet. A discarded scenario is not an error: exit code 0
with the reason in the report.

## Phase 2

The OA analysis was implemented from the description of Algorithm 1 in the project prompt; the
papers themselves were not consulted while writing it, so fidelity to their exact formulation is
**not verified**. The points below are where we filled gaps or chose a reading.

### D13. The OA state and rules

The state at a program point is two maps, `Left writes` and `Right writes`, from state element to
the last live write of that side, plus a `dead` flag. Executing a write to element `e` by statement
label `s`:

- `s = Base` (or `LR`): every tracked write that `e` certainly replaces is removed from both maps
  (a Base write between two writes ends the interference);
- `s = L` or `R`: if a write of the **other** side overlaps `e`, an overriding assignment is
  reported (the other side's write is the _overwritten_ one, this write the _overriding_ one); then
  the other side's writes certainly replaced by `e` are removed, and this write is recorded.

Writes of the same side never alert. Reads are irrelevant. An `LR` statement (same change on both
sides) is not a source of interference: it takes the label of its call-site context, i.e. Base (it
kills) at the top level of a unit.

### D14. Which side a write belongs to

A write is attributed to the origin (from `annotate/`) of the statement that contains it, if that
origin is `L` or `R`. Otherwise it inherits the label of the call site through which its function is
being executed (`Base` at the top level). So an unchanged callee called from a Left statement writes
"as Left" (the canonical example), while a statement Left itself added inside an unchanged callee
writes "as Left" even from a Base call site. Statement origins of other files come from the
per-file annotation; files not changed against Base are all `Base`. The program's AST and the
annotation's AST are different parses, hence `FileAnnotation.originAt(offset)`.

### D15. State elements

Identity is (symbol resolved by the type checker, property path), see `src/state/`. `this` is a
root of its own. Overlap is "one path is a prefix of the other, segment by segment, `[*]` matching
anything"; a write kills only what it certainly replaces (prefix with identical segments, and
never through `[*]`). Consequences: `o` overlaps `o.a` (replacing an object overrides its fields);
`a[i]` overlaps `a[0]` (reported with low confidence, `dynamic-access` counted); a key that has a
literal type (`const k = "v"`) is resolved to that literal.

Confidence of an OA alert is `low` when either write goes through an `any`/`unknown` receiver or a
non-literal key, `medium` otherwise. `high` is reserved for dynamic confirmation (extension).

### D16. Interprocedural analysis

Calls are inlined, in program order, with the state flowing through: the callee body is executed
with `this` and parameters _rebased_ onto what the caller passed (`cell.set(1)` makes `this.v` into
`cell.v`; a parameter bound to an argument shares its properties, while assigning the parameter
itself is local). Locals of a callee are dropped when it returns. Resolution uses
`checker.getResolvedSignature`; overload/abstract declarations are resolved to an implementation
with a body when one exists.

- `--depth N` is the call nesting followed from a unit; `0` is the intraprocedural analysis.
- Recursion: a function already on the current call stack is not entered again (the depth limit
  would also stop it; the guard only avoids redundant work, so no oracle can tell them apart).
- A budget of 5000 inlined bodies per unit stops call-graph blow-up (`budget` limitation). No test
  exercises it.
- Calls into library code (`.d.ts`, `node_modules`) are assumed not to touch project state and are
  not counted. Calls without a resolvable project body (any-typed callee, interface member with no implementation found) are counted as `unresolved-call`; abstract and interface members are resolved to their implementations since phase 3 (D24).
- `new C(...)` runs the constructor with a fresh `this` (writes through parameters still count);
  field initialisers and implicit constructors are not run.
- Function and arrow _expressions_ are not executed where defined (`closure` limitation), so writes
  inside callbacks are missed. Calling a function stored in a variable is followed.

### D17. Control flow

`if`, `?:`, `&&`/`||`/`??` (right operand) and `switch` clauses are analysed on every path and
joined by union (a write is live if live on some path); `try` joins the state before the block with
the state at its end for the `catch` entry. Loops run their body **once** and join with the state
before the loop, with `break`/`continue` states joined at the exit. `return`/`throw` end the path
(callee return states are joined at the call). Labelled `break`/`continue` target the innermost
loop or switch. Not modelled: loop-carried overrides that need a second iteration, exceptions
thrown by callees, fall-through of `switch` beyond the immediately preceding clause.

When both arms of a join wrote the same element, one representative write site is kept, so an alert
names one of the two possible overwritten sites.

### D18. Alerts and limitations

One alert per (overwritten site, overriding site, element); `locations[0]` is the overwritten
write and `locations[1]` the overriding one, each with function, branch, and the call chain that
led to it. Limitations are counted per distinct source position and listed in the report
(`eval`, `dynamic-access`, `decorators`, `async-order`, `unresolved-call`, `closure`, `any-type`,
`depth-limit`, `budget`). Async callees and decorated methods are _still analysed_ (the alert is
kept) but counted, since their real effect order or behaviour may differ.

### D19. The oracle suite

`test/oracles/{positive,negative,limitations}/*.oracle`: one file per case with the expected
result and the Base/Left/Right sources (see `test/helpers/oracle.ts` for the format). The Merge
is computed with `git merge-file`, the same three-way textual algorithm git uses, and the case
fails if that merge conflicts, so every oracle really is a conflict-free merge. The runner also
requires that both sides changed at least one common function (a negative that analyses nothing
would pass for the wrong reason). `limitations/` documents known false negatives and the
limitations that must be reported; they are not claims about ground truth.

The oracles were written together with the analysis by the same author, so they check that the
implementation does what it was designed to do, not that the design is right. As a sanity check
that they discriminate, eight deliberate mutations of the analysis were run against the suite
(no Base kill, no local drop, parameter reassignment leaking, path-insensitive overlap, `return`
not ending a path, sequential `if` arms, no recursion guard, name-based identity): all but the
recursion guard made at least one oracle fail (see D16 for why that one cannot).

## Phase 3

As in phase 2, DF and CF are implemented from the description in the project prompt (function
summaries over the call graph, strongly connected components, implementations through the language
service). The papers were not consulted, so fidelity to their exact definitions of DF and CF is
**not verified**; D21 and D22 state precisely what is implemented.

### D20. One traversal for OA, DF and CF

`src/analysis/walker.ts` holds the traversal of statements and expressions (branches joined, loops
once, `break`/`continue`/`return`/`throw`, destructuring, short-circuit operators). OA, the
summary builder and DF/CF are subclasses with hooks for a write, a read, a call, a condition and
the code controlled by it. Moving OA onto it changed no result: the phase-2 oracles passed
unchanged. Two behaviours were added to the walker for reads: compound assignments and `++`/`--`
read before they write, and the bare receiver `this` is not a read (it is an identity, not state).

### D21. Data-flow interference (DF)

A DF alert is a write by one side that may reach a **read made by a statement the other side
changed**, with no kill in between: the same state as OA (live Left and Right writes, killed by a
Base write or by the reader's own side overwriting), but checked at reads. A read observes a write
when the write's path is a prefix of the read's (`state = ...` is observed by `state.a`; `o.a = ...`
is not observed by a read of the bare `o`, e.g. passing it as an argument; `[*]` matches anything).
Reads by Base code are not sinks: the definition needs a change on each side. A read inside a
condition is a read like any other. `locations[0]` is the write, `locations[1]` the read.

### D22. Control-flow interference (CF)

A CF alert says: a statement (or a call to code) that one side changed only runs under a condition
that the other side influences. The condition is influenced in two ways: the other side changed the
condition itself (no `element` in the alert), or the condition reads an element for which the other
side has a live write that reaches it. The controlled region is what structured control flow
nests under the condition: both arms of an `if`, a loop body, the clauses of a `switch`, the arms
of `?:`, the right operand of `&&`/`||`/`??`. Sinks are statements whose own origin is L/R (blocks
are not sinks) and calls whose callee contains L/R accesses. To keep alerts readable, once a sink is
reported under a condition, statements nested in that sink are not reported again.

Not modelled: control dependence created by early `return`/`break`/`throw` (code after them), by
exceptions, or by loop back-edges. `locations[0]` is the source (write, or the changed condition's
statement), `locations[1]` the sink; the condition is named in the explanation.

### D23. Function summaries

`src/analysis/flow/summary.ts`. The summary of a function is the **set** of its accesses (reads and
writes of state elements, each labelled with who changed the accessing statement) including those
of everything it may call, rewritten to the caller's terms (`this` and parameters substituted,
callee locals and by-value parameter reassignments dropped). It is flow-insensitive: the order of
accesses inside a callee is lost. Consequences, all deliberate and all sources of imprecision:

- applying a summary at a call, reads are checked before writes, and the callee's writes are added
  as live writes but **never kill** anything, so a Base callee that resets an element between a
  Left write and a Right read does not end the flow (OA, which inlines, does handle that);
- two changes inside the same callee are not related by its summary; that function is a unit of its
  own whenever both sides changed it, and is analysed as such;
- unlike OA, DF/CF follow calls to any depth (the summary is transitive), so `--depth` does not
  apply to them; Jesus et al. use depth 5 for all analyses, and this is a divergence.

A Base access inherits the label of the call site, and again at every level above, exactly as OA's
inheritance does. Recursive groups are solved by Tarjan's strongly connected components and
iterated to a fixed point; an element path longer than 4 segments is cut to 4 and marked
low-confidence so recursion over linked structures terminates. At most 3000 functions are
summarised per run (`budget` limitation). Checking a callee's locals _before_ rewriting matters:
in recursion the caller's parameters are the callee's parameters (a bug found by the tests).

### D24. Dispatch through the language service

`src/analysis/calls.ts`. A call whose resolved declaration has no body (abstract or interface
member) is resolved with `LanguageService.getImplementationAtPosition`, created lazily on a second
program over the same files, and each implementation is mapped back to the node in the checker's
program by position. OA joins the outcomes of all implementations; summaries take the union. This
closed the phase-2 limitation for abstract methods (that oracle moved from `limitations/` to
`positive/`). Interface members the language service cannot find an implementation for remain
`unresolved-call`.

### D25. Refactoring filter

`src/filter/refactoring/`. A side is _structural_ when every file it changed relative to Base only
contains refactorings: such a side did not change behaviour, so an interference that needs its
change is most likely a false alarm. Per file the classifier compares Base and side with a
normalised token stream (whitespace, comments, semicolons, quotes and redundant parentheses
ignored; local names numbered by first appearance) and accepts:

- **rename** of locals, parameters, functions and methods (a removed and an added function with the
  same body, plus the call sites);
- **extract/inline function**: a statement-level call replaced by the callee's body, with
  parameters substituted by the arguments, and the added (extract) or removed (inline) function
  fully explained by it;
- **extract/inline variable**: a single `const` whose initializer replaces its uses (it must have
  at least one use, otherwise adding a dead `const x = ...` would pass as a refactoring: a bug the
  oracle suite exposed in this heuristic);
- everything outside function bodies must be unchanged, and a new or deleted file is a real change.

Limits: calls are expanded only as expression statements; moves, field or class renames across
files, changed signatures, and reordering are not recognised (they count as real changes, so the
filter errs towards keeping alerts). The unit of judgement is the whole side, not a function.
`--refactoring-filter`: `off` leaves alerts alone, `downgrade` sets confidence to low, `suppress`
removes them (counted in the report notes). BUILD alerts are never touched. The CLI default is
`downgrade`, as in the project prompt; the `analyze()` API defaults to `off`.

### D26. Ranking

`src/rank/rank.ts`: `high` only when dynamically confirmed (never produced before the dynamic
extension), `medium` for static alerts with resolved types, `low` when types are uncertain
(`any`, non-literal key) or a refactoring is suspected. BUILD alerts are `high`: the compiler is
deterministic.

### D27. Output

`--format json` prints the complete `AnalysisReport` (alerts, limitations, annotation summary, the
refactoring verdict). `--format sarif` prints SARIF 2.1.0 with one rule per alert type; each result
has the **later** write or the sink as its primary location and the other as a related location,
`level` from the confidence (`high`: error, `medium`: warning, `low`: note), and the Portuguese
explanation, element, branches and call chains in `properties`.

### D28. What the oracles check in phase 3

New oracle directories: `df/` (10 positive, 8 negative), `cf/` (5 + 4) and `refactoring/` (10),
the last with the expected alerts for each filter mode. Every oracle runs with the CLI default
filter (`downgrade`) unless it lists modes, so a refactoring detected where it should not be would
change a confidence and fail. Twelve deliberate mutations of DF, CF, the summaries and the filter
were run against the suite: eleven made an oracle fail (one only after the new oracle r10 was
added), and one ("no rename pairing") is an equivalent mutant, since a rename is also explained as
an extraction plus an inlining. As in phase 2, oracles and implementation share an author.
