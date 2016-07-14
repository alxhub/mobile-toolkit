import {Plugin, PluginConstructor, ServiceWorkerPluginApi, CustomOperator, Operation, FetchInstruction} from './plugin';
import {CacheManager} from './cache';
import {WorkerAdapter, Events} from './context';
import {SwManifest} from './manifest';
import {Observable} from 'rxjs/Observable';

function applyOperator<T> () {

}

export class ServiceWorkerDriver implements ServiceWorkerPluginApi {

  plugins: Plugin[] = [];

  constructor(
    public adapter: WorkerAdapter,
    public cache: CacheManager,
    private events: Events
  ) {
    this
      .events
      .install
      .subscribe(ev => {
        // get manifest
        let manifest: Observable<SwManifest> = null;
        ev.waitUntil(manifest
          .concatMap(manifest => this.collectOperations(plugin => plugin.install(manifest)))
          .forEach(op => op.execute()));

      });
  }
  
  load(PluginCtor: PluginConstructor) {
    this.plugins.push(new PluginCtor(this));
  }

  fetchFromServer(req: Request): Observable<Response> {
    return;
  }

  fetchFromWorker(req: Request): Observable<Response> {
    return;
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
