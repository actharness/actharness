import { createCoverageMap, createFileCoverage } from './istanbul-compat.js';
import type { CoverageMap, FileCoverage, FileCoverageData } from './istanbul-compat.js';
import { registerRunListener } from './run-sink.js';
import type { RunSinkPayload } from './run-sink.js';
import { loadYamlSource } from './yaml-map.js';
import {
  buildActionCoverage, buildWorkflowCoverage,
  updateActionCoverage, updateWorkflowCoverage,
  type ActionCoverageMeta, type WorkflowCoverageMeta,
} from './istanbul-map.js';

interface FileCoverageState {
  coverage: FileCoverage;
  meta: ActionCoverageMeta | WorkflowCoverageMeta;
}

export class CoverageCollector {
  private readonly map: CoverageMap = createCoverageMap({});
  private readonly state = new Map<string, FileCoverageState>();

  register(): void {
    registerRunListener((payload: RunSinkPayload) => this.process(payload));
  }

  private ensureAction(sourceFile: string): FileCoverageState {
    if (!this.state.has(sourceFile)) {
      const yaml = loadYamlSource(sourceFile);
      const { coverage, meta } = buildActionCoverage(sourceFile, yaml);
      this.state.set(sourceFile, { coverage, meta });
      this.map.addFileCoverage(coverage);
    }
    return this.state.get(sourceFile)!;
  }

  private ensureWorkflow(sourceFile: string): FileCoverageState {
    if (!this.state.has(sourceFile)) {
      const yaml = loadYamlSource(sourceFile);
      const { coverage, meta } = buildWorkflowCoverage(sourceFile, yaml);
      this.state.set(sourceFile, { coverage, meta });
      this.map.addFileCoverage(coverage);
    }
    return this.state.get(sourceFile)!;
  }

  private process(payload: RunSinkPayload): void {
    if (payload.kind === 'action') {
      const { coverage, meta } = this.ensureAction(payload.sourceFile);
      updateActionCoverage(coverage, meta as ActionCoverageMeta, payload.result);

      // Merge in JS line coverage from the node sandbox (H9).
      if (payload.jsLineCoverage) {
        for (const jsData of payload.jsLineCoverage) {
          if (this.map.data[jsData.path]) {
            this.map.fileCoverageFor(jsData.path).merge(createFileCoverage(jsData));
          } else {
            this.map.addFileCoverage(createFileCoverage(jsData));
          }
        }
      }
    } else if (payload.kind === 'job') {
      const { coverage, meta } = this.ensureWorkflow(payload.sourceFile);
      updateWorkflowCoverage(coverage, meta as WorkflowCoverageMeta, payload.jobId, payload.ran);
    }
  }

  getMap(): CoverageMap { return this.map; }

  getFragment(): Record<string, FileCoverageData> {
    const out: Record<string, FileCoverageData> = {};
    for (const path of Object.keys(this.map.data)) {
      out[path] = this.map.fileCoverageFor(path).data;
    }
    return out;
  }

  getCoveredSteps(): number {
    let total = 0;
    for (const path of Object.keys(this.map.data)) {
      const fc = this.map.fileCoverageFor(path);
      total += Object.values(fc.data.s).filter((c) => (c as number) > 0).length;
    }
    return total;
  }

  getTotalSteps(): number {
    let total = 0;
    for (const path of Object.keys(this.map.data)) {
      const fc = this.map.fileCoverageFor(path);
      total += Object.keys(fc.data.s).length;
    }
    return total;
  }
}
