import { describe, expect, it } from 'vitest';
import { requestPolicy } from '../../src/browser/request-guard.js';

describe('request guard policy', () => {
  it.each(['POST', 'PUT', 'PATCH', 'DELETE'])('blocks %s even for messaging APIs', (method) => {
    expect(requestPolicy(method, 'https://www.linkedin.com/voyager/api/messaging/conversations').allow).toBe(false);
  });
  it('allows passive GETs but blocks known mutation URLs', () => {
    expect(requestPolicy('GET', 'https://www.linkedin.com/voyager/api/messaging/conversations?count=20').allow).toBe(true);
    expect(requestPolicy('GET', 'https://www.linkedin.com/logout').allow).toBe(false);
    expect(requestPolicy('GET', 'https://www.linkedin.com/voyager/api/graphql?queryId=sendMessageMutation').allow).toBe(false);
  });
  it.each([
    'https://www.linkedin.com/messaging/%73%65%6e%64Message',
    'https://www.linkedin.com/messaging/%2573%2565%256e%2564Message',
    'https://www.linkedin.com/voyager/api/graphql?queryId=%6d%75tation',
    'https://www.linkedin.com/voyager/api/graphql?queryId=%256d%2575%2574%2561%2574%2569%256f%256e',
    'https://www.linkedin.com/voyager/api/messaging/messages?operation=%6d%61%72%6b%52%65%61%64',
    'https://www.linkedin.com/voyager/api/graphql?queryId=%EF%BD%8Dutation',
    'https://www.linkedin.com/voyager/api/graphql?queryId=%ZZ',
    'https://www.linkedin.com/voyager/api/graphql?safe=%2525252525252525256dutation',
    'https://www.linkedin.com/voyager/api/graphql?safe=%26operation%3DmarkRead',
    'https://www.linkedin.com/voyager/api/messaging/%00/messages',
    'https://www.linkedin.com/voyager/api/graphql?queryId=muta%C2%85tion',
    'https://www.linkedin.com/voyager/api/graphql?queryId=muta%25C2%2585tion',
    'https://www.linkedin.com/voyager/api/graphql?queryId=muta%E2%80%8Btion',
    'https://www.linkedin.com/voyager/api/graphql?queryId=muta%C2%ADtion',
    'https://www.linkedin.com/voyager/api/graphql?queryId=muta%E2%80%AEtion',
    'https://www.linkedin.com/voyager/api/graphql?que%E2%80%8BryId=mutation',
  ])('blocks encoded, normalized, or malformed mutation URL %s', (url) => {
    expect(requestPolicy('GET', url).allow).toBe(false);
  });
  it('does not allow unsupported schemes', () => {
    expect(requestPolicy('GET', 'file:///secret').allow).toBe(false);
    expect(requestPolicy('POST', 'data:text/plain,local').allow).toBe(false);
  });
  it('redacts opaque origins in blocked policy decisions', () => {
    const canary = 'pavelprivateconversation';
    expect(requestPolicy('POST', `https://${canary}.example/random/${canary}`)).toMatchObject({ allow: false, origin: '<redacted-origin>' });
  });
});
