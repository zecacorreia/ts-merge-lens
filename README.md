# TSMergeLens

CLI that detects _semantic interferences_ in merges of TypeScript projects: merges that git
integrates without a textual conflict but that break the behaviour one of the developers expected.

> **Status: phase 3 of 4.** Scenario extraction, AST annotation (Left/Right/Base), build conflicts
> and the OA, DF and CF analyses, the refactoring filter, confidence ranking and JSON/SARIF output
> work. The evaluation scripts are phase 4; the dynamic analysis and the GitHub Action are an
> extension. None of this has been evaluated on real projects yet.

## Install

Requires Node.js >= 20, git >= 2.38 and pnpm.

```bash
pnpm install
pnpm build
node dist/cli.js --help
```

## Usage

```bash
# one merge commit of a git repository
tsmergelens analyze --repo <path> --merge <sha> [--entry <file#function>] [--depth 5]
                    [--analyses oa,df,cf,build] [--refactoring-filter off|downgrade|suppress]
                    [--format text|json|sarif] [--out <file>]

# the four versions already on disk (no git)
tsmergelens analyze --base <dir> --left <dir> --right <dir> --merge-dir <dir>

# list merge commits that are valid scenarios with functions changed by both sides
tsmergelens scan --repo <path> [--since <date>]
```

Exit codes: `0` no alerts, `1` alerts found, `2` execution error. A merge that is not a valid
scenario (fast-forward, criss-cross, textual conflict, ...) is reported as _discarded_ with exit
code `0`.

### What it reports

- the **scenario**: Base, Left (first parent), Right (second parent) and Merge checked out into
  temporary directories (your repository is never modified);
- the **experimental units**: functions changed by both sides, as `file#Qualified.name`;
- an **annotation summary** per changed file: how many statements of the Merge come from `Base`,
  `L`, `R` or `LR`, plus statements removed against Base;
- **BUILD alerts**: compiler errors that only the Merge has (`tsc --noEmit` through the API);
- **OA alerts**: an assignment by one side that overrides, with no write by Base in between, an
  assignment by the other side to the same state element (variable, field, `o.a`, `a[0]`).
  `locations[0]` is the overwritten write, `locations[1]` the overriding one, each with its
  branch, function and the call chain that reached it. Confidence is `medium`, or `low` when
  `any` or a non-literal key is involved;
- **DF alerts** (data flow): a value written by one side's changes reaches a read made by a
  statement the other side changed. `locations[0]` is the write, `locations[1]` the read;
- **CF alerts** (control flow): a statement one side changed only runs under a condition the other
  side influences, because it changed the condition or wrote a value the condition reads.
  `locations[0]` is the source, `locations[1]` the controlled statement. DF and CF use function
  summaries over the call graph (recursion solved as strongly connected components);
- **refactoring filter**: when every change of one side looks like a refactoring (formatting,
  renames, extract/inline function or variable), alerts that involve that side are removed
  (`suppress`) or marked low confidence (`downgrade`, the CLI default);
- **confidence**: `medium` for static alerts with resolved types, `low` when `any`, a non-literal
  key or a suspected refactoring is involved (`high` is reserved for dynamic confirmation);
- **limitations**: where the analysis approximated (`eval`, dynamic access, decorators, async
  order, unresolved calls, callbacks, `any`, depth/budget), counted and listed with examples.

`--depth N` is how many levels of calls OA follows (default 5; `0` is intraprocedural).

`--format json` prints the full `AnalysisReport` (see `src/report/types.ts`). `--format sarif`
prints SARIF 2.1.0: one result per alert, the later write (or the sink) as the primary location,
the other as a related location, confidence as the level, and the Portuguese explanation, element
and call chains in `properties`.

## Limitations

- Functions are matched by qualified name; renamed files and object-literal methods are not followed.
- No move detection in the AST alignment: a moved statement counts as removed plus added.
- Checkouts have no `node_modules`; errors that every version shares are filtered out, but they can
  mask type errors that depend on missing packages. See `docs/decisions.md` (D9).
- OA models writes (assignments, `++`/`--`, destructuring, `delete`), not mutating calls such as
  `arr.push`; loops run once; callbacks are not executed. See `docs/decisions.md` (D13–D19).
- DF and CF are coarser than OA: callee summaries are flow-insensitive (a Base callee does not
  end a flow), control dependence comes only from structured nesting (not from early `return`,
  `break` or exceptions), and `--depth` does not apply to them. See D21–D23.
- The refactoring filter is a token-level heuristic; it keeps an alert when in doubt (D25).

Design decisions and deviations from the reference papers: [docs/decisions.md](docs/decisions.md).

## Development

```bash
pnpm test        # vitest: unit tests, git fixtures and the oracle suite (test/oracles)
pnpm lint        # eslint + prettier
pnpm typecheck
pnpm exec vitest run --coverage
```
