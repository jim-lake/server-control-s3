import supertest from 'supertest';

const request = {} as ReturnType<typeof supertest>;

export default request;

export function setUrl(url: string) {
  const r = supertest(url);
  Object.assign(request, r);
}
