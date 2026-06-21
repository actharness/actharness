// @actharness/composite — side-effectful entry: registers the composite executor.
// Import this package to enable composite action support in @actharness/core.

import { registerExecutor } from '@actharness/core';
import { compositeExecutor } from './composite-executor.js';

registerExecutor(compositeExecutor);

export { ShellSandbox } from '@actharness/shell';
export { compositeExecutor } from './composite-executor.js';
