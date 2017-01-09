import 'reflect-metadata';
import {SHA1} from 'jshashes';
import {Driver, LOG, LOGGER, ConsoleHandler} from '../../worker';
import {DynamicContentCache} from '../../plugins/dynamic';
import {TestWorkerDriver} from '../../testing/mock';
import {MockRequest} from '../../testing/mock_cache';

const consoleLogger = new ConsoleHandler();
LOGGER.messages = (entry => consoleLogger.handle(entry));
LOGGER.release();

const MANIFEST_URL = '/ngsw-manifest.json';

const SIMPLE_MANIFEST = JSON.stringify({
  dynamic: {
    match: [
      {url: '/cacheFirst', prefix: true, strategy: 'cacheFirst'},
      {url: '/fastest', prefix: true, strategy: 'fastest'}
    ]
  }
});
const SIMPLE_MANIFEST_HASH = new SHA1().hex(SIMPLE_MANIFEST);

function createServiceWorker(scope, adapter, cache, fetch, events) {
  const plugins = [
    DynamicContentCache(),
  ]
  return new Driver(MANIFEST_URL, plugins, scope, adapter, cache, events, fetch);
}

function expectOkResponse(value: Response): Response {
  expect(value).not.toBeUndefined();
  expect(value.ok).toBeTruthy();
  return value;
}

function expectServed(driver: TestWorkerDriver, url: string, contents: string, id: string = undefined): Promise<void> {
  return driver
    .triggerFetch(new MockRequest(url), false, id)
    .then(expectOkResponse)
    .then(resp => resp.text())
    .then(body => expect(body).toBe(contents))
    .then(() => null);
}

describe('dynamic content caching', () => {
  let driver: TestWorkerDriver = new TestWorkerDriver(createServiceWorker);
  beforeAll(() => {
    driver.emptyCaches();
    driver.refresh();
    driver.mockUrl(MANIFEST_URL, SIMPLE_MANIFEST);
    driver.mockUrl('/cacheFirst/test', 'Test request');
    driver.mockUrl('/fastest/test', 'Initial content');
  });
  it('sets up', done => {
    driver
      .triggerInstall()
      .then(() => driver.triggerActivate())
      .then(done);
  });
  it('caches a simple dynamic url with cacheFirst', done => Promise.resolve()
    .then(() => expectServed(driver, '/cacheFirst/test', 'Test request'))
    .then(() => driver.mockUrl('/cacheFirst/test', 'Should not be refreshed'))
    .then(() => expectServed(driver, '/cacheFirst/test', 'Test request'))
    .then(() => done())
  );
  it('updates in the background with fastest', done => Promise.resolve()
    .then(() => expectServed(driver, '/fastest/test', 'Initial content'))
    .then(() => driver.mockUrl('/fastest/test', 'Updated content', true))
    .then(() => expectServed(driver, '/fastest/test', 'Initial content'))
    .then(() => driver.scope.completeRequest())
    .then(() => expectServed(driver, '/fastest/test', 'Updated content'))
    .then(() => driver.scope.completeRequest())
    .then(() => done())
  );
});