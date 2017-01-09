import {
  rewriteUrlInstruction,
  FetchInstruction,
  Operation,
  Plugin,
  PluginFactory,
  VersionWorker
} from '@angular/service-worker/worker';

interface RouteMap {
  [url: string]: RouteConfig;
}

interface RouteConfig {
  prefix?: boolean;
}

interface RouteRedirectionManifest {
  index: string;
  routes?: RouteMap;
}

export function RouteRedirection(): PluginFactory<RouteRedirectionImpl> {
  return (worker: VersionWorker) => new RouteRedirectionImpl(worker);
}

export class RouteRedirectionImpl implements Plugin<RouteRedirectionImpl> {
  constructor(public worker: VersionWorker) {}

  private get routeManifest(): RouteRedirectionManifest {
    return this.worker.manifest['routing'] as RouteRedirectionManifest;
  }

  setup(operations: Operation[]): void {
    // No setup needed.
  }

  fetch(req: Request, ops: FetchInstruction[], carryOn: Operation[]): void {
    const manifest = this.routeManifest;
    if (!manifest || !manifest.routes) {
      return;
    }
    let [base, path] = parseUrl(req.url);
    if (path === '/') {
      // TODO(alxhub): configurable base url
      ops.unshift(rewriteUrlInstruction(this.worker, req, base + manifest.index));
    }
    const matchesRoutingTable = Object.keys(manifest.routes).some(route => {
      const config = manifest.routes[route];
      return config.prefix
        ? path.indexOf(route) === 0
        : path === route;
    });
    if (matchesRoutingTable) {
      ops.unshift(rewriteUrlInstruction(this.worker, req, base + manifest.index));
    }
  }
}

function parseUrl(full: string) {
  let isHttp = full.toLowerCase().startsWith('http://');
  let isHttps = full.toLowerCase().startsWith('https://');
  if (!isHttp && !isHttps) {
    // Relative url.
    return ['', full];
  }

  let protocol = 'http://';
  let protocolSuffix = full.substr('http://'.length);
  if (isHttps) {
    protocol = 'https://';
    protocolSuffix = full.substr('https://'.length);
  }
  let rootSlash = protocolSuffix.indexOf('/');
  if (rootSlash === -1) {
    return [full, '/'];
  }
  return [full.substr(0, protocol.length + rootSlash), protocolSuffix.substr(rootSlash)];
}