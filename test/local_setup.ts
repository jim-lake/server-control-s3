import { fork } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import supertest from 'supertest';
import util from 'node:util';
import { fileURLToPath } from 'node:url';
import { setUrl } from './api_helper';

import { createLocal, closeLocal } from './create_local';

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
  console.log('befoerAll: Starting test server...');
  const { url, server } = await createLocal();
  (global as any).TEST_URL = url;
  setUrl(url);
}
async function afterAll() {
  console.log('afterAll: Stopping test server...');
  await closeLocal();
}
