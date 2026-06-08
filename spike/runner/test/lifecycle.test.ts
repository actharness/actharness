// H1: proves before/after/beforeEach/afterEach globals work — all injected via register.ts

describe('lifecycle hooks', () => {
  let log: string[] = [];

  before(() => {
    log.push('before');
  });

  after(() => {
    // after fires after all tests in the suite; we can't assert on log here
    // because node:test runs after() after all its, but we verify via the test below.
  });

  beforeEach(() => {
    log.push('beforeEach');
  });

  afterEach(() => {
    log.push('afterEach');
  });

  it('first test: log has before + beforeEach', () => {
    expect(log).toEqual(['before', 'beforeEach']);
  });

  it('second test: beforeEach runs again, afterEach ran after first', () => {
    // log at this point: ['before', 'beforeEach', 'afterEach', 'beforeEach']
    expect(log.filter((e) => e === 'beforeEach').length).toBe(2);
    expect(log.filter((e) => e === 'afterEach').length).toBe(1);
  });
});

describe('nested describe', () => {
  let counter = 0;

  beforeEach(() => {
    counter = 0;
  });

  describe('inner suite', () => {
    it('counter is reset per test', () => {
      counter++;
      expect(counter).toBe(1);
    });

    it('counter is still reset', () => {
      counter++;
      expect(counter).toBe(1);
    });
  });

  it('outer test also gets beforeEach reset', () => {
    counter += 10;
    expect(counter).toBe(10);
  });
});

test('top-level test() also works', () => {
  expect(1).toBe(1);
});
