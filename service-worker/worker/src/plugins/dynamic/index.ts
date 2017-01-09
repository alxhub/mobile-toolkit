import {FetchInstruction, NgSwCache, Operation, Plugin, PluginFactory, VersionWorker} from '@angular/service-worker/worker';
import {Observable} from 'rxjs/Observable';

const DEFAULT_NETWORK_WAIT_TIME_MS = 30000;

export function DynamicContentCache(options: DynamicContentCacheOptions = {}): PluginFactory<DynamicImpl> {
  return (worker: VersionWorker) => new DynamicImpl(worker, options.manifestKey || 'dynamic');
}

export type CachingStrategy = "cacheFirst" | "cacheOnly" | "fastest" | "networkFirst" | "networkOnly";

export interface DynamicContentCacheOptions {
  manifestKey?: string;
}

interface DynamicContentCacheManifest {
  match: UrlMatchConfig[];
}

interface RegexpMap {
  [str: string]: RegExp;
}

export interface UrlMatchOrInvalidateConfig {
  regex?: string;
  url?: string;
  prefix?: boolean;
}

export interface UrlMatchConfig extends UrlMatchOrInvalidateConfig {
  strategy: CachingStrategy;
  waitForNetworkMs?: number;
  invalidates?: UrlMatchOrInvalidateConfig[];
}

export class DynamicImpl implements Plugin<DynamicImpl> {
  errNotFound: Response;
  errGatewayTimeout: Response;
  cacheKey: string;

  private regexpMap = {};

  constructor(
    private worker: VersionWorker,
    private manifestKey: string) {
      this.cacheKey = manifestKey === 'dynamic' ? 'dynamic' : `dynamic:${manifestKey}`;
      this.errGatewayTimeout = this.worker.adapter.newResponse('Gateway Timeout', {
        status: 504,
        statusText: 'Gateway Timeout'
      });
      this.errNotFound = this.worker.adapter.newResponse('Not Found', {
        status: 404,
        statusText: 'Not Found'
      });
  }

  private get config(): DynamicContentCacheManifest {
    return this.worker.manifest[this.manifestKey] as DynamicContentCacheManifest;
  }

  private regexp(str: string): RegExp {
    if (!this.regexpMap.hasOwnProperty(str)) {
      this.regexpMap[str] = new RegExp(str).compile();
    }
    return this.regexpMap[str];
  }

  setup(ops: Operation[]): void {}

  fetch(req: Request, instructions: FetchInstruction[], carryOn: Operation[]): void {
    const match = this.match(req);
    if (!match) {
      return;
    }
    console.log('fetch matches', match);
    if (req.method === 'GET') {
      this.fetchGet(req, instructions, carryOn, match);
    } else {
      this.fetchMutate(req, instructions, carryOn, match);
    }
  }

  private fetchGet(req: Request, instructions: FetchInstruction[], carryOnOps: Operation[], match: UrlMatchConfig) {
    let instruction: FetchInstruction = null;
    let carryOn: Operation = null;
    const timeoutMs = match.waitForNetworkMs || DEFAULT_NETWORK_WAIT_TIME_MS;
    console.log('running fetch for', req.url);
    switch (match.strategy || 'fastest') {
      case 'cacheFirst':
        instruction = this.fetchCacheFirst(req, timeoutMs);
        break;
      case 'cacheOnly':
        instruction = this.fetchCacheOnly(req);
        break;
      case 'fastest':
        instruction = this.fetchFastest(req, timeoutMs);
        break;
      case 'networkFirst':
        instruction = this.fetchNetworkFirst(req, timeoutMs);
        break;
      case 'networkOnly':
        instruction = this.fetchNetworkOnly(req, timeoutMs);
        break;
      default:
        throw new Error(`Unknown caching strategy: ${match.strategy}`);
    }
    console.log('adding instruction', instruction.desc);
    instructions.unshift(instruction);
  }

  private fetchMutate(req: Request, instructions: FetchInstruction[], carryOn: Operation[], match: UrlMatchConfig) {
    if (!match.invalidates) {
      return;
    }
    instructions.unshift(this.invalidate(match.invalidates));
  }

  private match(req: Request): UrlMatchConfig {
    if (!this.config || !this.config.match) {
      return null;
    }
    return this
      .config
      .match
      .reduce((acc, pattern) => !!acc
        ? acc
        : (this.matchesPattern(req, pattern)
          ? pattern
          : null),
      null);
  }

