import { fork } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import supertest from 'supertest';
import util from 'node:util';
import { fileURLToPath } from 'node:url';
import { setUrl } from './api_helper';

import { createLocal } from './create_local';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PORT = process.env.PORT || '3001';
const TIMEOUT = 60 * 1000;

let g_server: ReturnType<typeof fork>;

export const mochaHooks = {
  beforeAll,
  afterAll,
};

async function beforeAll(this: Mocha.Context) {
  this.timeout(30000);
  const { url, server } = await createLocal();
  global.TEST_URL = url;
  g_server = server;

  setUrl(url);
}
async function afterAll() {
  if (g_server) {
    console.log('Stopping test server...');

    g_server.kill('SIGTERM');

    await new Promise((resolve) => {
      const timeout = setTimeout(() => {
        g_server.kill('SIGKILL');
        resolve(true);
      }, 5000);

      g_server.on('exit', () => {
        clearTimeout(timeout);
        resolve(true);
      });
    });
    console.log('Test server stopped');
  }
}
