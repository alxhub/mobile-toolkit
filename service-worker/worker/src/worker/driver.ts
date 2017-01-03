import {VersionWorker, Plugin, PluginFactory, Operation} from './api';
import {VersionWorkerImpl} from './worker';
import {ScopedCache} from './cache';
import {NgSwAdapter, NgSwCache, NgSwEvents, NgSwFetch} from './facade';
import {LOG, LOGGER, Verbosity} from './logging';
import {Manifest, parseManifest} from './manifest';

import {Observable} from 'rxjs/Observable';

let driverId: number = 0;

export class Driver {
  
  private id: number;
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
      if (event.ports.length !==1 || !event.data || !event.data.hasOwnProperty('$ngsw')) {
        return;
      }
      const respond: MessagePort = event.ports[0];
      this.handleMessage(event.data, respond);
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
    const worker = new VersionWorkerImpl(this.scope, manifest, this.adapter, new ScopedCache(this.cache, `manifest:${manifest._hash}:`), this.fetcher, plugins);
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
    return this.scopedCache.store(cache, this.manifestUrl, this.adapter.newResponse(manifest._json)).toPromise();
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
          .then(() => Observable
            .from((activeWorker as VersionWorkerImpl).cleanup())
            .concatMap(op => op())
            .ignoreElements()
            .toPromise()
          )
          .then(() => stagedWorker)
      });
  }

  private handleMessage(message: Object, respond: MessagePort): Promise<Object> {
    if (!this.activeWorker) {
      return;
    }

    switch (message['cmd']) {
      case 'ping':
        respond.postMessage(null);
      case 'checkUpdate':
        this.checkForUpdates().then(value => {
            respond.postMessage(value);
            respond.postMessage(null);
        });
      case 'log':
        LOGGER.messages = (message: string) => {
          respond.postMessage(message);
        };
      default:
        return Observable
          .fromPromise(this.activeWorker)
          .switchMap(active => active
            ? (active as VersionWorkerImpl).message(message)
            : Observable.empty<Operation>())
          .switchMap(op => op());
    }
  }
}
