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

let g_isRunning = false;
let g_server: ReturnType<typeof fork> | null = null;
let g_url: string;

export async function waitForServer() {
  const request = supertest(g_url);
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
  g_isRunning = true;
  g_url = `http://localhost:${PORT}`;
  const server = _start();
  await new Promise(async (resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error('Server startup timeout'));
    }, 25000);

    try {
      await waitForServer();
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

  console.log('createLocal: Test server ready at:', g_url);
  g_server = server;
  return { url: g_url, server };
}
export async function closeLocal() {
  g_isRunning = false;
  if (g_server) {
    g_server.kill('SIGTERM');

    await new Promise((resolve) => {
      const timeout = setTimeout(() => {
        g_server?.kill('SIGKILL');
        resolve(true);
      }, 5000);

      g_server?.on('exit', () => {
        clearTimeout(timeout);
        resolve(true);
      });
    });
    console.log('Test server stopped');
  }
}

function _start() {
  console.log('_start: starting');
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
  server.on('close', _onClose);
  return server;
}
function _onClose(code: number, signal: string) {
  console.log('_onClose:', code, signal);
  if (g_isRunning) {
    console.log('_onClose: restarting');
    g_server = _start();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  console.log('Only runs if executed directly');
  createLocal();
}
