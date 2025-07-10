import { expect } from 'chai';
import request from './api_helper';

describe('Live Check', function () {
  it('should return 200', async function () {
    console.log('checking:', global.TEST_URL);
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
    console.log('res:', res.status);
    console.log('body:', res.body.body);
    console.log('instance_list:', res.body.body.instance_list);
    // ignore status because we dont have a test asg
    //expect(res.status).to.equal(200);
    expect(res.body.body.LATEST).to.equal('test');
    expect(res.body.body.InstanceId).to.have.lengthOf(
      'i-0af730e40ca681ca2'.length
    );
  });
});
