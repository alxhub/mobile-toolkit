import {VersionWorker, Plugin, PluginFactory, Operation} from './api';
import {VersionWorkerImpl} from './worker';
import {ScopedCache} from './cache';
import {NgSwAdapter, NgSwCache, NgSwEvents, NgSwFetch} from './facade';
import {LOG, LOGGER, Verbosity} from './logging';
import {Manifest, parseManifest} from './manifest';

let driverId: number = 0;

/**
 * Possible states for the service worker.
 */
export enum DriverState {
  // Just starting up - this is the initial state. The worker is not servicing requests yet.
  // Crucially, it does not know if it is an active worker, or is being freshly installed or
  // updated.
  STARTUP,

  // The service worker has an active manifest and is currently serving traffic.
  READY,

  // The service worker is READY, but also has an updated manifest staged. When a fetch
  // is received and no current tabs are open, the worker may choose to activate the
  // pending manifest and discard the old one, in which case it will transition to READY.
  UPDATE_PENDING,

  // The worker has started up, but had no active manifest cached. In this case, it must
  // download from the network.
  INSTALLING,

  // Something happened that prevented the worker from reaching a good state. In the LAME
  // state the worker forwards all requests directly to the network, effectively self-disabling.
  // The worker will not recover from this state until it is terminated.
  LAME,
}

export class Driver {
  // The worker always starts in STARTUP.
  private state: DriverState = DriverState.STARTUP;

  // Tracks which `Driver` instance this is, useful for testing only.
  private id: number;

  // A `Promise` that resolves when the worker reaches a state other than READY. The worker
  // blocks on this when handling fetch events.
  private init: Promise<any>;

  // The currently active `VersionWorkerImpl`, which handles events for the active manifest.
  // This is only valid if the worker is in the READY or UPDATE_PENDING states.
  private active: VersionWorkerImpl;

  // A `CacheStorage` API wrapper with the service worker prefix. This is used to delete all
  // caches associated with the worker when upgrading between worker versions or recovering
  // from a critical error.
  private scopedCache: ScopedCache;

  // The next available id for observable streams used to communicate with application tabs.
  private streamId: number = 0;

  // A map of stream ids to `MessagePort`s that communicate with application tabs.
  private streams: {[key: number]: MessagePort} = {};

  // The worker's lifecycle log, which is appended to when lifecycle events happen. This
  // is not ever cleared, but should not grow very large.
  private lifecycleLog: string[] = [];

  // A `Promise` that resolves when the worker enters the READY state. Used only in tests.
  ready: Promise<any>;

  // A resolve function that resolves the `ready` promise. Used only for testing.
  readyResolve: Function;

  // A `Promise` that resolves when the worker enters the UPDATE_PENDING state. Used only
  // in tests.
  updatePending: Promise<any>;

  // A resolve function that resolves the `ready` promise. Used only for testing.
  updatePendingResolve: Function;

