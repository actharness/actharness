export {
  mockNetwork,
  mockNetworkOnce,
  mockGitHubApi,
  mockGitHubApiOnce,
  resetNetworkMocks,
  pruneConsumedOnce,
  drainForNode,
  drainForProxy,
  recordApiHit,
  recordNetworkHit,
  matchNetworkEntry,
  matchApiEntry,
  NetworkMockHandle,
} from './registry.js';

export type {
  ApiMockEntry,
  NetworkMockEntry,
  MockResponseDescriptor,
  SerializedMatcher,
  SerializedNetworkMock,
  DrainedForNode,
} from './registry.js';

export { ShellNetworkScope } from './shell-scope.js';
export { ProxyMockServer } from './proxy-server.js';
export { ensureSessionCa, signHostCert, cleanupSessionCa } from './ca-cert.js';
export type { CaBundle } from './ca-cert.js';
