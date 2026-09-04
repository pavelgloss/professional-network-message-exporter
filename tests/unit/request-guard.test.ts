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
  it('does not allow unsupported schemes', () => {
    expect(requestPolicy('GET', 'file:///secret').allow).toBe(false);
  });
});
