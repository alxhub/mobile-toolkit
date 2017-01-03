import {Observable} from 'rxjs/Observable';
import {NgSwAdapter} from './adapter';

export class NgSwFetch {

  constructor(private scope: ServiceWorkerGlobalScope, private adapter: NgSwAdapter) {}

  request(req: Request): Promise<Response> {
    return this.scope.fetch(req)
      .catch(err => this.adapter.newResponse('', {status: 503}));
  }

  refresh(req: string | Request): Promise<Response> {
    let request: Request;
    if (typeof req == 'string') {
      request = this.adapter.newRequest(this._cacheBust(<string>req));
    } else {
      request = this.adapter.newRequest(this._cacheBust((<Request>req).url), <Request>req);
    }
    return this.request(request);
  }

  private _cacheBust(url: string): string {
    var bust = Math.random();
    if (url.indexOf('?') == -1) {
      return `${url}?ngsw-cache-bust=${bust}`;
    }
    return `${url}&ngsw-cache-bust=${bust}`;
  }
}
