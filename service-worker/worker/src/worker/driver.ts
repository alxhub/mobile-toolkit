import {VersionWorker, Plugin, PluginFactory, Operation} from './api';
import {VersionWorkerImpl} from './worker';
import {ScopedCache} from './cache';
import {NgSwAdapter, NgSwCache, NgSwEvents, NgSwFetch} from './facade';
import {LOG, LOGGER, Verbosity} from './logging';
import {Manifest, parseManifest} from './manifest';

let driverId: number = 0;

export enum DriverState {
  STARTUP,
  READY,
  UPDATE_PENDING,
  INSTALLING,
  LAME,
}

export class Driver {
  private state: DriverState = DriverState.STARTUP;

  private id: number;
  private init: Promise<any>;
  private active: VersionWorkerImpl;
  private scopedCache: ScopedCache;

  private streamId: number = 0;
  private streams: {[key: number]: MessagePort} = {};
  private lifecycleLog: string[] = [];

  constructor(
      private manifestUrl: string,
      private plugins: PluginFactory<any>[],
      private scope: ServiceWorkerGlobalScope,
      private adapter: NgSwAdapter,
      private cache: NgSwCache,
      private events: NgSwEvents,
      public fetcher: NgSwFetch) {
    this.id = driverId++;
    this.scopedCache = new ScopedCache(this.cache, 'ngsw:');

    events.install = (event: InstallEvent) => {
      this.lifecycleLog.push('install event');
      event.waitUntil(this
        .reset()
        .then(() => this.scope.skipWaiting())
      );
    };

    events.activate = (event: ActivateEvent) => {
      if (!this.init) {
        this.startup();
      }
      this.lifecycleLog.push('activate event');
      event.waitUntil(this.scope.clients.claim());
    };

    events.fetch = (event: FetchEvent) => {
      const req = event.request;
      if (req.url.endsWith('/ngsw.log')) {
        event.respondWith(this
          .status()
          .then(status => this.adapter.newResponse(JSON.stringify(status, null, 2)))
        );
        return;
      }

      // Skip fetch events when in LAME state - no need to wait for init for this.
      if (this.state === DriverState.LAME) {
        return;
      }

      if (this.state === DriverState.STARTUP) {
        this.startup();
      }
      if (!this.init) {
        throw new Error(`init Promise not present in state ${DriverState[this.state]}`);
      }

      event.respondWith(this
        .init
        .then(() => {
          // Within here, `this.state` should be set correctly.
          switch (this.state) {
            case DriverState.READY:
              // Ready state - route request to the active worker.
              return this.active.fetch(req);
            case DriverState.UPDATE_PENDING:
              // Update pending - give the active worker a chance to 
              return this
                .maybeUpdate(event.clientId)
                .then(() => this.active.fetch(req));
            case DriverState.INSTALLING:
            case DriverState.LAME:
              return this.fetcher.request(req);
            default:
              return this.fetcher.request(req);
          }
        })
      );
    };

    events.message = (event: MessageEvent) => {
      // Skip push events when in LAME state - no need to wait for init for this.
      if (this.state === DriverState.LAME) {
        return;
      }

      if (this.state === DriverState.STARTUP) {
        this.startup();
      }
      if (!this.init) {
        throw new Error(`init Promise not present in state ${DriverState[this.state]}`);
      }

      if (event.ports.length !== 1 || !event.data || !event.data.hasOwnProperty('$ngsw')) {
        return;
      }

      this.init.then(() => {
        if (this.state !== DriverState.READY && this.state !== DriverState.UPDATE_PENDING) {
          // Drop push messages that show up before we're ready.
          return;
        }

        const respond: MessagePort = event.ports[0];
        const id = this.streamId++;
        this.streams[id] = respond;
        respond.postMessage({'$ngsw': true, 'id': id});
        this.handleMessage(event.data, id);
      });
    }

    events.push = (event: PushEvent) => {
      // Skip push events when in LAME state - no need to wait for init for this.
      if (this.state === DriverState.LAME) {
        return;
      }

      if (this.state === DriverState.STARTUP) {
        this.startup();
      }
      if (!this.init) {
        throw new Error(`init Promise not present in state ${DriverState[this.state]}`);
      }
      
      Promise
        .all([
          this.init,
          event.data.json(),
        ])
        .then(results => results[1])
        .then(data => {
          if (this.state !== DriverState.READY && this.state !== DriverState.UPDATE_PENDING) {
            // Drop push messages that show up before we're ready.
            return;
          }
          this.active.push(data);
        });
    };
  }

