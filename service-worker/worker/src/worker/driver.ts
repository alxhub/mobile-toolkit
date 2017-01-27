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
  
    this.init = this.initialize();
    this.init.then(() => this.checkForUpdate());

    events.install = (event: InstallEvent) => {
      this.lifecycleLog.push('install event');
    };
    events.activate = (event: ActivateEvent) => {
      this.lifecycleLog.push('activate event');
    };
    events.fetch = (event: FetchEvent) => {
      const req = event.request;
      // Skip fetch events when in LAME state - no need to wait for init for this.
      if (this.state === DriverState.LAME) {
        return;
      }
      if (req.url.endsWith('/ngsw.log')) {
        event.respondWith(this
          .status()
          .then(status => this.adapter.newResponse(JSON.stringify(status, null, 2)))
        );
        return;
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
                  this.active = worker as VersionWorkerImpl;
                }
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
        const [activeManifest, staged, network] = manifests;
        if (!network) {
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
          .then(() => this.setupManifest(staged, this.active))
          .then(() => this.setManifest(staged, 'staged'))
          .then(() => {
            this.lifecycleLog.push(`staged update to ${staged._hash}`);
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
    const worker = new VersionWorkerImpl(this, this.scope, manifest, this.adapter, new ScopedCache(this.cache, `manifest:${manifest._hash}:`), this.fetcher, plugins);
    plugins.push(...this.plugins.map(factory => factory(worker)));
    return worker
      .validate()
      .then(valid => {
        if (!valid) {
          this.lifecycleLog.push(`cached version ${manifest._hash} not valid`);
          return null;
        }
        return worker;
      });
  }

  private setupManifest(manifest: Manifest, existing: VersionWorker = null): Promise<VersionWorker> {
    const plugins: Plugin<any>[] = [];
    const worker = new VersionWorkerImpl(this, this.scope, manifest, this.adapter, new ScopedCache(this.cache, `manifest:${manifest._hash}:`), this.fetcher, plugins);
    plugins.push(...this.plugins.map(factory => factory(worker)));
    return worker
      .setup(existing as VersionWorkerImpl)
      .then(() => worker);
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

  sendToStream(id: number, message: Object): void {
    if (!this.streams.hasOwnProperty(id)) {
      return;
    }
    this.streams[id].postMessage(message);
  }

  closeStream(id: number): void {}
}

export class OldDriver {
  
  private id: number;
  private streamId: number = 0;

  private streams: {[key: number]: MessagePort} = {};
  private activeWorker: Promise<VersionWorker> = null;
  private scopedCache: ScopedCache;

  private stagedManifest: Promise<any>;

  private seenClientIds: Object = {};

  // Public for testing
  updateCheck: Promise<boolean>;

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

    this.updateCheck = this.checkForUpdates();

    // On installation, load the worker as if a fetch event happened.
    // This will prime the caches.
    events.install = (event: InstallEvent) => {
      LOG.info('INSTALL EVENT');
      event.waitUntil(this.workerFromActiveOrFreshManifest());
    };

    events.activate = (event: ActivateEvent) => {
      LOG.info('ACTIVATE EVENT');
    };

    events.fetch = (event: FetchEvent) => {
      let req = event.request;
      event.respondWith(this.onFetch(event).then((resp) => {
        return resp;
      }));
    };

    events.message = (event: MessageEvent) => {
      if (event.ports.length !== 1 || !event.data || !event.data.hasOwnProperty('$ngsw')) {
        return;
      }
      const respond: MessagePort = event.ports[0];
      const id = this.streamId++;
      this.streams[id] = respond;
      respond.postMessage({'$ngsw': true, 'id': id});
      this.handleMessage(event.data, id);
    }

    events.push = (event: PushEvent) => {
      if (!this.activeWorker || !event.data) {
        return;
      }
      Promise
        .all([
          this.activeWorker,
          event.data.json(),
        ])
        .then(result => (result[0] as VersionWorkerImpl).push(result[1]));
    };
  }

  private onFetch(event: FetchEvent): Promise<Response> {
    return this
      .maybeUpdate(event)
      .then(worker => {
        if (worker) {
          this.activeWorker = Promise.resolve(worker);
          return worker;
        } else if (!!this.activeWorker) {
          return this.activeWorker;
        } else {
          this.activeWorker = this.workerFromActiveOrFreshManifest();
          return this.activeWorker;
        }
      })
      .then(worker => worker.fetch(event.request));
  }

  private maybeUpdate(event: FetchEvent): Promise<VersionWorker> {
    const clientId = event.clientId;
    return this
      .scope
      .clients
      .matchAll()
      .then(clients => {
        if (clients.length !== 0) {
          return null;
        }
        return this
          .fetchManifestFromCache('staged')
          .then(manifest => {
            if (!manifest) {
              return null;
            }
            return this.updateWorker(manifest);
          });
      });
  }

  private workerFromActiveOrFreshManifest(): Promise<VersionWorker> {
    let manifestLoadedFromNetwork = false;
    return this
      .fetchManifestFromCache('active')
      .then(manifest => {
        // If the manifest already exists, just use it.
        if (manifest) {
          return manifest;
        }
        // Load the manifest from the network.
        manifestLoadedFromNetwork = true;
        return this.fetchManifestFromNetwork();
      })
      .then(manifest => {
        if (!manifest) {
          throw new Error("Service worker unable to start: no manifest file available");
        }
        return manifest;
      })
      .then(manifest => this.manifestToWorker(manifest))
      .then(worker => {
        if (!manifestLoadedFromNetwork) {
          return worker;
        }
        return this
          .setManifestInCache(worker.manifest, 'active')
          .then(() => worker);
      });
  }

  private manifestToWorker(manifest: Manifest, existing: VersionWorker = null): Promise<VersionWorker> {
    const plugins: Plugin<any>[] = [];
    const worker = new VersionWorkerImpl(this, this.scope, manifest, this.adapter, new ScopedCache(this.cache, `manifest:${manifest._hash}:`), this.fetcher, plugins);
    plugins.push(...this.plugins.map(factory => factory(worker)));
    return worker
      .setup(existing as VersionWorkerImpl)
      .then(() => worker);
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

  private setManifestInCache(manifest: Manifest, cache: string): Promise<void> {
    return this.scopedCache.store(cache, this.manifestUrl, this.adapter.newResponse(manifest._json));
  }

  private deleteManifestInCache(cache: string): Promise<void> {
    return this.scopedCache.invalidate(cache, this.manifestUrl);
  }

  private checkForUpdates(): Promise<boolean> {
    return Promise.all([
      this.fetchManifestFromNetwork(),
      this.fetchManifestFromCache('active')
    ]).then(manifests => {
      let [network, active] = manifests;
      if (!active || !network || network._json === active._json) {
        return false;
      }
      return this.manifestToWorker(active)
        .then(active => this.manifestToWorker(network, active))
        .then(() => this.setManifestInCache(network, 'staged'))
        .then(() => true);
    });
  }

  private updateWorker(staged: Manifest): Promise<VersionWorker> {
    return Promise.all([
        this
          .fetchManifestFromCache('active')
          .then(manifest => manifest ? this.manifestToWorker(manifest) : null),
        this
          .manifestToWorker(staged)
      ])
      .then(results => {
        const [activeWorker, stagedWorker] = results;
        return this
          .setManifestInCache(staged, 'active')
          .then(() => this.deleteManifestInCache('staged'))
          .then(() => (activeWorker as VersionWorkerImpl)
            .cleanup()
            .reduce<Promise<Response>>(
              (prev, curr) => prev.then(resp => resp ? resp : curr()),
              Promise.resolve(null)
            )
          )
          .then(() => stagedWorker)
      });
  }

  sendToStream(id: number, message: Object): void {
    if (!this.streams.hasOwnProperty(id)) {
      return;
    }
    this.streams[id].postMessage(message);
  }

  closeStream(id: number): void {
    if (!this.streams.hasOwnProperty(id)) {
      return;
    }
    this.streams[id].postMessage(null);
    delete this.streams[id]
  }

  private handleMessage(message: Object, id: number): Promise<Object> {
    if (!this.activeWorker) {
      return;
    }

    switch (message['cmd']) {
      case 'ping':
        this.closeStream(id);
        break;
      case 'checkUpdate':
        this.checkForUpdates().then(value => {
          this.sendToStream(id, value);
          this.closeStream(id);
        });
        break;
      case 'cancel':
        const idToCancel = message['id'];
        if (!this.streams.hasOwnProperty(id)) {
          return;
        }
        this.activeWorker.then(active => (active as VersionWorkerImpl).messageClosed(id));
        break;
      case 'log':
        LOGGER.messages = (message: string) => {
          this.sendToStream(id, message);
        };
        break;
      default:
        this.activeWorker.then(active => (active as VersionWorkerImpl).message(message, id));
    }
  }
}
