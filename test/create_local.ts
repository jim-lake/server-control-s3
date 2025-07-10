import { fork } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import supertest from 'supertest';
import util from 'node:util';
import { fileURLToPath } from 'node:url';
import { setUrl } from './api_helper';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PORT = process.env.PORT || '3000';
const TIMEOUT = 60 * 1000;

async function _waitForServer(url: string) {
  const request = supertest(url);
  const start = Date.now();
  const delay = (ms: number) => new Promise((res) => setTimeout(res, ms));
  while (true) {
    try {
      const res = await request.get('/');
      if (res.status >= 200 && res.status < 500) {
        console.log('waitForServer: success:', res.status);
        return;
      }
    } catch (err: any) {
      console.log('waitForServer: err:', err?.code ?? err?.message);
    }

    if (Date.now() - start > TIMEOUT) {
      console.log('waitForServer: didnt start');
      throw new Error('Server did not start in time');
    }

    await delay(250);
  }
}
export async function createLocal() {
  const url = `http://localhost:${PORT}`;

  console.log('Starting test server in separate process...');

  const cwd = path.join(__dirname, '../example');
  const server = fork(path.join(__dirname, '../example/server.js'), [], {
    cwd,
    env: {
      ...process.env,
      NODE_OPTIONS: '',
      PWD: cwd,
      NODE_ENV: 'test',
      PORT,
    },
    silent: false,
  });

  await new Promise(async (resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error('Server startup timeout'));
    }, 25000);

    try {
      await _waitForServer(url);
      clearTimeout(timeout);
      resolve(true);
    } catch (error) {
      clearTimeout(timeout);
      reject(error);
    }

    server.on('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });

  console.log(`Test server ready at ${url}`);
  return { url, server };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  console.log('Only runs if executed directly');
  createLocal();
}