  private reset(): Promise<any> {
    return this
      .scopedCache
      .keys()
      .then(keys => Promise.all(keys.map(key => this.scopedCache.remove(key)))
        .then(() => this.lifecycleLog.push(`reset removed ${keys.length} ngsw: caches`)));
  }

  private startup() {
    this.init = this.initialize();
    this.init.then(() => this.checkForUpdate());
  }

  private maybeUpdate(clientId: any): Promise<any> {
    return this
      .scope
      .clients
      .matchAll()
      .then(clients => {
        if (clients.length !== 0) {
          return null;
        }
        return this.doUpdate();
      });
  }

  /**
   * Switch to the staged worker (if any).
   *
   * After updating, the worker will be in state READY, always.
   * If a staged manifest was present and validated, it will be set as active.
   */
  private doUpdate(): Promise<any> {
    return this
      .fetchManifestFromCache('staged')
      .then(manifest => {
        if (!manifest) {
          this.goToState(DriverState.READY);
          return null;
        }
        return this
          .openManifest(manifest)
          .then(worker => {
            return this
              .clearStaged()
              .then(() => worker ? this.setManifest(manifest, 'active') : null)
              .then(() => {
                if (worker) {
                  const oldActive = this.active;
                  this.active = worker as VersionWorkerImpl;
                  this.cleanup(oldActive);
                }
                this.lifecycleLog.push(`updated to manifest ${manifest._hash}`);
                this.goToState(DriverState.READY);
              });
          });
      });
  }

  private clearStaged(): Promise<any> {
    return this.scopedCache.invalidate('staged', this.manifestUrl);
  }

  private checkForUpdate(): Promise<boolean> {
    if (this.state !== DriverState.READY) {
      this.lifecycleLog.push(`skipping update check, in state ${DriverState[this.state]}`);
      return Promise.resolve(false);
    }
    return Promise
      .all([
        this.fetchManifestFromCache('active'),
        this.fetchManifestFromCache('staged'),
        this.fetchManifestFromNetwork(),
      ])
      .then((manifests: Manifest[]) => {
        const [active, staged, network] = manifests;
        if (!network) {
          return false;
        }
        if (!!active && active._hash === network._hash) {
          return false;
        }
        if (!!staged && staged._hash === network._hash) {
          this.lifecycleLog.push(`network manifest ${network._hash} is already staged`);
          this.goToState(DriverState.UPDATE_PENDING);
          return true;
        }
        let start = Promise.resolve();
        if (!!staged) {
          this.lifecycleLog.push(`staged manifest ${staged._hash} is old, removing`);
          start = this.clearStaged();
        }
        return start
          .then(() => this.setupManifest(network, this.active))
          .then(() => this.setManifest(network, 'staged'))
          .then(() => {
            this.lifecycleLog.push(`staged update to ${network._hash}`);
            this.goToState(DriverState.UPDATE_PENDING);
            return true;
          });
      });
  }

  private initialize(): Promise<any> {
    if (this.state !== DriverState.STARTUP) {
      return Promise.reject(new Error("driver: initialize() called when not in STARTUP state"));
    }
    return Promise.all([
        this.fetchManifestFromCache('active'),
        this.fetchManifestFromCache('staged'),
      ])
      .then(manifests => {
        const [active, staged] = manifests;
        if (!active) {
          this.goToState(DriverState.INSTALLING);
          this.doInstallFromNetwork();
          return null;
        }
        return this
          .openManifest(active)
          .then(worker => {
            if (!worker) {
              this.goToState(DriverState.LAME);
              return;
            }
            this.lifecycleLog.push(`manifest ${active._hash} activated`);
            this.active = worker as VersionWorkerImpl;
            // If a staged manifest exist, go to UPDATE_PENDING instead of READY.
            if (!!staged) {
              this.lifecycleLog.push(`staged manifest ${staged._hash} present at initialization`);
              this.goToState(DriverState.UPDATE_PENDING);
              return;
            }
            this.goToState(DriverState.READY);
          });
      });
  }