  constructor(
      private manifestUrl: string,
      private plugins: PluginFactory<any>[],
      private scope: ServiceWorkerGlobalScope,
      private adapter: NgSwAdapter,
      private cache: NgSwCache,
      private events: NgSwEvents,
      public fetcher: NgSwFetch) {
    this.id = driverId++;

    // Set up Promises for testing.
    this.ready = new Promise(resolve => this.readyResolve = resolve)
    this.updatePending = new Promise(resolve => this.updatePendingResolve = resolve);

    // All SW caching should go through this cache.
    this.scopedCache = new ScopedCache(this.cache, 'ngsw:');

    // Subscribe to all the service worker lifecycle events:

    events.install = (event: InstallEvent) => {
      this.lifecycle('install event');

      event.waitUntil(Promise.resolve()
        // On installation, wipe all the caches to avoid any inconsistent states
        // with what the previous script version saved.
        .then(() => this.reset())
        // Get rid of the old service worker asap.
        .then(() => this.scope.skipWaiting())
      );
    };

    events.activate = (event: ActivateEvent) => {
      this.lifecycle('activate event');
      // Kick off the startup process right away, so the worker doesn't wait for fetch
      // events before getting a manifest and installing the app.
      if (!this.init) {
        this.startup();
      }
      // Take over all active pages. At this point the worker is still in STARTUP, so
      // all requests will fall back on the network.
      event.waitUntil(this.scope.clients.claim());
    };

    events.fetch = (event: FetchEvent) => {
      const req = event.request;

      // Handle the log event no matter what state the worker is in.
      if (req.url.endsWith('/ngsw.log')) {
        event.respondWith(this
          .status()
          .then(status => this.adapter.newResponse(JSON.stringify(status, null, 2)))
        );
        return;
      }
      
      // Skip fetch events when in LAME state - no need to wait for init for this.
      // Since the worker doesn't call event.respondWith(), the browser will go to
      // the network for this request.
      if (this.state === DriverState.LAME) {
        return;
      }

      // If this is the first request and the worker is in STARTUP, kick off the startup
      // process. This is a normal step for subsequent startups of the worker (during the
      // first one, the activate event usually kicks off the startup process).
      if (this.state === DriverState.STARTUP && !this.init) {
        this.startup();
      }

      // Should not happen, but just in case, throw an error.
      if (!this.init) {
        throw new Error(`init Promise not present in state ${DriverState[this.state]}`);
      }

      event.respondWith(this
        // For every request, first wait on initialization. After this.init resolves, the
        // worker should no longer be in STARTUP. Choose the strategy to handle the
        // request based on the worker's state.
        .init
        .then(() => {
          switch (this.state) {
            case DriverState.READY:
              // The worker is ready and this.active is set to a VersionWorker.
              return this.active.fetch(req);
            case DriverState.UPDATE_PENDING:
              // The worker is ready but has a pending update. Decide whether to activate
              // the pending manifest before servicing the request.
              return this
                .maybeUpdate(event.clientId)
                // After maybeUpdate(), the worker is either still in UPDATE_PENDING (the
                // worker couldn't update because other tabs were open, etc) or in READY
                // and this.active is now the new VersionWorker for the updated manifest.
                // Either way, serve the request with the active worker.
                .then(() => this.active.fetch(req));
            case DriverState.INSTALLING:
            case DriverState.LAME:
              // Whether the worker is still INSTALLING or has freshly transitioned to a
              // LAME state, serve the request with the network.
              return this.fetcher.request(req);
            default:
              // Shouldn't happen, but just be safe and serve the request from the network.
              return this.fetcher.request(req);
          }
        })
      );
    };

    events.message = (event: MessageEvent) => {
      // Skip all events in the LAME state.
      if (this.state === DriverState.LAME) {
        return;
      }

      // Start up if needed (see fetch above).
      if (this.state === DriverState.STARTUP && !this.init) {
        this.startup();
      }
      if (!this.init) {
        throw new Error(`init Promise not present in state ${DriverState[this.state]}`);
      }

      // Some sanity checks against the incoming message - is it intended for the worker?
      if (event.ports.length !== 1 || !event.data || !event.data.hasOwnProperty('$ngsw')) {
        return;
      }

      // Wait for initialization.
      this.init.then(() => {
        // Did the worker reach a good state?
        if (this.state !== DriverState.READY && this.state !== DriverState.UPDATE_PENDING) {
          // No - drop the message, it can't be handled until the worker is in a good state.
          return;
        }

        // The message includes a MessagePort for sending responses. Set this up as a stream.
        const respond: MessagePort = event.ports[0];
        const id = this.streamId++;
        this.streams[id] = respond;

        // Send the id as the first response. This can be used by the client to notify of an
        // "unsubscription" to this request.
        respond.postMessage({'$ngsw': true, 'id': id});

        // Handle the actual payload.
        this.handleMessage(event.data, id);
      });
    }

    events.push = (event: PushEvent) => {
      // Skip all PUSH messages in the LAME state. Technically this isn't valid per the spec,
      // but better to ignore them than throw random errors.
      if (this.state === DriverState.LAME) {
        return;
      }

      // Start up if needed (see fetch above).
      if (this.state === DriverState.STARTUP && !this.init) {
        this.startup();
      }
      if (!this.init) {
        throw new Error(`init Promise not present in state ${DriverState[this.state]}`);
      }

      Promise
        // Wait for both initialization and the JSON data sent with the push message.
        .all([
          this.init,
          event.data.json(),
        ])
        // Result of this.init is unimportant as long as it's resolved.
        .then(results => results[1])
        .then(data => {
          // Make sure the worker ended up in a good state after initialization.
          if (this.state !== DriverState.READY && this.state !== DriverState.UPDATE_PENDING) {
            // If not, drop the push message. Again, not valid per the spec, but safer than attempting
            // to handle and throwing errors.
            return;
          }

          // Handle the message with the active VersionWorker.
          this.active.push(data);
        });
    };
  }

