
import {Operation, Plugin, VersionWorker, FetchInstruction} from './api';
import {fetchFromNetworkInstruction} from './common';
import {ScopedCache} from './cache';
import {NgSwAdapter, NgSwFetch} from './facade';
import {Manifest} from './manifest';

import {Observable} from 'rxjs/Observable';
import 'rxjs/add/observable/from';
import 'rxjs/add/operator/concatMap';
import 'rxjs/add/operator/filter';
import 'rxjs/add/operator/first';

export class VersionWorkerImpl implements VersionWorker {

  constructor(
      public scope: ServiceWorkerGlobalScope,
      public manifest: Manifest,
      public adapter: NgSwAdapter,
      public cache: ScopedCache,
      private fetcher: NgSwFetch,
      private plugins: Plugin<any>[]) {}

  refresh(req: Request): Promise<Response> {
    return this.fetcher.refresh(req);
  }

  fetch(req: Request): Promise<Response> {
    const instructions: FetchInstruction[] = [
      fetchFromNetworkInstruction(this, req, false),
    ];
    this
      .plugins
      .filter(plugin => !!plugin.fetch)
      .forEach(plugin => plugin.fetch(req, instructions));
    return instructions.reduce<Promise<Response>>(
      (prev, curr) => prev.then(resp => resp ? resp : curr()),
      Promise.resolve(null),
    );
  }


  setup(previous: VersionWorkerImpl): Promise<any> {
    let operations: Operation[] = [];
    for (let i = 0; i < this.plugins.length; i++) {
      const plugin: Plugin<any> = this.plugins[i];
      if (plugin.update && previous) {
        plugin.update(operations, previous.plugins[i]);
      } else {
        plugin.setup(operations);
      }
    }
    return operations.reduce<Promise<any>>(
      (prev, curr) => prev.then(() => curr()),
      Promise.resolve(null),
    );
  }

  cleanup(): Operation[] {
    return this.plugins.reduce((ops, plugin) => {
      if (plugin.cleanup) {
        plugin.cleanup(ops);
      }
      return ops;
    }, []);
  }

  message(message: any): Operation[] {
    return this.plugins.reduce((ops, plugin) => {
      if (plugin.message) {
        plugin.message(message, ops);
      }
      return ops;
    }, []);
  }

  push(data: any): void {
    this
      .plugins
      .filter(plugin => !!plugin.push)
      .forEach(plugin => plugin.push(data));
  }

  showNotification(title: string, options?: Object): void {
    this.scope.registration.showNotification(title, options);
  }
}
