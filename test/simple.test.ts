import { expect } from 'chai';
import request from './api_helper';

import { waitForServer } from './create_local';

const HASH_LEN = '22c9b769e02eb000d4a1356136e190678e9ce524'.length;
const INSTANCE_ID_LEN = 'i-0af730e40ca681ca2'.length;

const HASH_LIST = [
  '62a94d3a980ac2bf2e2dabe287b4d2da86baf075',
  '0f5670b45382ecf9535b61c3d68c82178e4033cf',
];

describe('Live Check', function () {
  it('should return 200', async function () {
    console.log('checking:', (global as any).TEST_URL);
    const res = await request.get('/');
    expect(res.status).to.equal(200);
  });
});

describe('Server Version', function () {
  this.timeout(30 * 1000);
  it('should return 403', async function () {
    const res = await request.get('/server_data');
    expect(res.status).to.equal(403);
  });

  it('should return 200', async function () {
    const res = await request
      .get('/server_data')
      .set('x-sc-secret', 'my-super-secret-key');
    console.log('res:', res.status, res.body);
    expect(res.status).to.equal(200);
  });
});

describe('Group Data', function () {
  this.timeout(30 * 1000);
  it('should return 403', async function () {
    const res = await request.get('/group_data');
    expect(res.status).to.equal(403);
  });

  it('should have data', async function () {
    const res = await request
      .get('/group_data')
      .set('x-sc-secret', 'my-super-secret-key');
    expect(res.status).to.equal(200);
    expect(res.body.LATEST).to.have.lengthOf(HASH_LEN);
    expect(res.body.InstanceId).to.have.lengthOf(INSTANCE_ID_LEN);
    expect(res.body.instance_list).to.have.lengthOf.at.least(1);
    console.log('instance_list:', res.body.instance_list);
    console.log('LATEST:', res.body.LATEST);
  });
});

describe('Secret Key Auth', function () {
  this.timeout(30 * 1000);
  it('should return 200 with secret in body', async function () {
    const res = await request
      .post('/server_data')
      .send({ secret: 'my-super-secret-key' });
    expect(res.status).to.equal(200);
  });

  it('should return 200 with secret in cookie', async function () {
    const res = await request
      .get('/server_data')
      .set('Cookie', 'secret=my-super-secret-key');
    expect(res.status).to.equal(200);
  });
});

describe('Update Group', function () {
  this.timeout(2 * 60 * 1000);

  let existing_hash = '';
  let new_hash = '';
  it('should return 403', async function () {
    const res = await request.get('/update_group');
    expect(res.status).to.equal(403);
  });

  it('get current hash', async function () {
    const res = await request
      .get('/group_data')
      .set('x-sc-secret', 'my-super-secret-key');
    console.log('res:', res.status);
    console.log('instance_list:', res.body.instance_list);
    expect(res.status).to.equal(200);
    expect(res.body.LATEST).to.have.lengthOf(HASH_LEN);
    expect(res.body.instance_list).to.have.lengthOf.at.least(1);
    existing_hash = res.body.instance_list[0].git_commit_hash;
    console.log('existing_hash:', existing_hash);
    expect(existing_hash.length).to.equal(HASH_LEN);
    new_hash = existing_hash == HASH_LIST[0] ? HASH_LIST[1] : HASH_LIST[0];
    console.log('new_hash:', new_hash);
  });

  it('update to new hash', async function () {
    const res = await request
      .get(`/update_group?hash=${new_hash}`)
      .set('x-sc-secret', 'my-super-secret-key');
    expect(res.status).to.equal(200);
  });

  it('wait for local restart', async function () {
    const delay = (ms: number) => new Promise((res) => setTimeout(res, ms));
    console.log('wait for 500ms');
    await delay(500);
    console.log('done wait for 500ms, waiting for server');
    await waitForServer();
    console.log('done wait for server');
  });

  it('should have new hash', async function () {
    const res = await request
      .get('/group_data')
      .set('x-sc-secret', 'my-super-secret-key');
    console.log('res:', res.status);
    console.log('instance_list:', res.body.instance_list);
    expect(res.status).to.equal(200);
    expect(res.status).to.equal(200);
    expect(res.body.LATEST).to.have.lengthOf(HASH_LEN);
    expect(res.body.instance_list).to.have.lengthOf.at.least(1);
    const found_hash = res.body.instance_list[0].git_commit_hash;
    expect(found_hash).to.equal(new_hash);
  });
});