  /**
   * Write a message to the lifecycle log.
   */
  private lifecycle(msg: string): void {
    this.lifecycleLog.push(msg);
  }

  /**
   * Attempt to reset the service worker to a pristine state, as if one had never been installed
   * before.
   *
   * This involves removing all of the caches that fall under the `ScopedCache` used by the
   * worker. 
   */
  private reset(): Promise<any> {
    return this
      .scopedCache
      // List all the keys in the cache.
      .keys()
      .then(keys => Promise
        // Wait for them all to be removed.
        .all(keys.map(key => this.scopedCache.remove(key)))
        // Log it for debugging.
        .then(() => this.lifecycle(`reset removed ${keys.length} ngsw: caches`)));
  }

  /**
   * Start up the worker.
   * 
   * this.init is set up as a Promise that resolves when the worker exits the STARTUP state.
   * In the background, it also kicks off a check for a new version of the manifest.
   *
   * In the usual update flow, this means that the worker will first transition to READY,
   * and then to UPDATE_PENDING when the updated manifest is set up and ready to be served.
   */
  private startup() {
    this.init = this.initialize();
    this.init.then(() => this.checkForUpdate());
  }

  /**
   * Possibly switch to a pending manifest if it's safe to do so.
   * 
   * Safety is determined by whether there are other application tabs open, since they may
   * be depending on the worker to serve lazily-loaded js from the previous version of the
   * app, or it may be using a shared IndexedDB across all the tabs that can't be updated
   * yet, etc.
   */
  private maybeUpdate(clientId: any): Promise<any> {
    return this
      .scope
      .clients
      .matchAll()
      .then(clients => {
        // Currently, the only criteria is that this must be a fresh tab (no current
        // clients).
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
   *
   * If a staged manifest was present and validated, it will be set as active.
   */
  private doUpdate(): Promise<any> {
    return this
      .fetchManifestFromCache('staged')
      .then(manifest => {
        // If no staged manifest exists in the cache, just transition to READY now.
        if (!manifest) {
          this.goToState(DriverState.READY);
          return null;
        }
        return this
          // Open the new manifest. This implicitly validates that the manifest was
          // downloaded correctly and is ready to serve, and can resolve with null if
          // this validation fails.
          .openManifest(manifest)
          .then(worker => this
            // Regardless of whether the new manifest validated correctly, clear the staged
            // manifest. This ensures that if the validation failed, the worker will try again.
            .clearStaged()
            // If the worker is present, set the manifest as active, ensuring it will be used
            // in the future.
            .then(() => worker ? this.setManifest(manifest, 'active') : null)
            .then(() => {
              if (worker) {
                // Set this.active to the new worker.
                const oldActive = this.active;
                this.active = worker as VersionWorkerImpl;

                // At this point, the old worker can clean up its caches as they're no longer
                // needed.
                this.cleanup(oldActive);
                this.lifecycle(`updated to manifest ${manifest._hash}`);
              }

              // Regardless of whether the manifest successfully validated, it is no longer
              // a pending update, so transition to READY.
              this.goToState(DriverState.READY);
            })
          );
      });
  }

  /**
   * Clear the currently active manifest (if any).
   */
  private clearActive(): Promise<any> {
    // Fail if the worker is in a state which expects an active manifest to be present.
    if (this.state === DriverState.READY || this.state === DriverState.UPDATE_PENDING) {
      return Promise.reject("Cannot clear the active manifest when it's being used.");
    }
    return this.scopedCache.invalidate('active', this.manifestUrl);
  }

  /**
   * Clear the currently staged manifest (if any).
   */
  private clearStaged(): Promise<any> {
    return this.scopedCache.invalidate('staged', this.manifestUrl);
  }

  /**
   * Check the network for a new version of the manifest, and stage it if possible.
   *
   * This will request a new copy of the manifest from the network and compare it with
   * both the active manifest and any staged manifest if present.
   *
   * If the manifest is newer than the active or the staged manifest, it will be loaded
   * and the setup process run for all installed plugins. If it passes that process, it
   * will be set as the staged manifest, and the worker state will be set to UPDATE_PENDING.
   * 
   * checkForUpdate() returns a boolean indicating whether a staged update is pending,
   * regardless of whether this particular call caused the update to become staged.
   */
  private checkForUpdate(): Promise<boolean> {
    // If the driver isn't in a good serving state, there is no reasonable course of action
    // if an update would be found, so don't check.
    if (this.state !== DriverState.READY && this.state !== DriverState.UPDATE_PENDING) {
      this.lifecycle(`skipping update check, in state ${DriverState[this.state]}`);
      return Promise.resolve(false);
    }

    // If the worker is in the UPDATE_PENDING state, then no need to check, there is an update.
    if (this.state === DriverState.UPDATE_PENDING) {
      return Promise.resolve(true);
    }

    return Promise
      // Fetch active and staged manifests and a fresh copy of the manifest from the network.
      // Technically, the staged manifest should be null, but it is checked here for thoroughness.
      .all([
        this.fetchManifestFromCache('active'),
        this.fetchManifestFromCache('staged'),
        this.fetchManifestFromNetwork(),
      ])
      .then((manifests: Manifest[]) => {
        const [active, staged, network] = manifests;

        // If the request for a manifest from the network was unsuccessful, there's no
        // way to tell if an update is available, so skip.
        if (!network) {
          // Even if the network request failed, there could still be a pending manifest.
          // This technically shouldn't happen since the worker should have been placed in
          // the UPDATE_PENDING state by initialize(), but this is here for safety.
          if (!!staged) {
            // If there is a staged manifest, transition to UPDATE_PENDING.
            this.goToState(DriverState.UPDATE_PENDING);
            return true;
          } else {
            return false;
          }
        }

        // If the network manifest is currently the active manifest, no update is available.
        if (!!active && active._hash === network._hash) {
          return false;
        }

        // If the network manifest is already staged, just go to UPDATE_PENDING. Theoretically
        // this shouldn't happen since initialize() should have already transitioned to
        // UPDATE_PENDING, but as above, this is here for safety.
        if (!!staged && staged._hash === network._hash) {
          this.lifecycle(`network manifest ${network._hash} is already staged`);
          this.goToState(DriverState.UPDATE_PENDING);
          return true;
        }

        // A Promise which may do extra work before the update.
        let start = Promise.resolve();
        
        // If there is a staged manifest, then before setting up the update, remove it.
        if (!!staged) {
          this.lifecycle(`staged manifest ${staged._hash} is old, removing`);
          start = this.clearStaged();
        }
        return start
          // Create a VersionWorker from the network manifest, setting up all registered plugins.
          // this.active is passed as if there is a currently active worker, the updated
          // VersionWorker will possibly update from it, saving bytes for files which have not
          // changed between manifest versions. This update process is plugin-specific.
          .then(() => this.setupManifest(network, this.active))
          // Once the new VersionWorker has been set up properly, mark the manifest as staged.
          // This sets up the worker to update to it on a future fetch event, when maybeUpdate()
          // decides to update.
          .then(() => this.setManifest(network, 'staged'))
          .then(() => {
            // Finally, transition to UPDATE_PENDING to indicate updates should be checked.
            this.goToState(DriverState.UPDATE_PENDING);
            this.lifecycle(`staged update to ${network._hash}`);
            return true;
          });
      });
  }

  /**
   * Transitions the worker out of the STARTUP state, by either serving the active
   * manifest or installing from the network if one is not present.
   *
   * Initialization can fail, which will result in the worker ending up in a LAME
   * state where it effectively disables itself until the next startup.
   *
   * This function returns a Promise which, when resolved, guarantees the worker is
   * no longer in a STARTUP state.
   */
  private initialize(): Promise<any> {
    // Fail if the worker is initialized twice.
    if (!!this.init) {
      throw new Error("double initialization!");
    }

    // Initialization is only valid in the STARTUP state.
    if (this.state !== DriverState.STARTUP) {
      return Promise.reject(new Error("driver: initialize() called when not in STARTUP state"));
    }

    return Promise
      // Fetch both active and staged manifests.
      .all([
        this.fetchManifestFromCache('active'),
        this.fetchManifestFromCache('staged'),
      ])
      .then(manifests => {
        const [active, staged] = manifests;
        if (!active) {
          // If there's no active manifest, then a network installation is required.
          this.goToState(DriverState.INSTALLING);
          // Installing from the network is asynchronous, but initialization doesn't block on
          // it. Therefore the Promise returned from doInstallFromNetwork() is ignored.
          this.doInstallFromNetwork();
          return null;
        }
        return this
          // Turn the active manifest into a VersionWorker, which will implicitly validate that
          // all files are cached correctly. If this fails, openManifest() can resolve with a
          // null worker.
          .openManifest(active)
          .then(worker => {
            if (!worker) {
              // The active manifest is somehow invalid. Nothing to do but enter a LAME state
              // and remove it, and hope the next time the worker is initialized, a fresh copy
              // will be installed from the network without issues.
              this.goToState(DriverState.LAME);
              return this.clearActive();
            }
            this.lifecycle(`manifest ${active._hash} activated`);
            this.active = worker as VersionWorkerImpl;

            // If a staged manifest exist, go to UPDATE_PENDING instead of READY.
            if (!!staged) {
              this.lifecycle(`staged manifest ${staged._hash} present at initialization`);
              this.goToState(DriverState.UPDATE_PENDING);
              return null;
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
          this.lifecycle('no network manifest found to install from');
          this.goToState(DriverState.LAME);
          return null;
        }
        return this
          .setupManifest(manifest, null)
          .then(worker => {
            if (!worker) {
              this.lifecycle('network manifest setup failed');
              this.goToState(DriverState.LAME);
              return null;
            }
            this
              .setManifest(manifest, 'active')
              .then(() => {
                this.active = worker as VersionWorkerImpl;
                this.lifecycle(`installed version ${manifest._hash} from network`);
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

  private workerFromManifest(manifest: Manifest): VersionWorkerImpl {
    const plugins: Plugin<any>[] = [];
    const worker = new VersionWorkerImpl(this, this.scope, manifest, this.adapter, new ScopedCache(this.scopedCache, `manifest:${manifest._hash}:`), this.fetcher, plugins);
    plugins.push(...this.plugins.map(factory => factory(worker)));
    return worker;

  }

  private openManifest(manifest: Manifest): Promise<VersionWorker> {
    const worker = this.workerFromManifest(manifest);
    return worker
      .validate()
      .then(valid => {
        if (!valid) {
          this.lifecycle(`cached version ${manifest._hash} not valid`);
          // Recover from the error by deleting all existing caches (effectively a reset).
          return this
            .reset()
            .then(() => null);
        }
        return worker;
      });
  }

  private setupManifest(manifest: Manifest, existing: VersionWorker = null): Promise<VersionWorker> {
    const worker = this.workerFromManifest(manifest);
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
      .then(() => this.lifecycle(`cleaned up old version ${worker.manifest._hash}`));
  }

  private status(): Promise<any> {
    return Promise.resolve({
      state: DriverState[this.state],
      lifecycleLog: this.lifecycleLog,
    });
  }

  private goToState(state: DriverState): void {
    this.lifecycle(`transition from ${DriverState[this.state]} to ${DriverState[state]}`);
    this.state = state;
    if (state === DriverState.READY && this.readyResolve !== null) {
      const resolve = this.readyResolve;
      this.readyResolve = null;
      resolve();
    }
    if (state === DriverState.UPDATE_PENDING && this.updatePendingResolve !== null) {
      this.ready = new Promise(resolve => this.readyResolve = resolve)
      const resolve = this.updatePendingResolve;
      this.updatePendingResolve = null;
      resolve();
    }
  }

  private handleMessage(message: Object, id: number): Promise<Object> {
    if (!this.active) {
      this.lifecycle(`no active worker in state ${DriverState[this.state]}`)
      return;
    }

    switch (message['cmd']) {
      case 'ping':
        this.lifecycle(`responding to ping on ${id}`)
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

  closeStream(id: number): void {
    if (!this.streams.hasOwnProperty(id)) {
      return;
    }
    this.streams[id].postMessage(null);
    delete this.streams[id];
  }
}
