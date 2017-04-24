export interface NgSwAdapter {
  newRequest(req: string | Request, init?: Object): Request;
  newResponse(body: string | Blob, init?: Object): Response;
  readonly scope: string;
}

export interface Clock {
  dateNow(): number;
  setTimeout(fn: Function, delay: number);
}

export class BrowserClock implements Clock {
  dateNow(): number {
    return Date.now();
  }

  setTimeout(fn: Function, delay: number) {
    return setTimeout(fn, delay);
  }
}