  private doInstallFromNetwork(): Promise<any> {
    return this
      .fetchManifestFromNetwork()
      .then(manifest => {
        if (!manifest) {
          this.lifecycleLog.push('no network manifest found to install from');
          this.goToState(DriverState.LAME);
          return null;
        }
        return this
          .setupManifest(manifest, null)
          .then(worker => {
            if (!worker) {
              this.lifecycleLog.push('network manifest setup failed');
              this.goToState(DriverState.LAME);
              return null;
            }
            this
              .setManifest(manifest, 'active')
              .then(() => {
                this.active = worker as VersionWorkerImpl;
                this.lifecycleLog.push(`installed version ${manifest._hash} from network`);
                this.goToState(DriverState.READY);
              });
          });
      });
  }

  private fetchManifestFromCache(cache: string): Promise<Manifest> {
    return this
      .scopedCache
      .load(cache, this.manifestUrl)
      .then(resp => this.manifestFromResponse(resp));
  }

  private fetchManifestFromNetwork(): Promise<Manifest> {
    return this
      .fetcher
      .refresh(this.manifestUrl)
      .then(resp => this.manifestFromResponse(resp));
  }

  private manifestFromResponse(resp: Response): Promise<Manifest> {
    if (!resp || resp.status !== 200) {
      return null;
    }
    return resp.text().then(body => parseManifest(body));
  }

  private setManifest(manifest: Manifest, cache: string): Promise<void> {
    return this.scopedCache.store(cache, this.manifestUrl, this.adapter.newResponse(manifest._json));
  }

  private openManifest(manifest: Manifest): Promise<VersionWorker> {
    const plugins: Plugin<any>[] = [];
    const worker = new VersionWorkerImpl(this, this.scope, manifest, this.adapter, new ScopedCache(this.scopedCache, `manifest:${manifest._hash}:`), this.fetcher, plugins);
    plugins.push(...this.plugins.map(factory => factory(worker)));
    return worker
      .validate()
      .then(valid => {
        if (!valid) {
          this.lifecycleLog.push(`cached version ${manifest._hash} not valid`);
          // Recover from the error by deleting all existing caches (effectively a reset).
          return this
            .reset()
            .then(() => null);
        }
        return worker;
      });
  }

  private setupManifest(manifest: Manifest, existing: VersionWorker = null): Promise<VersionWorker> {
    const plugins: Plugin<any>[] = [];
    const worker = new VersionWorkerImpl(this, this.scope, manifest, this.adapter, new ScopedCache(this.scopedCache, `manifest:${manifest._hash}:`), this.fetcher, plugins);
    plugins.push(...this.plugins.map(factory => factory(worker)));
    return worker
      .setup(existing as VersionWorkerImpl)
      .then(() => worker);
  }

  private cleanup(worker: VersionWorkerImpl): void {
    worker
      .cleanup()
      .reduce<Promise<Response>>(
        (prev, curr) => prev.then(resp => curr()),
        Promise.resolve(null)
      )
      .then(() => this.lifecycleLog.push(`cleaned up old version ${worker.manifest._hash}`));
  }

  private status(): Promise<any> {
    return Promise.resolve({
      state: DriverState[this.state],
      lifecycleLog: this.lifecycleLog,
    });
  }

  private goToState(state: DriverState): void {
    this.lifecycleLog.push(`transition from ${DriverState[this.state]} to ${DriverState[state]}`);
    this.state = state;
  }

  private handleMessage(message: Object, id: number): Promise<Object> {
    if (!this.active) {
      return;
    }

    switch (message['cmd']) {
      case 'ping':
        this.closeStream(id);
        break;
      case 'checkUpdate':
        this.checkForUpdate().then(value => {
          this.sendToStream(id, value);
          this.closeStream(id);
        });
        break;
      case 'cancel':
        const idToCancel = message['id'];
        if (!this.streams.hasOwnProperty(id)) {
          return;
        }
        this.active.messageClosed(id);
        break;
      case 'log':
        LOGGER.messages = (message: string) => {
          this.sendToStream(id, message);
        };
        break;
      default:
        this.active.message(message, id);
    }
  }

  sendToStream(id: number, message: Object): void {
    if (!this.streams.hasOwnProperty(id)) {
      return;
    }
    this.streams[id].postMessage(message);
  }

  closeStream(id: number): void {}
}
