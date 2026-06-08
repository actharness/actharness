// istanbul-lib-* packages are CJS modules. In Node.js native ESM ("type": "module"),
// named imports from CJS packages fail at runtime even when TypeScript accepts them.
// This bridge uses default imports (which work) and re-exports the functions with types.

import istanbulCoverageDefault from 'istanbul-lib-coverage';
import type { CoverageMap, FileCoverage, FileCoverageData } from 'istanbul-lib-coverage';

type IstanbulCoverageLib = {
  createCoverageMap(data?: Record<string, FileCoverageData | FileCoverage>): CoverageMap;
  createFileCoverage(data: FileCoverageData | FileCoverage): FileCoverage;
};

const { createCoverageMap, createFileCoverage } =
  istanbulCoverageDefault as unknown as IstanbulCoverageLib;

export { createCoverageMap, createFileCoverage };
export type { CoverageMap, FileCoverage, FileCoverageData };
