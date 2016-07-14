import {SwManifest} from '../../worker/manifest';
import {cacheFor} from '../../worker/setup';
import {Plugin, CustomOperator, FetchInstruction, ServiceWorkerPluginApi} from '../../worker/plugin';
import {Observable} from 'rxjs/Observable';
import {IndexInstruction, FetchFromCacheInstruction, FallbackInstruction} from './instruction';

export class StaticContentPlugin implements Plugin {

  constructor(private api: ServiceWorkerPluginApi) {}

  fetch(req: Request, manifest: SwManifest): CustomOperator<FetchInstruction> {
    return (obs: Observable<FetchInstruction>) => obs
      .concat(this.handleFetch(manifest, req));
  }

  handleFetch(manifest: SwManifest, req: Request): Observable<FetchInstruction> {
    let groups = Object
      .keys(manifest.group)
      .map(key => manifest.group[key]);
    return Observable.concat(
      Observable.of(new IndexInstruction(this.api, req, manifest)),
      Observable.of(new FallbackInstruction(this.api, req, manifest)),
      groups.map(group => new FetchFromCacheInstruction(this.api, cacheFor(group), req))
    );
  }
}
