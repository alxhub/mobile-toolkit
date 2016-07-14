import {ServiceWorkerPluginApi, FetchInstruction} from '../../worker/plugin';
import {SwManifest, Route} from '../../worker/manifest';
import {Observable} from 'rxjs/Observable';

export class IndexInstruction implements FetchInstruction {

  constructor(
    private api: ServiceWorkerPluginApi,
    private request: Request,
    private manifest: SwManifest) {}

  execute(): Observable<Response> {
    if (this.request.url !== '/' || !this.manifest.routing.index) {
      return Observable.empty<Response>();
    }

    return this.api.fetchFromWorker(this.api.adapter.newRequest(this.request, {url: this.manifest.routing.index}));
  }

  describe(): string {
    return `index(${this.request.url}, ${this.manifest.routing.index})`;
  }
}

export class FetchFromCacheInstruction implements FetchInstruction {
  constructor(
    private api: ServiceWorkerPluginApi,
    private cache: string,
    private request: Request) {}

  execute(): Observable<Response> {
    return this.api.cache.load(this.cache, this.request);
  }

  describe(): string {
    return `fetchFromCache(${this.cache}, ${this.request.url})`;
  }
}

export class FallbackInstruction implements FetchInstruction {
  constructor(
    private api: ServiceWorkerPluginApi,
    private request: Request,
    private manifest: SwManifest) {}

  execute(): Observable<Response> {
    return Observable
      // Look at all the fallback URLs in this group
      .from(Object.keys(this.manifest.routing.route))
      // Select the ones that match this request
      .filter((url: string) => {
        let route: Route = this.manifest.routing.route[url];
        if (route.prefix && this.request.url.indexOf(url) === 0) {
          return true;
        }
        return this.request.url === url;
      })
      // Grab the entry for it
      .map((url: string) => this.manifest.routing.route[url] as Route)
      // Craft a Request for the fallback destination
      .map(entry => this.api.adapter.newRequest(this.request, {url: this.manifest.routing.index}))
      // Jump back into processing
      .concatMap(req => this.api.fetchFromWorker(req));
  }

  describe(): string {
    return `fallback(${this.request.url})`;
  }
}
