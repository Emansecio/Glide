import { promises as fs } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';

const fixtureRoot = path.resolve(process.cwd(), 'tests', 'e2e', 'fixtures');
const mimeTypes: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};

export type FixtureServer = {
  baseUrl: string;
  close(): Promise<void>;
};

export async function startFixtureServer(): Promise<FixtureServer> {
  const server = createServer(async (request, response) => {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.writeHead(405, { Allow: 'GET, HEAD' });
      response.end();
      return;
    }

    let pathname: string;
    try {
      pathname = decodeURIComponent(new URL(request.url || '/', 'http://127.0.0.1').pathname);
    } catch {
      response.writeHead(400);
      response.end('Bad request');
      return;
    }

    const filePath = path.resolve(fixtureRoot, `.${pathname}`);
    if (filePath !== fixtureRoot && !filePath.startsWith(`${fixtureRoot}${path.sep}`)) {
      response.writeHead(403);
      response.end('Forbidden');
      return;
    }

    try {
      const stat = await fs.stat(filePath);
      if (!stat.isFile()) {
        response.writeHead(404);
        response.end('Not found');
        return;
      }
      const body = await fs.readFile(filePath);
      response.writeHead(200, {
        'Cache-Control': 'no-store',
        'Content-Length': body.byteLength,
        'Content-Type': mimeTypes[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      });
      response.end(request.method === 'HEAD' ? undefined : body);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      response.writeHead(code === 'ENOENT' || code === 'ENOTDIR' ? 404 : 500);
      response.end(code === 'ENOENT' || code === 'ENOTDIR' ? 'Not found' : 'Server error');
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });

  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}
