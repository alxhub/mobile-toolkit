import {Plugin, PluginConstructor, ServiceWorkerPluginApi, CustomOperator, Operation, FetchInstruction} from './plugin';
import {CacheManager} from './cache';
import {WorkerAdapter, Events} from './context';
import {Fetch} from './fetch';
import {SwManifest, ManifestDelta} from './manifest';
import {parseManifest, diffManifests} from './manifest-parser';
import {Observable} from 'rxjs/Observable';
import {doAsync} from './operator';
import {log, Verbosity} from './logging';

export const MANIFEST_URL = '/ngsw-manifest.json';
export const CACHE_ACTIVE = 'ngsw.active';
export const CACHE_INSTALLING = 'ngsw.installing';

export enum ManifestSource {
  NETWORK,
  INSTALLING,
  ACTIVE
}

export class FetchFromNetworkInstruction implements FetchInstruction {

  constructor(private api: ServiceWorkerPluginApi, private request: Request) {}

  execute(): Observable<Response> {
    return this.api.fetchFromServer(this.request);
  }

  describe(): string {
    return `fetchFromNetwork(${this.request.url})`;
  }
}

export class ServiceWorkerDriver implements ServiceWorkerPluginApi {

  private plugins: Plugin[] = [];
  private manifestReq: Request;
  private _manifest: SwManifest;

  get init(): Observable<SwManifest> {
    if (this._manifest != null) {
      return Observable.of(this._manifest);
    }
    return this.normalInit();
  }

  constructor(
    public adapter: WorkerAdapter,
    public cache: CacheManager,
    private fetch: Fetch,
    private events: Events
  ) {
    this.manifestReq = adapter.newRequest(MANIFEST_URL);

    this
      .events
      .install
      .subscribe(ev => {
        let init = this
          .checkDiffs(ManifestSource.NETWORK)
          .let(doAsync((delta: ManifestDelta) => this
            .collectOperations(plugin => plugin.install(delta))
            .concatMap(op => op.execute())
            .ignoreElements()
          ))
          .let(doAsync((delta: ManifestDelta) => cache.store(CACHE_INSTALLING, MANIFEST_URL, adapter.newResponse(delta.currentStr))))
          .map((delta: ManifestDelta) => delta.current)
          .do(manifest => this._manifest = manifest)
          .do(() => log(Verbosity.INFO, 'ngsw: Event - install complete'))
      ev.waitUntil(init.toPromise());
      });

    this
      .events
      .activate
      .subscribe(ev => {
        let init = this
          .checkDiffs(ManifestSource.INSTALLING)
          .let(doAsync((delta: ManifestDelta) => this
            .collectOperations(plugin => plugin.activate(delta))
            .concatMap(op => op.execute())
            .ignoreElements()
          ))
          .let(doAsync((delta: ManifestDelta) => cache.store(CACHE_ACTIVE, MANIFEST_URL, adapter.newResponse(delta.currentStr))))
          .map((delta: ManifestDelta) => delta.current)
          .do(manifest => this._manifest = manifest);
        ev.waitUntil(init.toPromise());
      });
    
    this
      .events
      .fetch
      .subscribe(ev => {
        ev.respondWith(this
          .fetchFromWorker(ev.request)
          .toPromise())
      });
  }

  checkDiffs(source: ManifestSource): Observable<ManifestDelta> {
    return Observable
      .combineLatest(this.loadFreshManifest(source), this.loadCachedManifest())
      .map((contents: string[]) => diffManifests(contents[0], contents[1]));
  }

  loadCachedManifest(): Observable<string> {
    return this
      .cache
      .load(CACHE_ACTIVE, MANIFEST_URL)
      .let(extractBody);
  }

  loadFreshManifest(source: ManifestSource): Observable<string> {
    let respSource: Observable<Response>;
    switch (source) {
      case ManifestSource.NETWORK:
        respSource = this
          .fetch
          .refresh(this.manifestReq);
        break;
      case ManifestSource.INSTALLING:
        respSource = this
          .cache
          .load(CACHE_INSTALLING, MANIFEST_URL);
        break;
      case ManifestSource.ACTIVE:
        respSource = this
          .cache
          .load(CACHE_ACTIVE, MANIFEST_URL);
        break;
      default:
        throw `Unknown diff source: ${source}`;
    }
    return respSource
      .do(resp => {
        if (resp && !resp.ok) {
          throw 'Failed to load fresh manifest.';
        }
      })
      .let(extractBody)
  }

  normalInit(): Observable<SwManifest> {
    return this
      .loadFreshManifest(ManifestSource.ACTIVE)
      .do(data => {
        if (!data) {
          throw 'Unable to load manifest!';
        }
      })
      .map(data => parseManifest(data))
      .do(manifest => this._manifest = manifest);
  }
  
  load(PluginCtor: PluginConstructor) {
    this.plugins.push(new PluginCtor(this));
  }

  fetchFromServer(req: Request, refresh: boolean = false): Observable<Response> {
    return refresh ? this.fetch.refresh(req) : this.fetch.request(req);
  }

  fetchFromWorker(request: Request): Observable<Response> {
    return this
      .init
      .first()
      .mergeMap(manifest => this
        .plugins
        .filter(plugin => !!plugin.fetch)
        .reduce((obs, plugin) =>
          obs.let(plugin.fetch(request, manifest)), Observable.empty<FetchInstruction>())
      )
      .concat(Observable.of(new FetchFromNetworkInstruction(this, request)))
      .concatMap(instruction => instruction.execute())
      .filter(response => !!response)
      .first();
  }

  collectOperations(fn: any): Observable<Operation> {
    return this.plugins.reduce((obs, plugin) => {
      let operator: CustomOperator<Operation> = fn(plugin);
      if (operator !== null) {
        return obs.let(operator);
      }
      return obs;
    }, Observable.empty<Operation>());
  }
}

export function extractBody(obs: Observable<Response>): Observable<string> {
  return obs.flatMap(resp =>
    resp != undefined ?
      resp.text() :
      Observable.of<string>(undefined));
}