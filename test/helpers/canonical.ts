import { FixtureRepo } from './fixture-repo.js';

/** The overriding-assignment example of the project description, one statement per line. */
export const CANONICAL = {
  base: `class Text {
  text = "";
  fixes = 0;
  comments = 0;
  generateReport(): void {
    this.countComments();
  }
  countDuplicatedWhitespaces(): void {
    this.fixes = this.text.split("  ").length;
  }
  countComments(): void {
    this.comments = this.text.split("//").length;
  }
  countDuplicatedWords(): void {
    this.fixes = this.text.split(" ").length;
  }
}
`,
  left: `class Text {
  text = "";
  fixes = 0;
  comments = 0;
  generateReport(): void {
    this.countDuplicatedWhitespaces();
    this.countComments();
  }
  countDuplicatedWhitespaces(): void {
    this.fixes = this.text.split("  ").length;
  }
  countComments(): void {
    this.comments = this.text.split("//").length;
  }
  countDuplicatedWords(): void {
    this.fixes = this.text.split(" ").length;
  }
}
`,
  right: `class Text {
  text = "";
  fixes = 0;
  comments = 0;
  generateReport(): void {
    this.countComments();
    this.countDuplicatedWords();
  }
  countDuplicatedWhitespaces(): void {
    this.fixes = this.text.split("  ").length;
  }
  countComments(): void {
    this.comments = this.text.split("//").length;
  }
  countDuplicatedWords(): void {
    this.fixes = this.text.split(" ").length;
  }
}
`,
  merge: `class Text {
  text = "";
  fixes = 0;
  comments = 0;
  generateReport(): void {
    this.countDuplicatedWhitespaces();
    this.countComments();
    this.countDuplicatedWords();
  }
  countDuplicatedWhitespaces(): void {
    this.fixes = this.text.split("  ").length;
  }
  countComments(): void {
    this.comments = this.text.split("//").length;
  }
  countDuplicatedWords(): void {
    this.fixes = this.text.split(" ").length;
  }
}
`,
};

export const TSCONFIG = JSON.stringify({
  compilerOptions: {
    strict: true,
    target: 'ES2022',
    module: 'ESNext',
    moduleResolution: 'Bundler',
    skipLibCheck: true,
  },
  include: ['src'],
});

export interface MergeFixture {
  repo: FixtureRepo;
  base: string;
  left: string;
  right: string;
  merge: string;
}

/**
 * Builds a repository whose merge commit combines one change per side without any textual
 * conflict: `main` (Left) and `feature` (Right) diverge from the same Base.
 */
export function buildMergeFixture(files: {
  base: Record<string, string>;
  left: Record<string, string>;
  right: Record<string, string>;
}): MergeFixture {
  const repo = new FixtureRepo();
  const base = repo.commit('base', files.base);
  repo.branch('feature');
  const right = repo.commit('right', files.right);
  repo.checkout('main');
  const left = repo.commit('left', files.left);
  const merge = repo.merge('feature');
  return { repo, base, left, right, merge };
}

export function canonicalFixture(): MergeFixture {
  const file = (text: string): Record<string, string> => ({ 'src/text.ts': text });
  return buildMergeFixture({
    base: { 'tsconfig.json': TSCONFIG, ...file(CANONICAL.base) },
    left: file(CANONICAL.left),
    right: file(CANONICAL.right),
  });
}
