import {SwManifest} from './manifest';
import {WorkerAdapter} from './context'
import {CacheManager} from './cache';
import {Observable} from 'rxjs/Observable';

export interface CustomOperator<T> {
  (obs: Observable<T>): Observable<T>;
}

export interface FetchInstruction {
  execute(): Observable<Response>;
  describe(): string;
}

export interface Operation {
  execute(): Observable<any>;
}

export interface ServiceWorkerPluginApi {
  readonly cache: CacheManager;
  readonly adapter: WorkerAdapter;
  fetchFromServer(req: Request): Observable<Response>;
  fetchFromWorker(req: Request): Observable<Response>;
}

export interface Plugin {
  install?(manifest: SwManifest): CustomOperator<Operation>;
  activate?(manifest: SwManifest): CustomOperator<Operation>;
  fetch?(req: Request, manifest: SwManifest): CustomOperator<FetchInstruction>;
}

export interface PluginConstructor {
  new(api: ServiceWorkerPluginApi): Plugin;
}