  private matchesPattern(req: Request, pattern: UrlMatchOrInvalidateConfig): boolean {
    if (pattern.regex) {
      return this.regexp(pattern.regex).test(req.url);
    }
    if (pattern.url) {
      if (pattern.prefix) {
        return req.url.indexOf(pattern.url) === 0;
      } else {
        return req.url === pattern.url;
      }
    }
    return false;
  }

  private invalidate(patterns: UrlMatchOrInvalidateConfig[]): FetchInstruction {
    const instruction: FetchInstruction = () => {
      return this
        .worker
        .cache
        .list(this.cacheKey)
        .then(keys => Promise.all(keys
          .filter(key => patterns.some(pattern => this.matchesPattern(key, pattern)))
          .map(key => this.worker.cache.invalidate(this.cacheKey, key)))
        )
    };
    instruction.desc = {type: 'invalidate', patterns, plugin: this};
    return instruction;
  }

  private fetchWithTimeout(req: Request, timeoutMs: number): Promise<Response> {
    return new Promise((resolve, reject) => {
      let returned = false;
      this.worker.refresh(req)
        .then(resp => {
          if (returned) {
            return;
          }
          returned = true;
          resolve(resp);
        });
      setTimeout(() => {
        if (returned) {
          return;
        }
        returned = true;
        resolve(this.errGatewayTimeout);
      }, timeoutMs);
    });
  }
  
  private fetchAndCache(req: Request, timeoutMs: number): Promise<Response> {
    return this.fetchWithTimeout(req, timeoutMs)
      .then(resp => {
        if (!resp.ok) {
          return resp;
        }
        this.worker.cache.store(this.cacheKey, req, resp.clone());
        return resp;
      });
  }

  private fetchCacheOnly(req: Request): FetchInstruction {
    const instruction: FetchInstruction = () => this
      .worker
      .cache
      .load(this.cacheKey, req)
      .then(resp => resp ? resp : this.errNotFound);
    instruction.desc = {type: 'fetchFastest', req, plugin: this};
    return instruction;
  }

  private fetchNetworkOnly(req: Request, timeoutMs: number): FetchInstruction {
    const instruction: FetchInstruction = () => {
      console.log('fetchNetworkOnly(', req.url, ')', timeoutMs)
      return this.fetchAndCache(req, timeoutMs);
    };
    instruction.desc = {type: 'fetchNetworkOnly', req, timeoutMs, plugin: this};
    return instruction;
  }

  private fetchCacheFirst(req: Request, timeoutMs: number): FetchInstruction {
    const instruction: FetchInstruction = () => this
      .worker
      .cache
      .load(this.cacheKey, req)
      .then(resp => {
        if (!resp) {
          console.log('fetchCacheFirst: going to network', req.url);
          return this.fetchAndCache(req, timeoutMs);
        }
        console.log('fetchCacheFirst: found in cache', req.url);
        return resp;
      });
    instruction.desc = {type: 'fetchCacheFirst', req, timeoutMs, plugin: this};
    return instruction;
  }


  private fetchNetworkFirst(req: Request, timeoutMs: number): FetchInstruction {
    const instruction: FetchInstruction = () => this
      .fetchAndCache(req, timeoutMs)
      .then(resp => resp && resp !== this.errGatewayTimeout
        ? resp
        : this.fetchCacheOnly(req)()
      );
    instruction.desc = {type: 'fetchNetworkFirst', req, timeoutMs, plugin: this};
    return instruction;
  }

  private fetchFastest(req: Request, timeoutMs: number): FetchInstruction {
    const instruction: FetchInstruction = () => raceNonNull([
      this.fetchAndCache(req, timeoutMs).then(resp => resp.ok ? resp : null),
      this.fetchCacheOnly(req)().then(resp => resp.ok ? resp : null),
    ], this.errGatewayTimeout);
    instruction.desc = {type: 'fetchFastest', req, plugin: this};
    return instruction;
  }
}

function raceNonNull<T>(promises: Promise<T>[], defaultValue: T) {
  return new Promise<T>((resolve, reject) => {
    let numResolved = 0;
    let outerResolved = false;
    promises.forEach(promise => promise.then(value => {
      if (outerResolved) {
        return;
      }
      if (!!value) {
        outerResolved = true;
        resolve(value);
      } else {
        numResolved++;
        if (numResolved === promises.length) {
          resolve(defaultValue);
          outerResolved = true;
        }
      }
    }));
  });
}