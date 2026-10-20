# Evaluation

Scripts to measure TSMergeLens on real merges. **Nothing here comes with results**: the numbers
come out of running the pipeline below on repositories you choose.

```bash
pnpm install && pnpm build
node eval/eval.mjs <mine|sheet|run|metrics> ...      # same as `node eval/eval.mjs` with no arguments for help
```

## Protocol

1. **Choose repositories** (TypeScript projects with real merge history), clone them with full
   history and install their dependencies, so that `node_modules` exists in each working tree.
   The scripts never download anything. Keep clones outside this repository, or under
   `eval/repos/` (git-ignored).
2. **Mine** the candidate merges:

   ```bash
   node eval/eval.mjs mine --repo ../some-project --since 2022-01-01 --limit 100 --seed 1 \
       --require-compile all --out eval/candidates.json
   ```

   A merge is kept when it has two parents, git merges its parents without a textual conflict,
   it is not a fast-forward or criss-cross, both sides changed the same function of a `.ts`/`.tsx`
   file, and (by default) Base, Left and Right type-check without errors. `--limit` samples at
   random with `--seed`; the file also records the selection funnel of each repository (how many
   merge commits each criterion removed), which is what a paper should report. Type-checking uses
   the `node_modules` currently installed in the working tree, which may not be exactly what the
   old commit used: a dependency mismatch fails the compile criterion, it does not fake a pass.

3. **Make the labelling sheet**:

   ```bash
   node eval/eval.mjs sheet --candidates eval/candidates.json --out eval/labels.csv
   ```

   One row per scenario, with the commits and the functions both sides changed, and **no output
   of the tool**. The command refuses to overwrite an existing sheet; `--update` adds new
   scenarios and keeps every label already written.

4. **Label by hand, two reviewers independently.** `reviewer1` and `reviewer2`: `1` if the merge
   contains a semantic interference (one side's change no longer behaves as that developer
   intended once merged), `0` if not. Where they differ, discuss and write `consensus`. Do not
   look at tool output before labelling. The sheet is a UTF-8 CSV with comma separators (in
   Excel use _Data > From text/CSV_ and choose comma).

5. **Run the configurations** (10 repetitions each by default; `--labels` restricts the run to
   scenarios that already have a usable label):

   ```bash
   node eval/eval.mjs run --candidates eval/candidates.json --labels eval/labels.csv \
       --configs B0,B1,B2,B3 --repetitions 10 --out eval/results.json
   ```

   | Config | What it is                                                                                 |
   | ------ | ------------------------------------------------------------------------------------------ |
   | B0     | git: accepts every merge git can do without conflict, so it never predicts interference    |
   | B1     | `tsc` only: interference iff the Merge has a compilation error none of Base/Left/Right has |
   | B2     | OA (intra and interprocedural) with state identified by identifier name, with no type info |
   | B3     | complete: OA + DF + CF + build, type-checker symbols, refactoring filter on (`downgrade`)  |

6. **Compute the metrics**:

   ```bash
   node eval/eval.mjs metrics --labels eval/labels.csv --results eval/results.json \
       --min-confidence low --out eval/report.md
   ```

   Gives, per configuration, the confusion matrix (TP/FP/TN/FN), precision, recall, F1, accuracy
   and the median time, plus the number of labelled scenarios, the pending disagreements and
   Cohen's kappa between the reviewers. A ratio with a zero denominator is printed as `n/a`.
   A scenario is predicted positive when the configuration raised an alert of at least
   `--min-confidence` (`low`: any alert; `medium`: ignore low-confidence ones). Run it with both
   to see how much the confidence ranking matters.

## What is measured, and how

- **Time**: wall clock of everything the configuration does on the four checked-out versions
  (parsing, annotation, type checking, analyses, report), per repetition; the scenario's time is
  the median of its repetitions and the table shows the median over scenarios. The checkout of the
  four versions is not timed. Repetitions run in one process and the standard-library files stay
  parsed between them, so they are warm: the figure is not a cold start of the CLI.
- **B0** time is the cost of replaying the merge with `git merge-tree`.
- **B2** differs from B3 only in how state is identified (and in not using DF/CF, build or the
  refactoring filter): calls are still resolved with the type checker, so B2 isolates the value of
  resolved symbols for _state identity_, not of the whole type system.
- A configuration that fails on a scenario is recorded as an error and left out of that
  configuration's scores (the `Errors` column says how many).

## Threats to keep in mind

The ground truth is human judgement, so report the reviewer agreement. Scenarios are mined only
from the repositories you pick and only where both sides touched the same function, so the
positive rate is not the rate in general merge history. Dependencies come from the working tree,
not from each commit. The tool and its test oracles were written by the same author.
