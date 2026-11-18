import type { IncomingMessage, ServerResponse } from 'node:http';

import type { RequestIdentity } from '../ports.ts';

export interface HttpContext {
  identity: RequestIdentity | null;
  url: URL;
}

export type RouteHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  ctx: HttpContext,
) => Promise<boolean> | boolean;

/** Prefix-matching router. A handler returns true when it wrote the response. */
export class Router {
  private readonly routes: Array<{ prefix: string; handler: RouteHandler }> = [];

  use(prefix: string, handler: RouteHandler): this {
    this.routes.push({ prefix, handler });
    return this;
  }

  async dispatch(req: IncomingMessage, res: ServerResponse, ctx: HttpContext): Promise<boolean> {
    for (const route of this.routes) {
      if (ctx.url.pathname === route.prefix || ctx.url.pathname.startsWith(`${route.prefix}/`)) {
        if (await route.handler(req, res, ctx)) return true;
      }
    }
    return false;
  }
}
