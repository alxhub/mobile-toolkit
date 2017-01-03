import {Observable} from 'rxjs/Observable';

import {NgSwAdapter, NgSwCache} from './facade';
import {Manifest} from './manifest';

export interface FetchInstruction {
  (): Promise<Response>;
  desc?: Object;
}

export interface Operation {
  (): Promise<any>;
  desc?: Object;
}

export interface VersionWorker {
  readonly manifest: Manifest;
  readonly cache: NgSwCache;
  readonly adapter: NgSwAdapter;

  refresh(req: Request): Promise<Response>;
  fetch(req: Request): Promise<Response>;
  showNotification(title: string, options?: Object): void;
}

export interface Plugin<T extends Plugin<T>> {
  setup(operations: Operation[]): void;
  update?(operations: Operation[], previous: T): void;
  fetch?(req: Request, instructions: FetchInstruction[]): void;
  cleanup?(operations: Operation[]): void;
  message?(message: any, operations: Operation[]): void;
  push?(data: any): void;
}

export interface PluginFactory<T extends Plugin<T>> {
  (worker: VersionWorker): Plugin<T>;
}
